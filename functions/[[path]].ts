/**
 * Cloudflare Pages Function — versioned asset serving from R2.
 *
 * URL scheme:
 *   /                → 302 → /latest/
 *   /latest/         → 302 → /v{latest_version}/
 *   /v0.1.0/*        → serve from R2 prefix "v0.1.0/"
 *   /_astro/*        → cookie-based version resolution (absolute paths from HTML)
 *   /favicon.svg     → same cookie-based fallback
 *
 * A cookie `_cupola_v` tracks which version the user is browsing so that
 * absolute asset paths emitted by Astro (e.g. /_astro/main.abc.js) resolve
 * to the correct version's files in R2.
 */

interface Env {
  ASSETS_BUCKET: R2Bucket;
}

/** Matches /v1.2.3/ or /v1.2.3/some/path */
const VERSION_RE = /^\/v([\d]+\.[\d]+\.[\d]+)(\/.*)?$/;

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  mjs: "application/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  ico: "image/x-icon",
  wasm: "application/wasm",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  map: "application/json",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml",
};

function contentType(key: string): string {
  const ext = key.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

function versionCookie(version: string): string {
  return `_cupola_v=${version}; Path=/; SameSite=Lax; Max-Age=86400`;
}

function readVersionCookie(request: Request): string | null {
  const cookie = request.headers.get("Cookie") ?? "";
  const match = cookie.match(/_cupola_v=([^;]+)/);
  return match ? match[1] : null;
}

/** Try to fetch a key from R2, falling back to key + "index.html" for directories. */
async function fetchFromR2(bucket: R2Bucket, key: string): Promise<R2ObjectBody | null> {
  let obj = await bucket.get(key);
  if (obj) return obj;

  // Try as directory — append index.html
  if (!key.endsWith("/")) {
    obj = await bucket.get(key + "/index.html");
  } else {
    obj = await bucket.get(key + "index.html");
  }
  return obj;
}

/**
 * Fetch from R2 with fallback: try versioned key first, then root-level key.
 * Handles shared assets like WASM files that are stored at root level.
 */
async function fetchWithFallback(
  bucket: R2Bucket,
  versionedKey: string,
  rootKey: string,
): Promise<R2ObjectBody | null> {
  const obj = await fetchFromR2(bucket, versionedKey);
  if (obj) return obj;
  // Fall back to root-level key (shared large assets like WASM)
  return fetchFromR2(bucket, rootKey);
}

/** Cache immutable versioned assets aggressively, HTML briefly. */
function cacheControl(key: string, isVersioned: boolean): string {
  if (key.endsWith(".html") || key.endsWith("/index.html")) {
    return "public, max-age=60, s-maxage=300";
  }
  // _astro/ files are content-addressed (hashed) — immutable
  if (key.includes("_astro/") || isVersioned) {
    return "public, max-age=31536000, immutable";
  }
  return "public, max-age=3600";
}

function respond(obj: R2ObjectBody, key: string, extraHeaders?: Record<string, string>): Response {
  const headers = new Headers({
    "Content-Type": contentType(key),
    "Cache-Control": cacheControl(key, false),
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "cross-origin",
  });
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
  }
  return new Response(obj.body, { headers });
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);
  let path = url.pathname;

  // ---- Root → /latest/ ----
  if (path === "/" || path === "") {
    return Response.redirect(`${url.origin}/latest/`, 302);
  }

  // ---- /npm/* → proxy to cdn.jsdelivr.net (ESM CDN transitive deps) ----
  if (path.startsWith("/npm/")) {
    const cdnUrl = `https://cdn.jsdelivr.net${path}`;
    const cdnResp = await fetch(cdnUrl, { headers: { "User-Agent": "cupola" } });
    const headers = new Headers(cdnResp.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    return new Response(cdnResp.body, { status: cdnResp.status, headers });
  }

  // ---- /latest/ → /v{latest_version}/ ----
  if (path === "/latest" || path === "/latest/" || path.startsWith("/latest/")) {
    const latestObj = await context.env.ASSETS_BUCKET.get("_latest");
    if (!latestObj) {
      return new Response("No version deployed yet.", { status: 503 });
    }
    const latestVersion = (await latestObj.text()).trim();
    // Rewrite /latest/foo → /v{version}/foo
    const remainder = path.replace(/^\/latest\/?/, "");
    const target = `/v${latestVersion}/${remainder}`;
    // Preserve query string
    const qs = url.search ? url.search : "";
    return Response.redirect(`${url.origin}${target}${qs}`, 302);
  }

  // ---- /v{semver}/* → serve from R2 ----
  const versionMatch = path.match(VERSION_RE);
  if (versionMatch) {
    const version = versionMatch[1]; // e.g. "0.1.0"
    const remainder = (versionMatch[2] ?? "/").replace(/^\//, "");
    const r2Key = `v${version}/${remainder}`;

    const obj = await fetchWithFallback(context.env.ASSETS_BUCKET, r2Key, remainder);
    if (!obj) {
      return new Response(`Not found: ${path}`, { status: 404 });
    }

    const resolvedKey = remainder === "" || remainder.endsWith("/") ? "index.html" : r2Key;
    return respond(obj, resolvedKey, {
      "Cache-Control": cacheControl(r2Key, true),
      "Set-Cookie": versionCookie(`v${version}`),
    });
  }

  // ---- Absolute paths (/_astro/*, /favicon.svg, /shell/*, etc.) ----
  // These come from HTML that references assets with absolute paths.
  // Use the version cookie to determine which version's files to serve,
  // with fallback to root-level R2 keys (shared large assets like WASM).
  const stripped = path.startsWith("/") ? path.slice(1) : path;

  const versionPrefix = readVersionCookie(context.request) ?? null;
  if (versionPrefix) {
    const r2Key = `${versionPrefix}/${stripped}`;
    const obj = await fetchWithFallback(context.env.ASSETS_BUCKET, r2Key, stripped);
    if (obj) {
      return respond(obj, stripped);
    }
  }

  // ---- Fallback: try to find in the latest version, then root-level ----
  const latestObj = await context.env.ASSETS_BUCKET.get("_latest");
  if (latestObj) {
    const latestVersion = (await latestObj.text()).trim();
    const r2Key = `v${latestVersion}/${stripped}`;
    const obj = await fetchWithFallback(context.env.ASSETS_BUCKET, r2Key, stripped);
    if (obj) {
      return respond(obj, stripped);
    }
  }

  return new Response("Not found", { status: 404 });
};
