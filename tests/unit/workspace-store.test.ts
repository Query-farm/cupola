import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  addCatalog,
  catalogOptionSink,
  createWorkspace,
  deleteWorkspace,
  fingerprintOf,
  getOverlay,
  getWorkspace,
  lastNamedWorkspace,
  lastSaveError,
  listWorkspaces,
  MAX_UNTITLED,
  namedWorkspacesWith,
  nextColor,
  openServiceWorkspace,
  openUntitled,
  removeCatalog,
  renameWorkspace,
  resetWorkspaceCache,
  restoreCatalog,
  setCatalogColor,
  setCatalogEnabled,
  setDefaultCatalog,
  setExpandedCatalogs,
  setWorkspaceTestHooks,
  toActiveWorkspace,
  updateCatalog,
  WORKSPACE_OVERLAY_KEY,
  WORKSPACES_KEY,
} from "../../src/lib/workspace/store";
import { SECRET_STORE_KEY, saveSecrets } from "../../src/lib/attach/secret-store";

// A whole Storage (length/key included), so code that walks the keys works.
// Bun runs every unit test file in one global scope: restore it afterwards.
class MemoryStorage {
  map = new Map<string, string>();
  quota = Infinity;
  get length() { return this.map.size; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) {
    const size = [...this.map.entries()].filter(([key]) => key !== k).reduce((n, [key, value]) => n + key.length + value.length, 0) + k.length + v.length;
    if (size > this.quota) throw new DOMException("full", "QuotaExceededError");
    this.map.set(k, v);
  }
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
  mem.quota = Infinity;
  ids = 0;
  now = 1_000;
  setWorkspaceTestHooks({ newId: () => `id${++ids}`, now: () => (now += 10) });
  resetWorkspaceCache();
});

const A = "http://a.test";
const B = "http://b.test";

