/**
 * Unit tests for the URL-fragment token cache in src/lib/auth.ts.
 *
 * Stage 1 finding #18: when a new #token=... fragment arrives mid-session
 * (e.g. re-auth redirect), the old _cachedToken value previously won via the
 * `if (_cachedToken) return _cachedToken` short-circuit. This test asserts
 * the cache is invalidated when a fresh #token= is present in the hash.
 */
import { test, expect, describe, beforeEach } from "bun:test";

// Minimal window stub so auth.ts's `if (typeof window === "undefined")` check
// resolves to the test-provided location/history surface. Bun has no DOM by default.
let currentHash = "";
let currentPath = "/";
let currentSearch = "";

(globalThis as any).window = {
  get location() {
    return {
      hash: currentHash,
      pathname: currentPath,
      search: currentSearch,
    };
  },
};
(globalThis as any).history = {
  replaceState: (_state: unknown, _title: string, url: string) => {
    const u = new URL(url, "http://localhost");
    currentPath = u.pathname;
    currentSearch = u.search;
    currentHash = u.hash;
  },
};

// Import AFTER the window stub so module-level checks pass cleanly.
const { getAuthToken, clearAllAuth } = await import("../../src/lib/auth");

beforeEach(() => {
  clearAllAuth();
  currentPath = "/";
  currentSearch = "";
  currentHash = "";
});

describe("fragment token cache invalidation", () => {
  test("first #token= is cached and stripped from URL", () => {
    currentHash = "#token=aaa&other=keep";
    const t1 = getAuthToken();
    expect(t1).toBe("aaa");
    // Non-auth fragment keys should be preserved.
    expect(currentHash).toBe("#other=keep");
    // Cached: second call without changing hash returns same value.
    expect(getAuthToken()).toBe("aaa");
  });

  test("new #token= mid-session invalidates the stale cache", () => {
    currentHash = "#token=aaa";
    expect(getAuthToken()).toBe("aaa");
    // Stripped, so hash is now empty. Cached token would still return "aaa".
    expect(getAuthToken()).toBe("aaa");

    // Simulate a re-auth redirect that drops a new fragment.
    currentHash = "#token=bbb";
    const t2 = getAuthToken();
    expect(t2).toBe("bbb");
  });

  test("no #token= in hash keeps the cached value", () => {
    currentHash = "#token=aaa";
    expect(getAuthToken()).toBe("aaa");
    // Selection routing or ai_key fragments shouldn't bust the cache.
    currentHash = "#/schema/foo/table/bar";
    expect(getAuthToken()).toBe("aaa");
  });
});
