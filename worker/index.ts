/** Stable document URLs backed by immutable release assets in R2. */

import * as Sentry from "@sentry/cloudflare";

import { scrubUrl } from "../src/lib/sentry-scrub";
import {
  type ErrorVariant,
  plainTextForVariant,
  renderErrorPage,
  statusForVariant,
} from "./error-page";

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
  /** Only `waitUntil` is used; declared here alongside the other stubs rather
   *  than pulling in @cloudflare/workers-types for the whole Astro project. */
  interface ExecutionContext {
    waitUntil(promise: Promise<unknown>): void;
    passThroughOnException(): void;
  }
}

/** Matches /v1.2.3/ or /v1.2.3/some/path */
const VERSION_RE = /^\/v(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(\/.*)?$/;

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
    return "no-store";
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

async function readLatest(env: Env): Promise<string | null> {
  const obj = await env.ASSETS_BUCKET.get("_latest");
  if (!obj) return null;
  return (await obj.text()).trim();
}

/**
 * Only documents get the branded page. A missing `.js`/`.wasm` sub-resource
 * must keep its plain-text body — handing a fetch() or a <script> tag a page
 * of HTML is worse than the bare 404 it replaced.
 */
function wantsHtml(request: Request): boolean {
  return (request.headers.get("Accept") ?? "").includes("text/html");
}

function errorResponse(
  request: Request,
  opts: {
    variant: ErrorVariant;
    path: string;
    requestedVersion?: string;
    latestVersion?: string;
  },
): Response {
  const status = statusForVariant(opts.variant);
  // `no-store` throughout: a version that 404s today may be restored, and a
  // cached error page would outlive the fix. `cacheAndReturn` already skips
  // non-200s, so this only guards browser and intermediary caches.
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });

  if (!wantsHtml(request)) {
    headers.set("Content-Type", "text/plain; charset=utf-8");
    return new Response(plainTextForVariant(opts.variant, opts.path), { status, headers });
  }
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(renderErrorPage(opts), { status, headers });
}

export const handler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Route documents before consulting the old edge cache. Previously cached
    // versioned HTML must never bypass migration to the stable address.
    const versionMatch = path.match(VERSION_RE);
    const remainder = versionMatch?.[2] ?? "/";
    const isDocument = (pathname: string) =>
      !pathname.startsWith("/sandbox/") && pathname !== "/oauth-callback.html" &&
      (pathname.endsWith("/") || !pathname.split("/").pop()!.includes(".") || pathname.endsWith(".html"));
    const redirect = (target: string) => new Response(null, {
      status: 302,
      // No fragment in Location: browsers inherit the original fragment.
      headers: { Location: `${url.origin}${target}${url.search}`, "Cache-Control": "no-store" },
    });
    if (path === "/latest" || path.startsWith("/latest/")) {
      return redirect(path.replace(/^\/latest(?=\/|$)/, "") || "/");
    }
    if (versionMatch && isDocument(remainder)) {
      return redirect(remainder.replace(/(?:^|\/)index\.html$/, "/"));
    }
    if (path === "/release.json") {
      const version = await readLatest(env);
      if (!version) return new Response(null, { status: 503, headers: { "Cache-Control": "no-store" } });
      const metadata = await env.ASSETS_BUCKET.get(`v${version}/_release.json`);
      let publishedAt: string | null = null;
      if (metadata) {
        try { publishedAt = JSON.parse(await metadata.text()).publishedAt ?? null; } catch { /* legacy release */ }
      }
      return Response.json({ version, publishedAt }, { headers: { "Cache-Control": "no-store" } });
    }
    if (path === "/_latest" || path.endsWith("/_latest")) {
      return new Response(await readLatest(env), { headers: { "Cache-Control": "no-store" } });
    }
    const cache = (caches as unknown as { default: Cache }).default;
    // Stable paths always resolve against the live pointer, including HTML,
    // OAuth callbacks and unversioned compatibility assets.
    const cacheable = Boolean(versionMatch) || path.startsWith("/npm/");
    if (request.method === "GET" && cacheable) {
      const cached = await cache.match(request);
      if (cached) {
        const hit = new Response(cached.body, cached);
        hit.headers.set("x-cupola-cache", "HIT");
        return hit;
      }
    }

    const cacheAndReturn = async (res: Response): Promise<Response> => {
      if (request.method !== "GET" || res.status !== 200 || !res.body || !cacheable || res.headers.get("Cache-Control") === "no-store") {
        res.headers.set("x-cupola-cache", "SKIP");
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

    // Immutable assets never fall back to another release or root files.
    if (versionMatch) {
      const version = versionMatch[1];
      const remainder = (versionMatch[2] ?? "/").replace(/^\//, "");
      const r2Key = `v${version}/${remainder}`;
      const obj = await fetchFromR2(env.ASSETS_BUCKET, r2Key);
      if (!obj) {
        // Distinguish "the whole release is gone" from "that page doesn't
        // exist inside a release that is still live". One extra R2 get, and
        // only on a request that has already failed.
        const latestVersion = await readLatest(env);
        const versionRootExists =
          version === latestVersion ||
          (await fetchFromR2(env.ASSETS_BUCKET, `v${version}/`)) !== null;
        return errorResponse(request, {
          variant: versionRootExists ? "not-found" : "outdated-version",
          path,
          requestedVersion: version,
          latestVersion: latestVersion ?? undefined,
        });
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
    const latestVersion = await readLatest(env);
    if (latestVersion) {
      const r2Key = `v${latestVersion}/${stripped}`;
      const obj = await fetchWithFallback(env.ASSETS_BUCKET, r2Key, stripped);
      if (obj) {
        const contentKey = stripped.includes(".") ? stripped : "index.html";
        return cacheAndReturn(respond(obj, contentKey, { "Cache-Control": "no-store" }));
      }
    }

    // No `_latest` at all means nothing has ever been published — the same
    // condition the /latest/ branch reports as 503. This branch used to
    // collapse it into a generic 404.
    return errorResponse(request, {
      variant: latestVersion ? "not-found" : "not-deployed",
      path,
      latestVersion: latestVersion ?? undefined,
    });
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
      if (typeof event.request?.url === "string") {
        event.request.url = scrubUrl(event.request.url);
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
