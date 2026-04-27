/**
 * Cloudflare Worker — versioned asset serving from R2.
 *
 * Replaces the previous Pages Function (functions/[[path]].ts). Routing
 * semantics, caching behavior, and headers are unchanged. The only
 * differences from the Pages handler are mechanical:
 *
 *   - Exports a `{ fetch }` default object instead of `onRequest`.
 *   - `context.env`         → `env`
 *   - `context.request`     → `request`
 *   - `context.waitUntil()` → `ctx.waitUntil()`
 *
 * URL scheme:
 *   /                     → 302 → /latest/
 *   /latest/              → 302 → /v{latest_version}/
 *   /v0.1.0/*             → serve from R2 prefix "v0.1.0/"
 *   /oauth-callback.html  → latest-version fallback (stable Entra SPA URI)
 */

interface Env {
  ASSETS_BUCKET: R2Bucket;
}

// Minimal Workers-runtime type stand-ins so this file type-checks without
// pulling in @cloudflare/workers-types for the wider Astro project. Wrangler
// bundles this file with the actual runtime types at deploy time.
declare global {
  interface R2ObjectBody {
    body: ReadableStream;
    text(): Promise<string>;
  }
  interface R2Bucket {
    get(key: string): Promise<R2ObjectBody | null>;
  }
  interface Cache {
    match(req: Request): Promise<Response | undefined>;
    put(req: Request, res: Response): Promise<void>;
    delete(req: Request): Promise<boolean>;
  }
  interface CacheStorage {
    default: Cache;
  }
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

async function fetchFromR2(bucket: R2Bucket, key: string): Promise<R2ObjectBody | null> {
  let obj = await bucket.get(key);
  if (obj) return obj;
  if (!key.endsWith("/")) {
    obj = await bucket.get(key + "/index.html");
  } else {
    obj = await bucket.get(key + "index.html");
  }
  return obj;
}

async function fetchWithFallback(
  bucket: R2Bucket,
  versionedKey: string,
  rootKey: string,
): Promise<R2ObjectBody | null> {
  const obj = await fetchFromR2(bucket, versionedKey);
  if (obj) return obj;
  return fetchFromR2(bucket, rootKey);
}

function cacheControl(key: string, isVersioned: boolean): string {
  if (key.endsWith(".html") || key.endsWith("/index.html")) {
    return "public, max-age=60, s-maxage=300";
  }
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

/** Pick the best Content-Encoding the client accepts for a pre-compressed
 *  asset. Returns null for clients that only support identity. */
function pickEncoding(accept: string): "zstd" | "gzip" | null {
  const ae = accept.toLowerCase();
  if (ae.includes("zstd")) return "zstd";
  if (ae.includes("gzip")) return "gzip";
  return null;
}

/** Try to fetch a pre-compressed sibling (.zst / .gz) of a wasm asset and
 *  return a Response with the matching Content-Encoding. Returns null if no
 *  sibling exists or the client doesn't advertise support, in which case the
 *  caller should fall back to the uncompressed object. */
async function tryCompressedSibling(
  bucket: R2Bucket,
  request: Request,
  versionedKey: string,
  rootKey: string,
  resolvedKey: string,
  isVersioned: boolean,
): Promise<Response | null> {
  // Only compressible assets we ship pre-compressed: .wasm files (which
  // includes .duckdb_extension.wasm).
  if (!/\.wasm$/.test(resolvedKey)) return null;
  const enc = pickEncoding(request.headers.get("Accept-Encoding") ?? "");
  if (!enc) return null;

  const suffix = enc === "zstd" ? ".zst" : ".gz";
  const obj = await fetchWithFallback(bucket, versionedKey + suffix, rootKey + suffix);
  if (!obj) return null;

  return respond(obj, resolvedKey, {
    "Cache-Control": cacheControl(resolvedKey, isVersioned),
    "Content-Encoding": enc,
    "Vary": "Accept-Encoding",
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/" || path === "") {
      return Response.redirect(`${url.origin}/latest/`, 302);
    }

    const cache = (caches as unknown as { default: Cache }).default;
    const isLatestMarkerPath = path === "/_latest" || path.endsWith("/_latest");

    if (request.method === "GET" && !isLatestMarkerPath) {
      const cached = await cache.match(request);
      if (cached) {
        const hit = new Response(cached.body, cached);
        hit.headers.set("x-cupola-cache", "HIT");
        return hit;
      }
    }
    if (isLatestMarkerPath && request.method === "GET") {
      try { ctx.waitUntil(cache.delete(request)); } catch { /* ignore */ }
    }

    const cacheAndReturn = async (res: Response): Promise<Response> => {
      const isLatestMarker = path === "/_latest" || path.endsWith("/_latest");
      if (request.method !== "GET" || res.status !== 200 || !res.body || isLatestMarker) {
        res.headers.set("x-cupola-cache", "SKIP");
        if (isLatestMarker) {
          res.headers.set("Cache-Control", "no-store, max-age=0");
        }
        return res;
      }
      const [forClient, forCache] = res.body.tee();
      const clientRes = new Response(forClient, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
      clientRes.headers.set("x-cupola-cache", "MISS");
      const cacheRes = new Response(forCache, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
      try {
        ctx.waitUntil(
          cache.put(request, cacheRes).catch((err) => {
            console.warn("[worker] cache.put failed:", err);
          }),
        );
      } catch (err) {
        console.warn("[worker] cache.put (waitUntil) threw synchronously:", err);
      }
      return clientRes;
    };

    // ---- /npm/* → proxy to cdn.jsdelivr.net ----
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
      const latestObj = await env.ASSETS_BUCKET.get("_latest");
      if (!latestObj) {
        return new Response("No version deployed yet.", { status: 503 });
      }
      const latestVersion = (await latestObj.text()).trim();
      const remainder = path.replace(/^\/latest\/?/, "");
      const target = `/v${latestVersion}/${remainder}`;
      const qs = url.search ? url.search : "";
      return Response.redirect(`${url.origin}${target}${qs}`, 302);
    }

    // ---- /v{semver}/* ----
    const versionMatch = path.match(VERSION_RE);
    if (versionMatch) {
      const version = versionMatch[1];
      const remainder = (versionMatch[2] ?? "/").replace(/^\//, "");
      const r2Key = `v${version}/${remainder}`;
      const hasExtension = remainder.includes(".");
      const resolvedKey =
        remainder === "" || remainder.endsWith("/") || !hasExtension ? "index.html" : r2Key;

      const compressed = await tryCompressedSibling(
        env.ASSETS_BUCKET, request, r2Key, remainder, resolvedKey, true,
      );
      if (compressed) return cacheAndReturn(compressed);

      const obj = await fetchWithFallback(env.ASSETS_BUCKET, r2Key, remainder);
      if (!obj) {
        return new Response(`Not found: ${path}`, { status: 404 });
      }
      return cacheAndReturn(
        respond(obj, resolvedKey, {
          "Cache-Control": cacheControl(resolvedKey, true),
        }),
      );
    }

    // ---- Fallback: latest version, then root-level ----
    const stripped = path.startsWith("/") ? path.slice(1) : path;
    const latestObj = await env.ASSETS_BUCKET.get("_latest");
    if (latestObj) {
      const latestVersion = (await latestObj.text()).trim();
      const r2Key = `v${latestVersion}/${stripped}`;
      const contentKey = stripped.includes(".") ? stripped : "index.html";

      const compressed = await tryCompressedSibling(
        env.ASSETS_BUCKET, request, r2Key, stripped, contentKey, false,
      );
      if (compressed) return cacheAndReturn(compressed);

      const obj = await fetchWithFallback(env.ASSETS_BUCKET, r2Key, stripped);
      if (obj) {
        return cacheAndReturn(respond(obj, contentKey));
      }
    }

    return new Response("Not found", { status: 404 });
  },
};
