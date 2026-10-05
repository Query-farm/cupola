import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  aliasEditProblem,
  defaultAfterRemove,
  describeConnectionTest,
  draftChanges,
  draftOf,
  dropOnto,
  moveAnnouncement,
  moveBy,
  moveTo,
  normalizeWorkspaceName,
  PALETTE_NAMES,
  resolveDefault,
  urlProblem,
} from "../../src/lib/workspace/manager";
import {
  createWorkspace,
  deleteWorkspace,
  duplicateWorkspace,
  getWorkspace,
  PALETTE_SIZE,
  removeCatalog,
  reorderCatalogs,
  resetWorkspaceCache,
  setCatalogColor,
  setCatalogEnabled,
  setDefaultCatalog,
  setWorkspaceTestHooks,
  uniqueWorkspaceName,
  updateCatalog,
} from "../../src/lib/workspace/store";
import { catalogSecrets, saveCatalogSecrets } from "../../src/lib/attach/secret-store";
import { optionInputKind, optionRows, optionsToSqlText, sqlTextToOptions } from "../../src/lib/attach/form";
import type { OptionSpecInfo } from "../../src/lib/attach/options";
import { aliasRenameMessage, confirmAliasRenameWith } from "../../src/lib/workspace/alias-rename-confirm";

// Bun runs every unit test file in one global scope: restore what we stub.
class MemoryStorage {
  map = new Map<string, string>();
  get length() { return this.map.size; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

const g = globalThis as { localStorage?: unknown };
const original = g.localStorage;
const mem = new MemoryStorage();
let ids = 0;
let now = 1_000;

beforeAll(() => { g.localStorage = mem; });
afterAll(() => {
  g.localStorage = original;
  setWorkspaceTestHooks();
  resetWorkspaceCache();
});
beforeEach(() => {
  mem.clear();
  ids = 0;
  now = 1_000;
  setWorkspaceTestHooks({ newId: () => `id${++ids}`, now: () => (now += 10) });
  resetWorkspaceCache();
});

const A = "http://a.test";
const B = "http://b.test";
const C = "http://c.test";

function spec(over: Partial<OptionSpecInfo> & { name: string }): OptionSpecInfo {
  return { description: "", duckdbType: "VARCHAR", castType: "VARCHAR", arrowType: "Utf8", required: false, secret: false, ...over };
}

function three() {
  return createWorkspace(
    [{ url: A, catalogName: "sales" }, { url: B, catalogName: "ops" }, { url: C, catalogName: "hr" }],
    { name: "Finance" },
  );
}

describe("reorder", () => {
  test("moveTo and moveBy clamp at the ends and ignore unknown ids", () => {
    expect(moveTo(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
    expect(moveTo(["a", "b", "c"], "a", 99)).toEqual(["b", "c", "a"]);
    expect(moveBy(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveBy(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
    expect(moveBy(["a", "b", "c"], "a", -1)).toEqual(["a", "b", "c"]);
    expect(moveBy(["a", "b", "c"], "c", 1)).toEqual(["a", "b", "c"]);
    expect(moveBy(["a", "b"], "zz", 1)).toEqual(["a", "b"]);
  });

  test("dropOnto places before or after the target", () => {
    expect(dropOnto(["a", "b", "c", "d"], "a", "c", "before")).toEqual(["b", "a", "c", "d"]);
    expect(dropOnto(["a", "b", "c", "d"], "a", "c", "after")).toEqual(["b", "c", "a", "d"]);
    expect(dropOnto(["a", "b", "c", "d"], "d", "a", "before")).toEqual(["d", "a", "b", "c"]);
    expect(dropOnto(["a", "b"], "a", "a", "after")).toEqual(["a", "b"]);
    expect(dropOnto(["a", "b"], "x", "a", "after")).toEqual(["a", "b"]);
  });

  test("the announcement names the new position", () => {
    expect(moveAnnouncement("sales", ["b", "a", "c"], "a")).toBe("Moved sales to position 2 of 3.");
  });

  test("the store reorders, persists, and refuses a list that drops or repeats a catalog", () => {
    const ws = three();
    const [s, o, h] = ws.catalogs.map((c) => c.id);
    expect(reorderCatalogs(ws.id, [h, s, o])).toBe(true);
    resetWorkspaceCache();
    expect(getWorkspace(ws.id)!.catalogs.map((c) => c.alias)).toEqual(["hr", "sales", "ops"]);
    expect(reorderCatalogs(ws.id, [h, s])).toBe(false);
    expect(reorderCatalogs(ws.id, [h, s, s])).toBe(false);
    expect(reorderCatalogs(ws.id, [h, s, "nope"])).toBe(false);
    expect(getWorkspace(ws.id)!.catalogs.map((c) => c.alias)).toEqual(["hr", "sales", "ops"]);
    expect(reorderCatalogs("missing", [])).toBe(false);
  });

  test("reordering keeps colours, the enabled flag and the default", () => {
    const ws = three();
    const [s, o, h] = ws.catalogs.map((c) => c.id);
    setCatalogColor(ws.id, o, 6);
    setCatalogEnabled(ws.id, h, false);
    setDefaultCatalog(ws.id, o);
    reorderCatalogs(ws.id, [o, h, s]);
    const after = getWorkspace(ws.id)!;
    expect(after.defaultCatalogId).toBe(o);
    expect(after.catalogs.find((c) => c.id === o)!.color).toBe(6);
    expect(after.catalogs.find((c) => c.id === h)!.enabled).toBe(false);
  });
});

describe("the default catalog", () => {
  test("resolveDefault keeps a valid request and otherwise picks the first", () => {
    expect(resolveDefault(["a", "b"], "b")).toBe("b");
    expect(resolveDefault(["a", "b"], "gone")).toBe("a");
    expect(resolveDefault(["a", "b"], null)).toBe("a");
    expect(resolveDefault([], "a")).toBeNull();
  });

  test("removing the default moves it to the first remaining catalog", () => {
    expect(defaultAfterRemove(["a", "b", "c"], "a", "a")).toBe("b");
    expect(defaultAfterRemove(["a", "b", "c"], "c", "a")).toBe("c");
    expect(defaultAfterRemove(["a"], "a", "a")).toBeNull();
  });

  test("the store keeps exactly one default through set, remove and reorder", () => {
    const ws = three();
    const [s, o, h] = ws.catalogs.map((c) => c.id);
    expect(getWorkspace(ws.id)!.defaultCatalogId).toBe(s);
    setDefaultCatalog(ws.id, h);
    expect(getWorkspace(ws.id)!.defaultCatalogId).toBe(h);
    setDefaultCatalog(ws.id, "not-a-catalog");
    expect(getWorkspace(ws.id)!.defaultCatalogId).toBe(h);
    removeCatalog(ws.id, h);
    expect(getWorkspace(ws.id)!.defaultCatalogId).toBe(defaultAfterRemove([s, o, h], h, h));
    reorderCatalogs(ws.id, [o, s]);
    expect(getWorkspace(ws.id)!.defaultCatalogId).toBe(s);
    removeCatalog(ws.id, s);
    removeCatalog(ws.id, o);
    expect(getWorkspace(ws.id)!.defaultCatalogId).toBeNull();
  });
});

describe("aliases", () => {
  const catalogs = [{ id: "1", alias: "sales" }, { id: "2", alias: "Ops" }, { id: "3", alias: "" }];

  test("a catalog's own alias is not taken; another's is, case-insensitively", () => {
    expect(aliasEditProblem("sales", "1", catalogs)).toBeNull();
    expect(aliasEditProblem("SALES", "1", catalogs)).toBeNull();
    expect(aliasEditProblem("ops", "1", catalogs)).toMatch(/already used/);
    expect(aliasEditProblem("sales", "3", catalogs)).toMatch(/already used/);
  });

  test("identifiers only, not reserved, not empty, not too long", () => {
    expect(aliasEditProblem("", "1", catalogs)).toMatch(/required/);
    expect(aliasEditProblem("memory", "1", catalogs)).toMatch(/reserved/);
    expect(aliasEditProblem("Main", "1", catalogs)).toMatch(/reserved/);
    expect(aliasEditProblem("2024_sales", "1", catalogs)).toMatch(/Letters, digits/);
    expect(aliasEditProblem("sales-eu", "1", catalogs)).toMatch(/Letters, digits/);
    expect(aliasEditProblem("x".repeat(64), "1", catalogs)).toMatch(/At most 63/);
    expect(aliasEditProblem("  sales_eu  ", "1", catalogs)).toBeNull();
  });

  test("the store refuses an invalid or taken alias and accepts a valid one", () => {
    const ws = three();
    const [s] = ws.catalogs.map((c) => c.id);
    expect(updateCatalog(ws.id, s, { alias: "ops" })).toBe(false);
    expect(updateCatalog(ws.id, s, { alias: "temp" })).toBe(false);
    expect(updateCatalog(ws.id, s, { alias: "sales_eu" })).toBe(true);
    expect(getWorkspace(ws.id)!.catalogs[0].alias).toBe("sales_eu");
  });

  test("the default rename handler confirms, then renames without rewriting", async () => {
    const ws = three();
    const [s] = ws.catalogs.map((c) => c.id);
    const asked: string[] = [];
    expect(await confirmAliasRenameWith((m) => { asked.push(m); return false; })(ws.id, s, "sales", "sales_eu")).toBe(false);
    expect(getWorkspace(ws.id)!.catalogs[0].alias).toBe("sales");
    expect(asked[0]).toBe(aliasRenameMessage("sales", "sales_eu"));
    expect(asked[0]).toContain("not rewritten");
    expect(await confirmAliasRenameWith(() => true)(ws.id, s, "sales", "sales_eu")).toBe(true);
    expect(getWorkspace(ws.id)!.catalogs[0].alias).toBe("sales_eu");
    // A taken alias is refused by the store even after the confirm.
    expect(await confirmAliasRenameWith(() => true)(ws.id, s, "sales_eu", "ops")).toBe(false);
  });
});

describe("duplicate", () => {
  test("new ids, same aliases, options, default, colours and enabled flags; always named", () => {
    const ws = three();
    const [s, o, h] = ws.catalogs.map((c) => c.id);
    updateCatalog(ws.id, o, { options: { region: "eu" }, rawOptions: "tags ['a']" });
    setDefaultCatalog(ws.id, o);
    setCatalogColor(ws.id, h, 5);
    setCatalogEnabled(ws.id, s, false);
    const copy = duplicateWorkspace(ws.id)!;
    expect(copy.id).not.toBe(ws.id);
    expect(copy.name).toBe("Finance (copy)");
    const source = getWorkspace(ws.id)!;
    expect(copy.catalogs.map((c) => c.alias)).toEqual(source.catalogs.map((c) => c.alias));
    expect(copy.catalogs.map((c) => c.url)).toEqual([A, B, C]);
    for (const c of copy.catalogs) expect(source.catalogs.some((x) => x.id === c.id)).toBe(false);
    expect(new Set(copy.catalogs.map((c) => c.id)).size).toBe(3);
    const ops = copy.catalogs[1];
    expect(ops.options).toEqual({ region: "eu" });
    expect(ops.rawOptions).toBe("tags ['a']");
    expect(copy.defaultCatalogId).toBe(ops.id);
    expect(copy.catalogs[2].color).toBe(5);
    expect(copy.catalogs[0].enabled).toBe(false);
    // The source is untouched.
    expect(source.catalogs.map((c) => c.id)).toEqual([s, o, h]);
    expect(source.name).toBe("Finance");
  });

  test("an untitled workspace's copy gets a name, so the two never share a fingerprint slot", () => {
    const ws = createWorkspace([{ url: A, catalogName: "sales" }]);
    expect(ws.name).toBeNull();
    expect(duplicateWorkspace(ws.id)!.name).toBe("sales (copy)");
  });

  test("copy names stay unique", () => {
    const ws = three();
    expect(duplicateWorkspace(ws.id)!.name).toBe("Finance (copy)");
    expect(duplicateWorkspace(ws.id)!.name).toBe("Finance (copy) (2)");
    expect(uniqueWorkspaceName("finance")).toBe("finance (2)");
    expect(uniqueWorkspaceName("Finance", ws.id)).toBe("Finance");
    expect(uniqueWorkspaceName("New")).toBe("New");
  });

  test("secrets are copied under the new ids by default, and survive deleting the source", () => {
    const ws = three();
    const sales = ws.catalogs[0];
    saveCatalogSecrets({ workspaceId: ws.id, catalogId: sales.id, url: A, catalogName: "sales" }, { api_key: "k-123" });
    const copy = duplicateWorkspace(ws.id)!;
    const copied = copy.catalogs[0];
    expect(catalogSecrets({ workspaceId: copy.id, catalogId: copied.id, url: A, catalogName: "sales" })).toEqual({ api_key: "k-123" });
    // Never in the record.
    expect(JSON.stringify(getWorkspace(copy.id))).not.toContain("k-123");
    deleteWorkspace(ws.id);
    expect(catalogSecrets({ workspaceId: copy.id, catalogId: copied.id, url: A, catalogName: "sales" })).toEqual({ api_key: "k-123" });
  });

  test("copySecrets: false leaves them behind", () => {
    const ws = three();
    const sales = ws.catalogs[0];
    saveCatalogSecrets({ workspaceId: ws.id, catalogId: sales.id, url: A, catalogName: "sales" }, { api_key: "k-123" });
    const copy = duplicateWorkspace(ws.id, { copySecrets: false })!;
    expect(catalogSecrets({ workspaceId: copy.id, catalogId: copy.catalogs[0].id, url: "", catalogName: "sales" })).toEqual({});
  });

  test("an unknown workspace duplicates to null", () => {
    expect(duplicateWorkspace("missing")).toBeNull();
  });
});

describe("option input kinds", () => {
  test("each spec type maps to its control", () => {
    expect(optionInputKind(spec({ name: "b", duckdbType: "BOOLEAN" }))).toBe("switch");
    expect(optionInputKind(spec({ name: "i", duckdbType: "INTEGER" }))).toBe("integer");
    expect(optionInputKind(spec({ name: "i", duckdbType: "UBIGINT" }))).toBe("integer");
    expect(optionInputKind(spec({ name: "i", duckdbType: "HUGEINT" }))).toBe("integer");
    expect(optionInputKind(spec({ name: "n", duckdbType: "DOUBLE" }))).toBe("number");
    expect(optionInputKind(spec({ name: "n", duckdbType: "DECIMAL(18,4)" }))).toBe("number");
    expect(optionInputKind(spec({ name: "d", duckdbType: "DATE" }))).toBe("date");
    expect(optionInputKind(spec({ name: "s", duckdbType: "VARCHAR" }))).toBe("text");
    expect(optionInputKind(spec({ name: "u", duckdbType: "UUID" }))).toBe("text");
    expect(optionInputKind(spec({ name: "l", duckdbType: "INTEGER[]" }))).toBe("duckdb");
    expect(optionInputKind(spec({ name: "st", duckdbType: "STRUCT<{a: BIGINT}>" }))).toBe("duckdb");
    expect(optionInputKind(spec({ name: "m", duckdbType: "MAP(VARCHAR, INTEGER)" }))).toBe("duckdb");
    expect(optionInputKind(spec({ name: "t", duckdbType: "TIMESTAMP" }))).toBe("duckdb");
    expect(optionInputKind(spec({ name: "iv", duckdbType: "INTERVAL" }))).toBe("duckdb");
  });

  test("a secret is masked whatever its type", () => {
    expect(optionInputKind(spec({ name: "pin", duckdbType: "INTEGER", secret: true }))).toBe("secret");
    expect(optionInputKind(spec({ name: "flag", duckdbType: "BOOLEAN", secret: true }))).toBe("secret");
  });

  test("stored options a server does not declare still get a row", () => {
    const rows = optionRows([spec({ name: "region" })], { region: "eu", extra: "1", api_token: "t" });
    expect(rows.map((r) => r.name)).toEqual(["region", "extra", "api_token"]);
    expect(rows.find((r) => r.name === "api_token")!.secret).toBe(true);
    expect(rows.find((r) => r.name === "extra")!.secret).toBe(false);
  });
});

describe("the SQL tab", () => {
  const specs = [spec({ name: "region" }), spec({ name: "limit_rows", duckdbType: "INTEGER" }), spec({ name: "api_key", secret: true })];

  test("renders non-secret values as quoted literals, plus pending raw text; never a secret", () => {
    const text = optionsToSqlText({ region: "o'hare", limit_rows: "10", api_key: "SECRET", empty: "" }, "tags ['a', 'b']", specs);
    expect(text).toBe("region 'o''hare', limit_rows '10', tags ['a', 'b']");
    expect(text).not.toContain("SECRET");
  });

  test("round-trips through the legacy parser", () => {
    const text = optionsToSqlText({ region: "eu", limit_rows: "10" }, "", specs);
    const back = sqlTextToOptions(text, { api_key: "SECRET" }, specs);
    expect(back.errors).toEqual([]);
    expect(back.values).toEqual({ api_key: "SECRET", region: "eu", limit_rows: "10" });
    expect(back.rawOptions).toBe("");
  });

  test("non-literal values are kept as raw text for constant-only evaluation, never as values", () => {
    const back = sqlTextToOptions("region 'eu', tags ['a', 'b'], since DATE '2024-01-01'", {}, specs);
    expect(back.errors).toEqual([]);
    expect(back.values).toEqual({ region: "eu" });
    expect(back.rawOptions).toBe("tags ['a', 'b'], since DATE '2024-01-01'");
  });

  test("text that is not name/value pairs is refused, not spliced", () => {
    const back = sqlTextToOptions("region 'eu'); DROP TABLE x; --", {}, specs);
    expect(back.errors.length).toBeGreaterThan(0);
    expect(back.values.region).toBeUndefined();
  });

  test("a secret typed as an expression is refused; as a plain string it is a value", () => {
    expect(sqlTextToOptions("api_key concat('a', 'b')", {}, specs).errors.join(" ")).toMatch(/secret/);
    expect(sqlTextToOptions("api_key 'abc'", {}, specs).values.api_key).toBe("abc");
  });

  test("a required option missing from the text is reported", () => {
    const req = [spec({ name: "region", required: true })];
    expect(sqlTextToOptions("", {}, req).errors).toEqual(["region is required."]);
  });
});

describe("the catalog draft", () => {
  const stored = draftOf({ alias: "sales", url: A, options: { region: "eu" } }, { api_key: "k" });

  test("starts clean, with secrets in the values", () => {
    expect(stored.values).toEqual({ region: "eu", api_key: "k" });
    expect(draftChanges(stored, stored).any).toBe(false);
  });

  test("names what changed; whitespace and empty values are not changes", () => {
    expect(draftChanges({ ...stored, alias: " sales " }, stored).any).toBe(false);
    expect(draftChanges({ ...stored, values: { ...stored.values, extra: "" } }, stored).any).toBe(false);
    expect(draftChanges({ ...stored, alias: "sales_eu" }, stored)).toMatchObject({ alias: true, url: false, options: false, any: true });
    expect(draftChanges({ ...stored, url: B }, stored)).toMatchObject({ url: true, any: true });
    expect(draftChanges({ ...stored, values: { region: "us", api_key: "k" } }, stored)).toMatchObject({ options: true });
    expect(draftChanges({ ...stored, sqlText: "region 'eu'" }, stored)).toMatchObject({ options: true });
  });

  test("URLs must be http(s) or grainlift", () => {
    expect(urlProblem("")).toMatch(/required/);
    expect(urlProblem("ftp://x")).toMatch(/http/);
    expect(urlProblem("https://x.test")).toBeNull();
    expect(urlProblem("grainlift+iroh://abc")).toBeNull();
  });

  test("the store takes a URL patch, ignoring a blank one", () => {
    const ws = three();
    const id = ws.catalogs[0].id;
    expect(updateCatalog(ws.id, id, { url: " http://moved.test " })).toBe(true);
    expect(getWorkspace(ws.id)!.catalogs[0].url).toBe("http://moved.test");
    updateCatalog(ws.id, id, { url: "  " });
    expect(getWorkspace(ws.id)!.catalogs[0].url).toBe("http://moved.test");
  });
});

describe("test connection text", () => {
  test("success, with and without a schema count", () => {
    expect(describeConnectionTest({ ok: true, latencyMs: 41.6, catalogFound: true, catalogs: ["sales"], schemaCount: 3 }, "sales"))
      .toBe("Connected in 42 ms · 3 schemas");
    expect(describeConnectionTest({ ok: true, latencyMs: 5, catalogFound: true, catalogs: ["sales"], schemaCount: 1 }, "sales"))
      .toBe("Connected in 5 ms · 1 schema");
    expect(describeConnectionTest({ ok: true, latencyMs: 5, catalogFound: true, catalogs: ["sales"], schemaCount: null, schemaNote: "needs options" }, "sales"))
      .toBe("Connected in 5 ms · needs options");
  });

  test("a missing catalog lists what the server has", () => {
    expect(describeConnectionTest({ ok: true, latencyMs: 9, catalogFound: false, catalogs: ["a", "b"], schemaCount: null }, "sales"))
      .toBe('Reachable in 9 ms, but it has no catalog named "sales" (it lists: a, b).');
  });

  test("failures carry the error text", () => {
    expect(describeConnectionTest({ ok: false, latencyMs: 120, error: "fetch failed", signInRequired: false }, "x")).toBe("Failed after 120 ms: fetch failed");
    expect(describeConnectionTest({ ok: false, latencyMs: 80, error: "401", signInRequired: true }, "x")).toBe("Needs sign-in (80 ms): 401");
  });
});

describe("names and palette", () => {
  test("a blank name is untitled", () => {
    expect(normalizeWorkspaceName("  ")).toBeNull();
    expect(normalizeWorkspaceName(" Q3 ")).toBe("Q3");
    expect(normalizeWorkspaceName("x".repeat(300))!.length).toBe(200);
  });

  test("every palette colour has a name", () => {
    expect(PALETTE_NAMES.length).toBe(PALETTE_SIZE);
  });
});
