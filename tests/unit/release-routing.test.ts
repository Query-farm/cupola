import { afterEach, describe, expect, test } from "bun:test";
import { handler } from "../../worker/index";

const previousCaches = globalThis.caches;
afterEach(() => { Object.defineProperty(globalThis, "caches", { value: previousCaches, configurable: true }); });
function setup(files: Record<string, string>, cached?: Response) {
  let matches = 0;
  Object.defineProperty(globalThis, "caches", { configurable: true, value: { default: {
    match: async () => { matches++; return cached?.clone(); },
    put: async () => {}, delete: async () => true,
  } } });
  const bucket = { get: async (key: string) => {
    if (!(key in files)) return null;
    return { body: new Response(files[key]).body!, text: async () => files[key] };
  } };
  return {
    fetch: (path: string, accept = "text/html") => handler.fetch(new Request(`https://cupola.example${path}`, { headers: { Accept: accept } }), { ASSETS_BUCKET: bucket }, { waitUntil: () => {}, passThroughOnException: () => {} }),
    matches: () => matches,
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