describe("workspace store", () => {
  test("creates, persists and reloads a workspace with aliases assigned once", () => {
    const ws = createWorkspace([{ url: A, catalogName: "sales" }, { url: B, catalogName: "sales" }], { name: "Finance" });
    expect(ws.catalogs.map((c) => c.alias)).toEqual(["sales", "sales_2"]);
    expect(ws.defaultCatalogId).toBe(ws.catalogs[0].id);
    resetWorkspaceCache();
    const again = getWorkspace(ws.id)!;
    expect(again.name).toBe("Finance");
    expect(again.catalogs.map((c) => [c.alias, c.url])).toEqual([["sales", A], ["sales_2", B]]);
  });

  test("keeps personal fields in the overlay, apart from the portable record", () => {
    const ws = createWorkspace([{ url: A, catalogName: "sales" }, { url: B, catalogName: "ops" }]);
    setCatalogColor(ws.id, ws.catalogs[1].id, 5);
    setCatalogEnabled(ws.id, ws.catalogs[1].id, false);
    setExpandedCatalogs(ws.id, ["sales"]);
    const portable = mem.getItem(WORKSPACES_KEY)!;
    expect(portable).not.toContain('"color"');
    expect(portable).not.toContain('"enabled"');
    expect(portable).not.toContain('"expanded"');
    const overlay = JSON.parse(mem.getItem(WORKSPACE_OVERLAY_KEY)!);
    expect(overlay.workspaces[ws.id].catalogs[ws.catalogs[1].id]).toEqual({ color: 5, enabled: false });
    resetWorkspaceCache();
    const again = getWorkspace(ws.id)!;
    expect(again.catalogs[1].color).toBe(5);
    expect(again.catalogs[1].enabled).toBe(false);
    expect(getOverlay(ws.id).expanded).toEqual(["sales"]);
    // A disabled catalog is kept, but not attached.
    expect(toActiveWorkspace(again, "link").catalogs.map((c) => c.alias)).toEqual(["sales"]);
  });

  test("colours go to the least-used palette entry", () => {
    expect(nextColor([])).toBe(0);
    expect(nextColor([0, 1, 2])).toBe(3);
    expect(nextColor([0, 1, 2, 3, 4, 5, 6, 7])).toBe(0);
    const ws = createWorkspace([{ url: A, catalogName: "a" }, { url: B, catalogName: "b" }]);
    expect(ws.catalogs.map((c) => c.color)).toEqual([0, 1]);
  });

  test("untitled workspaces are de-duplicated by the fingerprint of their catalog set", () => {
    const first = openUntitled([{ url: A, catalogName: "sales" }, { url: B, catalogName: "ops" }]);
    expect(first.created).toBe(true);
    // Order, a trailing slash and the host's case do not matter; aliases and options do not either.
    const second = openUntitled([{ url: "HTTP://B.TEST/", catalogName: "OPS", alias: "x" }, { url: A, catalogName: "sales", options: { a: "1" } }]);
    expect(second.created).toBe(false);
    expect(second.workspace.id).toBe(first.workspace.id);
    expect(listWorkspaces()).toHaveLength(1);
    expect(fingerprintOf([{ url: A, catalogName: "s" }])).not.toBe(fingerprintOf([{ url: A, catalogName: "s", target: "t" }]));
  });

  test("a named workspace is never the untitled match, and a ?service= redirect never changes it", () => {
    const named = createWorkspace([{ url: A, catalogName: "sales" }], { name: "Mine" });
    const before = JSON.stringify(getWorkspace(named.id));
    const opened = openServiceWorkspace(A, undefined);
    expect(opened.created).toBe(true);
    expect(opened.workspace.id).not.toBe(named.id);
    expect(opened.workspace.name).toBeNull();
    expect(opened.workspace.legacyServiceUrl).toBe(A);
    // The service catalog's name is not known yet.
    expect(opened.workspace.catalogs[0].alias).toBe("");
    expect(JSON.stringify(getWorkspace(named.id))).toBe(before);
    expect(namedWorkspacesWith(A).map((w) => w.id)).toEqual([named.id]);
    expect(lastNamedWorkspace()?.id).toBe(named.id);
    // Redirected again: the same untitled workspace.
    expect(openServiceWorkspace(`${A}/`, undefined).workspace.id).toBe(opened.workspace.id);
  });

  test("keeps at most MAX_UNTITLED untitled workspaces and remembers a pruned one's id", () => {
    const named = createWorkspace([{ url: A, catalogName: "keep" }], { name: "Named" });
    const made: string[] = [];
    for (let i = 0; i < MAX_UNTITLED + 2; i++) made.push(openUntitled([{ url: `http://h${i}.test`, catalogName: "c" }]).workspace.id);
    const untitled = listWorkspaces().filter((w) => w.name === null);
    expect(untitled).toHaveLength(MAX_UNTITLED);
    expect(getWorkspace(named.id)).not.toBeNull();
    expect(getWorkspace(made[0])).toBeNull();
    // Reopening the first catalog set brings its old id back (its data is keyed by it).
    const back = openUntitled([{ url: "http://h0.test", catalogName: "c" }]);
    expect(back.created).toBe(true);
    expect(back.workspace.id).toBe(made[0]);
  });

  test("rename names an untitled workspace; lastOpenedAt is recorded", () => {
    const ws = openUntitled([{ url: A, catalogName: "sales" }]).workspace;
    const opened = ws.lastOpenedAt;
    renameWorkspace(ws.id, "  Q3  ");
    expect(getWorkspace(ws.id)!.name).toBe("Q3");
    expect(openUntitled([{ url: A, catalogName: "sales" }]).created).toBe(true);
    openServiceWorkspace(B, undefined);
    expect(listWorkspaces()[0].lastOpenedAt).toBeGreaterThan(opened);
    renameWorkspace(ws.id, "");
    expect(getWorkspace(ws.id)!.name).toBeNull();
  });

  test("add, detach with undo, default, and alias validation", () => {
    const ws = createWorkspace([{ url: A, catalogName: "sales" }]);
    const added = addCatalog(ws.id, { url: B, catalogName: "sales" })!;
    expect(added.alias).toBe("sales_2");
    expect(added.color).toBe(1);
    setDefaultCatalog(ws.id, added.id);
    expect(getWorkspace(ws.id)!.defaultCatalogId).toBe(added.id);
    expect(updateCatalog(ws.id, added.id, { alias: "memory" })).toBe(false);
    expect(updateCatalog(ws.id, added.id, { alias: "SALES" })).toBe(false);
    expect(updateCatalog(ws.id, added.id, { alias: "ops" })).toBe(true);
    const removed = removeCatalog(ws.id, added.id)!;
    expect(removed.wasDefault).toBe(true);
    expect(getWorkspace(ws.id)!.defaultCatalogId).toBe(ws.catalogs[0].id);
    restoreCatalog(ws.id, removed.catalog, removed.index, removed.wasDefault);
    const back = getWorkspace(ws.id)!;
    expect(back.catalogs.map((c) => c.alias)).toEqual(["sales", "ops"]);
    expect(back.defaultCatalogId).toBe(added.id);
    expect(back.catalogs[1].color).toBe(1);
  });

  test("a catalog's option sink stores options in the record and secrets apart, with the old keys as fallback", () => {
    saveSecrets(A, "sales", { api_key: "old-secret" });
    const ws = createWorkspace([{ url: A, catalogName: "sales" }]);
    const sink = catalogOptionSink(ws.id, ws.catalogs[0].id);
    expect(sink.secrets("sales")).toEqual({ api_key: "old-secret" });
    sink.save("sales", { options: { region: "eu" } });
    sink.saveSecrets("sales", { api_key: "new-secret" });
    expect(getWorkspace(ws.id)!.catalogs[0].options).toEqual({ region: "eu" });
    expect(mem.getItem(WORKSPACES_KEY)).not.toContain("secret");
    const secrets = JSON.parse(mem.getItem(SECRET_STORE_KEY)!);
    expect(secrets[`${ws.id}:${ws.catalogs[0].id}:api_key`]).toBe("new-secret");
    expect(sink.secrets("sales")).toEqual({ api_key: "new-secret" });
    // Clearing hides the old key's value without deleting the old key.
    sink.clear();
    expect(sink.secrets("sales")).toEqual({});
    expect(JSON.stringify(JSON.parse(mem.getItem(SECRET_STORE_KEY)!))).toContain("old-secret");
    deleteWorkspace(ws.id);
    expect(mem.getItem(SECRET_STORE_KEY)).not.toContain(ws.id);
  });

  test("a full storage retires untitled workspaces first, then says so", () => {
    const named = createWorkspace([{ url: A, catalogName: "a" }], { name: "Named" });
    openUntitled([{ url: B, catalogName: "b" }]);
    mem.quota = (mem.getItem(WORKSPACES_KEY)!.length + mem.getItem(WORKSPACE_OVERLAY_KEY)!.length) + WORKSPACES_KEY.length + WORKSPACE_OVERLAY_KEY.length + 20;
    renameWorkspace(named.id, "A much longer name that needs a few more bytes");
    expect(listWorkspaces().some((w) => w.name === null)).toBe(false);
    expect(getWorkspace(named.id)!.name).toContain("longer");
    mem.quota = 10;
    renameWorkspace(named.id, "Still renamed in memory");
    expect(getWorkspace(named.id)!.name).toBe("Still renamed in memory");
    expect(lastSaveError()).toContain("full");
  });
});
