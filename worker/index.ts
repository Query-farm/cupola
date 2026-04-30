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

import * as Sentry from "@sentry/cloudflare";

// Injected by wrangler via --define at deploy time. Local `wrangler dev`
// gets the literal placeholder, which is fine — the DSN check below skips
// Sentry init when the version is unset.
declare const __APP_VERSION__: string;
declare const __GIT_HASH__: string;

interface Env {
  ASSETS_BUCKET: R2Bucket;
  SENTRY_DSN?: string;
  ENVIRONMENT?: string;
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

const handler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/" || path === "") {
      const qs = url.search ? url.search : "";
      return Response.redirect(`${url.origin}/latest/${qs}`, 302);
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
      const obj = await fetchWithFallback(env.ASSETS_BUCKET, r2Key, remainder);
      if (!obj) {
        return new Response(`Not found: ${path}`, { status: 404 });
      }
      const hasExtension = remainder.includes(".");
      const resolvedKey =
        remainder === "" || remainder.endsWith("/") || !hasExtension ? "index.html" : r2Key;
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
      const obj = await fetchWithFallback(env.ASSETS_BUCKET, r2Key, stripped);
      if (obj) {
        const contentKey = stripped.includes(".") ? stripped : "index.html";
        return cacheAndReturn(respond(obj, contentKey));
      }
    }

    return new Response("Not found", { status: 404 });
  },
};

// Wrap accesses in `typeof` so unreplaced symbols (local `wrangler dev`) don't
// throw ReferenceError. wrangler's --define replaces the entire identifier, so
// the typeof-guarded path becomes the literal string in production builds.
const APP_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "";
const GIT_HASH = typeof __GIT_HASH__ === "string" ? __GIT_HASH__ : "";

export default Sentry.withSentry(
  (env: Env) => ({
    dsn:
      env.SENTRY_DSN ||
      "https://d0991fb45d2c62f5d25db86f2985cb79@o4511299556081664.ingest.us.sentry.io/4511299558637568",
    release: APP_VERSION && GIT_HASH ? `cupola@${APP_VERSION}+${GIT_HASH}` : undefined,
    environment: env.ENVIRONMENT || "production",
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
    beforeSend(event) {
      if (event.request?.headers) {
        for (const key of Object.keys(event.request.headers)) {
          if (key.toLowerCase() === "authorization") {
            event.request.headers[key] = "[Filtered]";
          } else if (key.toLowerCase() === "cookie") {
            event.request.headers[key] = scrubVgiAuthCookie(event.request.headers[key]);
          }
        }
      }
      return event;
    },
  }),
  handler,
);

function scrubVgiAuthCookie(cookieHeader: string): string {
  return cookieHeader
    .split(";")
    .map((part) => {
      const [name] = part.split("=");
      if (name?.trim() === "_vgi_auth") return `${name}=[Filtered]`;
      return part;
    })
    .join(";");
}
