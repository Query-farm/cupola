/**
 * Tests for the centralized URL-params consumption module.
 *
 * Most important property: when `consumeAiKey` and `consumeAuthFragment` both
 * fire on the same load (a redirector that bundles `#token=...&ai_key=...`),
 * neither one's rewrite clobbers the other's preserved keys. The order they
 * run in must not matter — selection-routing fragments must also survive.
 */
import { test, expect, describe, beforeEach } from "bun:test";

let currentHash = "";
let currentPath = "/";
let currentSearch = "";

const fakeHistory = {
  replaceState: (_state: unknown, _title: string, url: string) => {
    const u = new URL(url, "http://localhost");
    currentPath = u.pathname;
    currentSearch = u.search;
    currentHash = u.hash;
  },
};
const store = new Map<string, string>();
const fakeSessionStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
};

(globalThis as any).window = {
  get location() { return { hash: currentHash, pathname: currentPath, search: currentSearch }; },
  history: fakeHistory,
  sessionStorage: fakeSessionStorage,
};
(globalThis as any).history = fakeHistory;

const {
  consumeAiKey,
  consumeAuthFragment,
  consumePrefillFromHash,
  consumeSharedSql,
  clearSharedSql,
  getServiceUrl,
  getThemeUrl,
} = await import("../../src/lib/url-params");

beforeEach(() => {
  currentPath = "/";
  currentSearch = "";
  currentHash = "";
  store.clear();
});

describe("getters", () => {
  test("getServiceUrl: from ?service=", () => {
    currentSearch = "?service=https%3A%2F%2Fexample.com";
    expect(getServiceUrl()).toBe("https://example.com");
  });

  test("getThemeUrl: returns ?theme= or null", () => {
    expect(getThemeUrl()).toBe(null);
    currentSearch = "?theme=https%3A%2F%2Fcdn.example.com%2Ft.json";
    expect(getThemeUrl()).toBe("https://cdn.example.com/t.json");
  });
});

describe("consumeAiKey", () => {
  test("from query string", () => {
    currentSearch = "?ai_key=sk-abc&other=keep";
    expect(consumeAiKey()).toBe("sk-abc");
    expect(currentSearch).toBe("?other=keep");
  });

  test("from fragment, preserving non-key fragments", () => {
    currentHash = "#ai_key=sk-abc&token=xyz";
    expect(consumeAiKey()).toBe("sk-abc");
    // ai_key stripped, but other auth fragment params remain (auth.ts will
    // consume them separately).
    expect(currentHash).toBe("#token=xyz");
  });

  test("selection-routing fragment is NOT misparsed as params", () => {
    currentHash = "#/schema/foo/table/bar";
    expect(consumeAiKey()).toBe(null);
    expect(currentHash).toBe("#/schema/foo/table/bar");
  });

  test("query-string form wins when both present", () => {
    currentSearch = "?ai_key=from-query";
    currentHash = "#ai_key=from-hash";
    expect(consumeAiKey()).toBe("from-query");
  });
});

describe("consumeAuthFragment", () => {
  test("extracts and strips all auth keys, preserves others", () => {
    currentHash = "#token=t&refresh_token=r&token_endpoint=ep&ai_key=k&use_id_token=true";
    const frag = consumeAuthFragment();
    expect(frag?.token).toBe("t");
    expect(frag?.refreshToken).toBe("r");
    expect(frag?.tokenEndpoint).toBe("ep");
    expect(frag?.useIdToken).toBe(true);
    // ai_key survives the auth strip — settings.tsx will consume it.
    expect(currentHash).toBe("#ai_key=k");
  });

  test("no #token= → null, hash untouched", () => {
    currentHash = "#ai_key=k";
    expect(consumeAuthFragment()).toBe(null);
    expect(currentHash).toBe("#ai_key=k");
  });
});

describe("composition: consumeAuthFragment + consumeAiKey on the same load", () => {
  test("either order leaves both peers' work consistent", () => {
    currentHash = "#token=t&refresh_token=r&ai_key=k";

    // auth first
    expect(consumeAuthFragment()?.token).toBe("t");
    expect(currentHash).toBe("#ai_key=k");
    expect(consumeAiKey()).toBe("k");
    expect(currentHash).toBe("");

    // ai_key first
    currentHash = "#token=t&refresh_token=r&ai_key=k";
    expect(consumeAiKey()).toBe("k");
    expect(currentHash).toBe("#token=t&refresh_token=r");
    expect(consumeAuthFragment()?.token).toBe("t");
    expect(currentHash).toBe("");
  });
});

describe("consumeSharedSql", () => {
  const SERVICE = "service=https%3A%2F%2Fhost%3A9003";

  test("reads #sql=, strips it, preserves other fragment keys", async () => {
    currentSearch = `?${SERVICE}`;
    currentHash = "#sql=SELECT+1%3B&token=t";
    expect(await consumeSharedSql()).toBe("SELECT 1;");
    expect(currentHash).toBe("#token=t");
    expect(currentSearch).toBe(`?${SERVICE}`);
  });

  test("query-string form wins when both present", async () => {
    currentSearch = `?${SERVICE}&sql=SELECT+2%3B`;
    currentHash = "#sql=SELECT+3%3B";
    expect(await consumeSharedSql()).toBe("SELECT 2;");
  });

  test("no ?service= → left in the URL for a later load", async () => {
    currentHash = "#sql=SELECT+1%3B";
    expect(await consumeSharedSql()).toBe(null);
    expect(currentHash).toBe("#sql=SELECT+1%3B");
  });

  // The bug this stash exists for: an auth-protected service 401s, we redirect
  // to the IdP, and the reload lands here with a fragment-free URL and no React
  // state. The SQL has to come back from somewhere.
  test("survives a reload with no SQL in the URL, until cleared", async () => {
    currentSearch = `?${SERVICE}`;
    currentHash = "#sql=SELECT+1%3B";
    expect(await consumeSharedSql()).toBe("SELECT 1;");

    currentHash = "";
    expect(await consumeSharedSql()).toBe("SELECT 1;");

    clearSharedSql();
    expect(await consumeSharedSql()).toBe(null);
  });

  test("a fresh link replaces an uncleared stash", async () => {
    currentSearch = `?${SERVICE}`;
    currentHash = "#sql=SELECT+1%3B";
    expect(await consumeSharedSql()).toBe("SELECT 1;");

    currentHash = "#sql=SELECT+2%3B";
    expect(await consumeSharedSql()).toBe("SELECT 2;");
    currentHash = "";
    expect(await consumeSharedSql()).toBe("SELECT 2;");
  });

  test("a corrupt sql_z doesn't shadow an unconsumed stash", async () => {
    currentSearch = `?${SERVICE}`;
    currentHash = "#sql=SELECT+1%3B";
    expect(await consumeSharedSql()).toBe("SELECT 1;");

    currentHash = "#sql_z=!!!not-base64!!!";
    expect(await consumeSharedSql()).toBe("SELECT 1;");
  });
});

describe("consumePrefillFromHash", () => {
  test("strips entire prefill hash", () => {
    currentHash = "#prefill=https%3A%2F%2Fhost%3A9003";
    expect(consumePrefillFromHash()).toBe("https://host:9003");
    expect(currentHash).toBe("");
  });

  test("non-prefill hash is left alone", () => {
    currentHash = "#/schema/foo";
    expect(consumePrefillFromHash()).toBe(null);
    expect(currentHash).toBe("#/schema/foo");
  });
});
