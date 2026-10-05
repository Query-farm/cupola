import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { assignAliases, isValidAlias, sanitizeAlias, serviceAlias, uniqueAlias } from "../../src/lib/workspace/aliases";
import { decodeWorkspaceToken, encodeWorkspaceToken } from "../../src/lib/workspace/codec";
import { defaultCatalogOf, normaliseWorkspace, toPortableFile, validateWorkspaceFile, type PortableWorkspaceFile } from "../../src/lib/workspace/spec";
import { compressSql } from "../../src/lib/share-query";

const file = (catalogs: unknown[], extra: Record<string, unknown> = {}) => ({
  format: "cupola-workspaces", version: 1, workspaces: [{ catalogs, ...extra }],
});
let counter = 0;
const newId = () => `id-${++counter}`;

describe("aliases", () => {
  test("valid aliases are plain, unreserved identifiers", () => {
    expect(isValidAlias("sales")).toBe(true);
    expect(isValidAlias("_x9")).toBe(true);
    for (const bad of ["", "9lives", "has space", "dash-ed", "memory", "MAIN", "Temp", "system", "x".repeat(64)]) {
      expect(isValidAlias(bad)).toBe(false);
    }
  });

  test("sanitizing makes an identifier", () => {
    expect(sanitizeAlias("my-catalog")).toBe("my_catalog");
    expect(sanitizeAlias("2024 data")).toBe("_2024_data");
    expect(sanitizeAlias("  ")).toBe("catalog");
    expect(sanitizeAlias("---")).toBe("catalog");
    expect(sanitizeAlias("x".repeat(80))).toHaveLength(63);
  });

  test("collisions get _2, _3, case-insensitively", () => {
    const { aliases, notes } = assignAliases([
      { catalogName: "cupola_test" },
      { catalogName: "cupola_test" },
      { catalogName: "CUPOLA_TEST" },
      { catalogName: "other", alias: "cupola_test_2" },
    ]);
    expect(aliases).toEqual(["cupola_test", "cupola_test_2", "CUPOLA_TEST_3", "cupola_test_2_2"]);
    expect(notes).toHaveLength(3);
    expect(notes[0]).toContain("already used");
  });

  test("reserved names are moved, not refused", () => {
    expect(assignAliases([{ catalogName: "memory" }, { catalogName: "x", alias: "main" }]).aliases).toEqual(["memory_2", "main_2"]);
    expect(assignAliases([{ catalogName: "memory" }]).notes[0]).toContain("reserved");
  });

  test("an invalid requested alias is sanitized; a valid one is kept", () => {
    expect(assignAliases([{ catalogName: "s", alias: "my alias" }]).aliases).toEqual(["my_alias"]);
    expect(assignAliases([{ catalogName: "s", alias: "Nice" }]).aliases).toEqual(["Nice"]);
    expect(assignAliases([{ catalogName: "with-dash" }]).aliases).toEqual(["with_dash"]);
  });

  test("taken names from outside the list are avoided", () => {
    expect(assignAliases([{ catalogName: "a" }], ["A"]).aliases).toEqual(["a_2"]);
  });

  test("uniqueAlias keeps the suffix within the length limit", () => {
    const base = "x".repeat(63);
    const alias = uniqueAlias(base, new Set([base]));
    expect(alias).toHaveLength(63);
    expect(alias.endsWith("_2")).toBe(true);
  });

  test("the ?service= alias is the server's name, unless DuckDB cannot attach under it", () => {
    expect(serviceAlias("my-catalog")).toBe("my-catalog");
    expect(serviceAlias("memory")).toBe("memory_2");
    expect(serviceAlias("")).toBe("catalog");
  });
});

