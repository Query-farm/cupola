/**
 * Cloudflare Pages Function — versioned asset serving from R2.
 *
 * URL scheme:
 *   /                     → 302 → /latest/
 *   /latest/              → 302 → /v{latest_version}/
 *   /v0.1.0/*             → serve from R2 prefix "v0.1.0/"
 *   /oauth-callback.html  → latest-version fallback (stable Entra SPA URI)
 *
 * Astro's `base: /v{version}/` means every in-app asset reference is
 * versioned, so the bulk of traffic flows through the `/v{semver}/*` branch
 * and is safely edge-cached forever (`Cache-Control: immutable`). The
 * latest-version fallback exists solely for the SPA OAuth redirect URI —
 * oauth-callback.html must be reachable at a stable, version-free URL so
 * the Entra app registration can pin it as a redirect URI that survives
 * deploys. Its contents are stable across deploys so serving from latest
 * is fine.
 *
 * IMPORTANT: responses do not carry `Set-Cookie`. Cloudflare's default
 * cache behavior refuses to edge-cache any response with Set-Cookie, and
 * an earlier iteration of this function set a `_cupola_v` cookie on every
 * response — which turned the 33MB spatial.wasm + 32MB duckdb-coi.wasm
 * into origin-hit-every-time requests (cf-cache-status: DYNAMIC).
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

  // Explicit Cloudflare cache lookup for GET requests. Pages Functions
  // responses are *not* auto-cached at the edge the way static assets
  // are — every request hits the function and therefore (eventually)
  // R2. For big immutable assets like the 33MB spatial.wasm this turns
  // into a measurable latency tax for every first-time visitor in a
  // given region. Check the Workers Cache API first, and write
  // responses back into it at the end of the request.
  //
  // Note: `caches.default` is a per-colo cache distinct from the
  // Cloudflare edge cache (which Pages Functions bypass entirely), so
  // `cf-cache-status` will still say DYNAMIC — that header reflects
  // the edge cache. We add an `x-cupola-cache` header so we can
  // verify hits independently.
  const cache = (caches as unknown as { default: Cache }).default;
  if (context.request.method === "GET") {
    const cached = await cache.match(context.request);
    if (cached) {
      const hit = new Response(cached.body, cached);
      hit.headers.set("x-cupola-cache", "HIT");
      return hit;
    }
  }

  // Helper: cache a GET response before returning it. waitUntil keeps
  // the cache write alive after the response is sent to the client, so
  // the first request doesn't pay extra latency for the write.
  const cacheAndReturn = (res: Response): Response => {
    if (context.request.method === "GET" && res.status === 200) {
      try {
        context.waitUntil(cache.put(context.request, res.clone()));
      } catch {
        // If cache.put fails (e.g. non-cacheable body), just return
        // the response — serving the asset is more important than
        // caching it.
      }
    }
    res.headers.set("x-cupola-cache", "MISS");
    return res;
  };

  // ---- /npm/* → proxy to cdn.jsdelivr.net (ESM CDN transitive deps) ----
  if (path.startsWith("/npm/")) {
    const cdnUrl = `https://cdn.jsdelivr.net${path}`;
    const cdnResp = await fetch(cdnUrl, { headers: { "User-Agent": "cupola" } });
    const headers = new Headers(cdnResp.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    return cacheAndReturn(new Response(cdnResp.body, { status: cdnResp.status, headers }));
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
    // Do NOT set a Set-Cookie header here — Cloudflare's default cache
    // rules refuse to cache any response carrying Set-Cookie, which
    // turned the 33MB spatial.wasm + 32MB duckdb-coi.wasm into
    // origin-hit-every-time requests (cf-cache-status: DYNAMIC). Since
    // the URL itself is already versioned, the cookie-based version
    // routing for unversioned fallback is dead weight for any request
    // that comes through this branch. The `/oauth-callback.html` path
    // still works via the latest-version fallback below.
    return cacheAndReturn(respond(obj, resolvedKey, {
      "Cache-Control": cacheControl(r2Key, true),
    }));
  }

  // ---- Absolute paths (/oauth-callback.html, legacy /_astro/*, etc.) ----
  // With Astro's `base: /v{version}/` every in-app reference is
  // versioned, so the only things that hit this branch in normal
  // operation are:
  //   - /oauth-callback.html (Entra SPA redirect URI, intentionally
  //     unversioned so the Entra app registration can pin a stable URL)
  //   - stragglers from the pre-base-config era that users have
  //     bookmarked
  // Both cases are fine to serve from whatever version is currently
  // marked as `_latest` — oauth-callback.html's contents are stable
  // across deploys and stragglers are already broken in practice.
  const stripped = path.startsWith("/") ? path.slice(1) : path;

  // ---- Fallback: try to find in the latest version, then root-level ----
  const latestObj = await context.env.ASSETS_BUCKET.get("_latest");
  if (latestObj) {
    const latestVersion = (await latestObj.text()).trim();
    const r2Key = `v${latestVersion}/${stripped}`;
    const obj = await fetchWithFallback(context.env.ASSETS_BUCKET, r2Key, stripped);
    if (obj) {
      return cacheAndReturn(respond(obj, stripped));
    }
  }

  return new Response("Not found", { status: 404 });
};
