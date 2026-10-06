import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { handler } from "../../worker/index";

const previousCaches = globalThis.caches;
afterEach(() => { Object.defineProperty(globalThis, "caches", { value: previousCaches, configurable: true }); });
function setup(files: Record<string, string>, cached?: Response, etag = '"r2-tag"') {
  const writes: Response[] = [];
  let matches = 0;
  Object.defineProperty(globalThis, "caches", { configurable: true, value: { open: async () => ({
    match: async () => { matches++; return cached?.clone(); },
    put: async (_request: Request, response: Response) => { writes.push(response); }, delete: async () => true,
  }) } });
  const bucket = { get: async (key: string) => {
    if (!(key in files)) return null;
    return { httpEtag: etag, body: new Response(files[key]).body!, text: async () => files[key] };
  } };
  return {
    fetch: (path: string, accept = "text/html", headers: Record<string, string> = {}, method = "GET") => handler.fetch(new Request(`https://cupola.example${path}`, { method, headers: { Accept: accept, ...headers } }), { ASSETS_BUCKET: bucket }, { waitUntil: () => {}, passThroughOnException: () => {} }),
    matches: () => matches,
    writes,
  };
}

describe("release routing", () => {
  test("stable pages resolve the live pointer without using cached old HTML", async () => {
    const files = { _latest: "1.0.0", "v1.0.0/index.html": "one", "v2.0.0/index.html": "two" };
    const app = setup(files, new Response("stale"));
    const first = await app.fetch("/");
    expect(await first.text()).toBe("one");
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    files._latest = "2.0.0";
    expect(await (await app.fetch("/")).text()).toBe("two");
    expect(app.matches()).toBe(0);
  });
  test("legacy pages redirect before cached HTML, preserving query and fragment inheritance", async () => {
    const app = setup({}, new Response("stale"));
    for (const path of ["/v1.0.0/reports?service=x", "/latest/reports?service=x"]) {
      const response = await app.fetch(path);
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("https://cupola.example/reports?service=x");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(app.matches()).toBe(0);
    expect((await app.fetch("/v1.0.0/index.html")).headers.get("Location")).toBe("https://cupola.example/");
  });
  test("retained assets stay isolated; missing assets never fall back to current or root", async () => {
    const app = setup({ _latest: "2.0.0", "v1.0.0/worker.js": "old", "v2.0.0/worker.js": "new", "missing.js": "wrong", "v2.0.0/missing.js": "wrong" });
    const asset = await app.fetch("/v1.0.0/worker.js", "*/*");
    expect(await asset.text()).toBe("old");
    expect(asset.headers.get("Cache-Control")).toContain("immutable");
    const missing = await app.fetch("/v1.0.0/missing.js", "*/*");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Content-Type")).toContain("text/plain");
  });
  test("OAuth callback documents remain version-specific assets", async () => {
    const app = setup({ "v1.0.0/oauth-callback.html": "callback" });
    expect(await (await app.fetch("/v1.0.0/oauth-callback.html")).text()).toBe("callback");
  });
  test("manifest follows promotions and rollbacks without cache", async () => {
    const files = { _latest: "2.0.0", "v2.0.0/_release.json": '{"publishedAt":"2026-10-05T12:00:00Z"}' };
    const app = setup(files);
    const response = await app.fetch("/release.json");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ version: "2.0.0", publishedAt: "2026-10-05T12:00:00Z" });
    files._latest = "1.0.0";
    expect(await (await app.fetch("/release.json")).json()).toEqual({ version: "1.0.0", publishedAt: null });
  });
});


describe("cache validators", () => {
  test("forwards the quoted R2 ETag and stores it with the asset", async () => {
    const app = setup({ "v1.0.0/a.js": "script" });
    const response = await app.fetch("/v1.0.0/a.js");
    expect(response.headers.get("ETag")).toBe('"r2-tag"');
    expect(app.writes[0].headers.get("ETag")).toBe('"r2-tag"');
    expect(await response.text()).toBe("script");
  });
  test("cold-cache exact, weak, list and wildcard matches return empty 304s", async () => {
    for (const tag of ['"r2-tag"', 'W/"r2-tag"', '"other,tag", W/"r2-tag"', '*']) {
      const app = setup({ "v1.0.0/a.js": "script" });
      const response = await app.fetch("/v1.0.0/a.js", "*/*", { "If-None-Match": tag });
      expect(response.status).toBe(304);
      expect(response.headers.get("ETag")).toBe('"r2-tag"');
      expect(response.headers.get("Cache-Control")).toContain("immutable");
      expect(await response.text()).toBe("");
      expect(app.writes).toHaveLength(0);
    }
  });
  test("a different validator returns the complete body", async () => {
    const app = setup({ "v1.0.0/a.js": "script" });
    const response = await app.fetch("/v1.0.0/a.js", "*/*", { "If-None-Match": '"old"' });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("script");
  });
  test("warm-cache matches also return 304 without a body or content length", async () => {
    const app = setup({}, new Response("script", { headers: { ETag: '"r2-tag"', "Content-Length": "6" } }));
    const response = await app.fetch("/v1.0.0/a.js", "*/*", { "If-None-Match": 'W/"r2-tag"' });
    expect(response.status).toBe(304);
    expect(response.headers.get("Content-Length")).toBeNull();
    expect(await response.text()).toBe("");
  });
  test("HEAD preserves validators without returning a body", async () => {
    const app = setup({ "v1.0.0/a.js": "script" });
    const response = await app.fetch("/v1.0.0/a.js", "*/*", {}, "HEAD");
    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).toBe('"r2-tag"');
    expect(await response.text()).toBe("");
  });
});

describe("npm proxy caching", () => {
  test("upstream errors are never advertised as immutable or cached", async () => {
    const upstream = spyOn(globalThis, "fetch").mockResolvedValue(new Response("missing", { status: 404, headers: { "Cache-Control": "public, max-age=86400" } }));
    try {
      const app = setup({});
      const response = await app.fetch("/npm/example@1.0.0/missing.js");
      expect(response.status).toBe(404);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(app.writes).toHaveLength(0);
    } finally { upstream.mockRestore(); }
  });
  test("moving aliases retain the upstream TTL and query string", async () => {
    const upstream = spyOn(globalThis, "fetch").mockResolvedValue(new Response("module", { headers: { "Cache-Control": "public, max-age=60" } }));
    try {
      const app = setup({});
      const response = await app.fetch("/npm/example@latest/index.js?module");
      expect(response.headers.get("Cache-Control")).toBe("public, max-age=60");
      expect(upstream.mock.calls[0][0]).toBe("https://cdn.jsdelivr.net/npm/example@latest/index.js?module");
    } finally { upstream.mockRestore(); }
  });
});