describe("validation", () => {
  test("accepts a minimal workspace", () => {
    const result = validateWorkspaceFile(file([{ url: "http://localhost:9111", catalogName: "cupola_test" }]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.workspaces[0].catalogs[0]).toEqual({ url: "http://localhost:9111", catalogName: "cupola_test" });
  });

  test("refuses the wrong format, version, or an empty list", () => {
    expect(validateWorkspaceFile(null).ok).toBe(false);
    expect(validateWorkspaceFile({ ...file([]), format: "other" }).ok).toBe(false);
    expect(validateWorkspaceFile({ ...file([{ url: "http://x", catalogName: "c" }]), version: 2 }).ok).toBe(false);
    expect(validateWorkspaceFile(file([])).ok).toBe(false);
    expect(validateWorkspaceFile({ format: "cupola-workspaces", version: 1, workspaces: [] }).ok).toBe(false);
  });

  test("refuses a catalog without a usable URL or name", () => {
    for (const catalog of [{ catalogName: "c" }, { url: "javascript:alert(1)", catalogName: "c" }, { url: "ftp://x", catalogName: "c" }, { url: "http://x" }, { url: "http://x", catalogName: "" }, "nope"]) {
      const result = validateWorkspaceFile(file([catalog]));
      expect(result.ok).toBe(false);
    }
  });

  test("accepts grainlift URLs", () => {
    expect(validateWorkspaceFile(file([{ url: "grainlift+https://gw.example", catalogName: "d1", target: "sqlite" }])).ok).toBe(true);
    expect(validateWorkspaceFile(file([{ url: "grainlift+iroh://abc", catalogName: "d1" }])).ok).toBe(true);
  });

  test("drops credential-like and malformed options, with a warning", () => {
    const result = validateWorkspaceFile(file([{
      url: "http://x", catalogName: "c",
      options: { region: "eu", api_key: "sk-123", password: "p", "bad name": "1", "x); DROP": "1", max_rows: 5, flag: true, nested: { a: 1 } },
    }]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.workspaces[0].catalogs[0].options).toEqual({ region: "eu", max_rows: "5", flag: "true" });
    expect(result.warnings.join("\n")).toContain("api_key");
    expect(result.warnings.join("\n")).toContain("password");
    expect(result.warnings.join("\n")).not.toContain("sk-123");
    expect(result.warnings).toHaveLength(5);
  });

  test("refuses too many catalogs", () => {
    const many = Array.from({ length: 17 }, (_, i) => ({ url: `http://h${i}`, catalogName: "c" }));
    expect(validateWorkspaceFile(file(many)).ok).toBe(false);
  });
});

describe("normalisation", () => {
  test("assigns ids and de-duplicated aliases once, and resolves the default", () => {
    const ws = normaliseWorkspace({
      catalogs: [
        { url: "http://a", catalogName: "cupola_test" },
        { url: "http://b", catalogName: "cupola_test", id: "second" },
        { url: "grainlift+https://gw", catalogName: "d1", target: "sqlite" },
      ],
      defaultCatalogId: "second",
      defaultSchema: "small",
    }, newId);
    expect(ws.catalogs.map((c) => c.alias)).toEqual(["cupola_test", "cupola_test_2", "d1"]);
    expect(ws.catalogs.map((c) => c.kind)).toEqual(["vgi", "vgi", "grainlift"]);
    expect(ws.catalogs[1].id).toBe("second");
    expect(ws.defaultCatalogId).toBe("second");
    expect(defaultCatalogOf(ws)?.alias).toBe("cupola_test_2");
    expect(ws.defaultSchema).toBe("small");
    expect(ws.notes.some((n) => n.includes("cupola_test_2"))).toBe(true);
    expect(ws.source).toBe("link");
  });

  test("a default named by alias works; an unknown default falls back to the first", () => {
    const byAlias = normaliseWorkspace({ catalogs: [{ url: "http://a", catalogName: "a" }, { url: "http://b", catalogName: "b" }], defaultCatalogId: "b" }, newId);
    expect(defaultCatalogOf(byAlias)?.alias).toBe("b");
    const unknown = normaliseWorkspace({ catalogs: [{ url: "http://a", catalogName: "a" }], defaultCatalogId: "zzz" }, newId);
    expect(unknown.defaultCatalogId).toBeNull();
    expect(defaultCatalogOf(unknown)?.alias).toBe("a");
    expect(unknown.notes.join()).toContain("zzz");
  });

  test("duplicate ids are replaced", () => {
    const ws = normaliseWorkspace({ catalogs: [{ url: "http://a", catalogName: "a", id: "x" }, { url: "http://b", catalogName: "b", id: "x" }] }, newId);
    expect(new Set(ws.catalogs.map((c) => c.id)).size).toBe(2);
  });

  test("the portable form keeps the assigned aliases, so a round trip is stable", () => {
    const ws = normaliseWorkspace({ catalogs: [{ url: "http://a", catalogName: "c" }, { url: "http://b", catalogName: "c" }] }, newId);
    const again = normaliseWorkspace(toPortableFile(ws).workspaces[0], newId);
    expect(again.catalogs.map((c) => c.alias)).toEqual(["c", "c_2"]);
    expect(again.catalogs.map((c) => c.id)).toEqual(ws.catalogs.map((c) => c.id));
    expect(again.id).toBe(ws.id);
  });
});

describe("#ws= codec", () => {
  test("round trips", async () => {
    const original: PortableWorkspaceFile = {
      format: "cupola-workspaces", version: 1,
      workspaces: [{ name: "Finance", catalogs: [{ url: "http://localhost:9111", catalogName: "cupola_test", options: { region: "eu" } }] }],
    };
    const token = await encodeWorkspaceToken(original);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    const decoded = await decodeWorkspaceToken(token);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.file).toEqual(original);
  });

  test("a damaged, empty or non-JSON token is an error, not a throw", async () => {
    expect((await decodeWorkspaceToken("")).ok).toBe(false);
    expect((await decodeWorkspaceToken("!!!not-base64")).ok).toBe(false);
    const notJson = await compressSql("not json");
    const result = await decodeWorkspaceToken(notJson);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("JSON");
    const wrong = await decodeWorkspaceToken(await compressSql(JSON.stringify({ format: "x" })));
    expect(wrong.ok).toBe(false);
  });
});

describe("tab storage of the catalog set and pending sign-ins", () => {
  // Bun runs every unit file in one global scope: stub `window` for these
  // tests only and put back whatever was there.
  const g = globalThis as { window?: unknown };
  const had = "window" in g;
  const previous = g.window;
  const store = new Map<string, string>();
  const sessionStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
  };
  beforeAll(() => { g.window = { sessionStorage }; });
  afterAll(() => { if (had) g.window = previous; else delete g.window; });

  test("a stored workspace reads back with its aliases and consent", async () => {
    const { stashSessionWorkspace, loadSessionWorkspace, markSessionWorkspaceConsented } = await import("../../src/lib/workspace/session");
    const ws = normaliseWorkspace({ catalogs: [{ url: "http://a", catalogName: "c" }, { url: "http://b", catalogName: "c" }] }, newId);
    stashSessionWorkspace(ws, false);
    expect(loadSessionWorkspace(ws.id)).toEqual({ workspace: ws, consented: false });
    markSessionWorkspaceConsented(ws);
    expect(loadSessionWorkspace(ws.id)?.consented).toBe(true);
    expect(loadSessionWorkspace(ws.id)?.workspace.catalogs.map((c) => c.alias)).toEqual(["c", "c_2"]);
    expect(loadSessionWorkspace("missing")).toBeNull();
  });

  test("a pending sign-in is read for its own workspace only, until cleared", async () => {
    const { savePendingSignIn, readPendingSignIn, clearPendingSignIn } = await import("../../src/lib/workspace/session");
    const ws = normaliseWorkspace({ catalogs: [{ url: "http://a", catalogName: "a" }, { url: "http://b", catalogName: "b" }] }, newId);
    savePendingSignIn({ workspaceId: ws.id, workspace: ws, signingIn: ws.catalogs[0].id, pendingSignIns: ws.catalogs.map((c) => c.id) });
    expect(readPendingSignIn("other")).toBeNull();
    const pending = readPendingSignIn(ws.id);
    expect(pending?.signingIn).toBe(ws.catalogs[0].id);
    expect(pending?.pendingSignIns).toHaveLength(2);
    expect(readPendingSignIn(ws.id)).not.toBeNull();
    clearPendingSignIn();
    expect(readPendingSignIn(ws.id)).toBeNull();
  });
});
