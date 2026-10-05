import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  applyImport,
  buildWorkspaceFile,
  IMPORTED_SUFFIX,
  parseWorkspaceImport,
  planImport,
  serializeWorkspaceFile,
  storedSecretNames,
  workspaceFileName,
  WORKSPACE_SCHEMA_URL,
  type ImportWorkspace,
} from "../../src/lib/workspace/file";
import {
  createWorkspace,
  getOverlay,
  getWorkspace,
  listWorkspaces,
  resetWorkspaceCache,
  setCatalogColor,
  setCatalogEnabled,
  setWorkspaceTestHooks,
  type Workspace,
} from "../../src/lib/workspace/store";
import { catalogSecrets, saveCatalogSecrets } from "../../src/lib/attach/secret-store";
import { decodeWorkspaceToken, encodeWorkspaceToken } from "../../src/lib/workspace/codec";
import { validateWorkspaceFile } from "../../src/lib/workspace/spec";

class MemoryStorage {
  map = new Map<string, string>();
  get length() { return this.map.size; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

// Bun runs every unit test file in one global scope: restore it afterwards.
const g = globalThis as { localStorage?: unknown };
const original = g.localStorage;
const mem = new MemoryStorage();
let ids = 0;
const newId = () => `id${++ids}`;

beforeAll(() => { g.localStorage = mem; });
afterAll(() => {
  g.localStorage = original;
  setWorkspaceTestHooks();
  resetWorkspaceCache();
});
beforeEach(() => {
  mem.clear();
  ids = 0;
  setWorkspaceTestHooks({ newId, now: () => 1_000 });
  resetWorkspaceCache();
});

function finance(): Workspace {
  return createWorkspace([
    { id: "c1", url: "https://a.example/vgi", catalogName: "sales", alias: "sales", options: { region: "eu" } },
    { id: "c2", url: "grainlift+https://gw.example", catalogName: "sqlite", alias: "gw", target: "sqlite", dataVersionSpec: "v7" },
  ], { id: "w1", name: "Finance", defaultCatalogId: "c2", defaultSchema: "main" });
}

describe("export", () => {
  test("a file holds the portable record only: no secrets, no personal state", () => {
    const ws = finance();
    setCatalogColor(ws.id, "c1", 5);
    setCatalogEnabled(ws.id, "c2", false);
    saveCatalogSecrets({ workspaceId: ws.id, catalogId: "c1", url: "https://a.example/vgi", catalogName: "sales" }, { api_key: "s3cret-value" });
    const { file, notes } = buildWorkspaceFile([getWorkspace("w1")!], storedSecretNames);
    expect(notes).toEqual([]);
    expect(file).toEqual({
      $schema: WORKSPACE_SCHEMA_URL,
      format: "cupola-workspaces",
      version: 1,
      workspaces: [{
        id: "w1", name: "Finance", defaultCatalogId: "c2", defaultSchema: "main",
        catalogs: [
          { id: "c1", url: "https://a.example/vgi", catalogName: "sales", alias: "sales", options: { region: "eu" }, secrets: ["api_key"] },
          { id: "c2", url: "grainlift+https://gw.example", catalogName: "sqlite", alias: "gw", target: "sqlite", dataVersionSpec: "v7" },
        ],
      }],
    });
    const text = serializeWorkspaceFile(file);
    expect(text).not.toContain("s3cret-value");
    expect(text).not.toMatch(/color|enabled|expanded/);
  });

  test("an option named like a secret is never written, even if stored", () => {
    const ws = finance();
    const tampered = { ...ws, catalogs: ws.catalogs.map((c) => c.id === "c1" ? { ...c, options: { region: "eu", pin: "1234" } } : c) };
    const { file } = buildWorkspaceFile([tampered], () => ["pin"]);
    expect(file.workspaces[0].catalogs[0].options).toEqual({ region: "eu" });
    expect(file.workspaces[0].catalogs[0].secrets).toEqual(["pin"]);
  });

  test("raw options awaiting evaluation and unnamed catalogs are left out, with notes", () => {
    const ws = createWorkspace([
      { id: "c1", url: "https://a.example", catalogName: "sales", rawOptions: "dates ['2024-01-01'::DATE]" },
      { id: "c2", url: "https://b.example", catalogName: "" },
    ], { id: "w2", name: "Mixed", defaultCatalogId: "c2" });
    const { file, notes } = buildWorkspaceFile([ws]);
    expect(file.workspaces[0].catalogs.map((c) => c.id)).toEqual(["c1"]);
    expect(file.workspaces[0].defaultCatalogId).toBeUndefined();
    expect(notes.join("\n")).toContain("not yet evaluated");
    expect(notes.join("\n")).toContain("never connected");
    const empty = createWorkspace([{ id: "c3", url: "https://c.example", catalogName: "" }], { id: "w3", name: "Empty" });
    const all = buildWorkspaceFile([ws, empty]);
    expect(all.file.workspaces).toHaveLength(1);
    expect(all.notes.join("\n")).toContain("Empty: not included");
  });

  test("the file is the #ws= payload", async () => {
    const { file } = buildWorkspaceFile([finance()]);
    const decoded = await decodeWorkspaceToken(await encodeWorkspaceToken(file));
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.file.workspaces).toEqual(file.workspaces);
    expect(validateWorkspaceFile(JSON.parse(serializeWorkspaceFile(file))).ok).toBe(true);
  });

  test("file names", () => {
    const ws = finance();
    expect(workspaceFileName([ws])).toBe("finance.cupola-workspaces.json");
    expect(workspaceFileName([ws, ws])).toBe("cupola-workspaces.cupola-workspaces.json");
    expect(workspaceFileName([{ ...ws, name: "Ünïcode / Report!" }], ".sql")).toBe("unicode-report.sql");
  });
});

describe("parsing an import", () => {
  test("accepts a file, a bare workspace, or an array", () => {
    const one = { name: "A", catalogs: [{ url: "https://a", catalogName: "x" }] };
    expect(parseWorkspaceImport(JSON.stringify({ format: "cupola-workspaces", version: 1, workspaces: [one] }), newId).workspaces).toHaveLength(1);
    expect(parseWorkspaceImport(JSON.stringify(one), newId).workspaces).toHaveLength(1);
    expect(parseWorkspaceImport(JSON.stringify([one, one]), newId).workspaces).toHaveLength(2);
  });

  test("each workspace is validated on its own", () => {
    const parsed = parseWorkspaceImport(JSON.stringify([
      { name: "Good", catalogs: [{ url: "https://a", catalogName: "x" }] },
      { name: "Bad", catalogs: [{ url: "file:///etc", catalogName: "x" }] },
      { catalogs: [] },
    ]), newId);
    expect(parsed.workspaces.map((w) => w.workspace.name)).toEqual(["Good"]);
    expect(parsed.errors).toHaveLength(2);
    expect(parsed.errors[0]).toStartWith("“Bad”:");
    expect(parsed.errors[1]).toStartWith("Workspace 3:");
  });

  test("ids are filled in; secrets in options are dropped with a note", () => {
    const parsed = parseWorkspaceImport(JSON.stringify({ catalogs: [{ url: "https://a", catalogName: "x", options: { token: "t", region: "eu" } }] }), newId);
    const ws = parsed.workspaces[0];
    expect(ws.workspace.id).toBeTruthy();
    expect(ws.workspace.catalogs[0].id).toBeTruthy();
    expect(ws.workspace.catalogs[0].options).toEqual({ region: "eu" });
    expect(ws.notes.join(" ")).toContain("credential");
  });

  test("an option listed as a secret loses its value; secret names are de-duplicated", () => {
    const parsed = parseWorkspaceImport(JSON.stringify({ catalogs: [{ url: "https://a", catalogName: "x", options: { pin: "1234", region: "eu" }, secrets: ["pin", "PIN", "a b"] }] }), newId);
    const c = parsed.workspaces[0].workspace.catalogs[0];
    expect(c.options).toEqual({ region: "eu" });
    expect(c.secrets).toEqual(["pin"]);
    expect(JSON.stringify(parsed)).not.toContain("1234");
    expect(parsed.workspaces[0].notes.join(" ")).toContain('"pin" is secret');
  });

  test("refuses what is not a workspace file", () => {
    expect(() => parseWorkspaceImport("not json")).toThrow("not valid JSON");
    expect(() => parseWorkspaceImport(JSON.stringify({ hello: 1 }))).toThrow("not a Cupola workspace file");
    expect(() => parseWorkspaceImport(JSON.stringify({ format: "cupola-workspaces", version: 9, workspaces: [] }))).toThrow("newer version");
    expect(() => parseWorkspaceImport("[]")).toThrow("no workspaces");
  });
});

function incomingFrom(ws: Workspace): ImportWorkspace {
  const { file } = buildWorkspaceFile([ws], storedSecretNames);
  return parseWorkspaceImport(serializeWorkspaceFile(file), newId).workspaces[0];
}

describe("planning", () => {
  test("new, identical and conflicting by id", () => {
    const ws = finance();
    const same = incomingFrom(ws);
    const changed = incomingFrom(ws);
    changed.workspace.catalogs[0].options = { region: "us" };
    const fresh = parseWorkspaceImport(JSON.stringify({ id: "other", catalogs: [{ url: "https://a", catalogName: "x" }] }), newId).workspaces[0];
    const plan = planImport(listWorkspaces(), [same, changed, fresh]);
    expect(plan.map((p) => p.status)).toEqual(["identical", "conflict", "new"]);
    expect(plan[1].existing?.id).toBe("w1");
  });

  test("identity ignores catalog ids, colours and secrets; pending expressions always conflict", () => {
    const ws = finance();
    setCatalogColor(ws.id, "c1", 7);
    const incoming = incomingFrom(getWorkspace("w1")!);
    incoming.workspace.catalogs = incoming.workspace.catalogs.map((c, i) => ({ ...c, id: `new${i}` }));
    incoming.workspace.defaultCatalogId = "new1";
    expect(planImport(listWorkspaces(), [incoming])[0].status).toBe("identical");
    const pending = { ...incomingFrom(ws), rawOptions: { c1: "dates [1, 2]" } };
    expect(planImport(listWorkspaces(), [pending])[0].status).toBe("conflict");
  });

  test("a changed name or default is a conflict", () => {
    const ws = finance();
    const renamed = incomingFrom(ws);
    renamed.workspace.name = "Finance 2";
    const otherDefault = incomingFrom(ws);
    otherDefault.workspace.defaultCatalogId = "c1";
    expect(planImport(listWorkspaces(), [renamed, otherDefault]).map((p) => p.status)).toEqual(["conflict", "conflict"]);
  });

  test("the same id twice in one import: the second conflicts", () => {
    const a = parseWorkspaceImport(JSON.stringify({ id: "dup", catalogs: [{ url: "https://a", catalogName: "x" }] }), newId).workspaces[0];
    expect(planImport([], [a, a]).map((p) => p.status)).toEqual(["new", "conflict"]);
  });
});

describe("applying", () => {
  test("a new workspace is saved under its id and name; secrets are listed as needed", () => {
    const parsed = parseWorkspaceImport(JSON.stringify({ id: "wn", name: "New", catalogs: [{ id: "k1", url: "https://a.example", catalogName: "x", alias: "x", secrets: ["api_key"] }] }), newId);
    const result = applyImport(planImport(listWorkspaces(), parsed.workspaces));
    expect(result.imported).toEqual([{ id: "wn", name: "New", action: "new" }]);
    expect(result.secretsNeeded).toEqual([{ workspaceId: "wn", workspaceName: "New", catalogId: "k1", alias: "x", option: "api_key" }]);
    const saved = getWorkspace("wn")!;
    expect(saved.name).toBe("New");
    expect(saved.catalogs[0].options).toEqual({});
    expect(catalogSecrets({ workspaceId: "wn", catalogId: "k1", url: "https://a.example", catalogName: "x" })).toEqual({});
  });

  test("an untitled import is named after its catalogs, so it is kept", () => {
    const parsed = parseWorkspaceImport(JSON.stringify({ catalogs: [{ url: "https://a", catalogName: "sales" }] }), newId);
    const result = applyImport(planImport([], parsed.workspaces));
    expect(getWorkspace(result.imported[0].id)?.name).toBe("sales");
  });

  test("identical is skipped", () => {
    const ws = finance();
    const result = applyImport(planImport(listWorkspaces(), [incomingFrom(ws)]));
    expect(result.skipped).toEqual([{ id: "w1", name: "Finance" }]);
    expect(result.imported).toEqual([]);
    expect(listWorkspaces()).toHaveLength(1);
  });

  test("replace keeps the id, the overlay of surviving catalogs, and secrets only where the server is unchanged", () => {
    const ws = finance();
    setCatalogColor(ws.id, "c1", 6);
    setCatalogEnabled(ws.id, "c2", false);
    saveCatalogSecrets({ workspaceId: "w1", catalogId: "c1", url: "https://a.example/vgi", catalogName: "sales" }, { api_key: "keep-me" });
    saveCatalogSecrets({ workspaceId: "w1", catalogId: "c2", url: "grainlift+https://gw.example", catalogName: "sqlite" }, { password: "drop-me" });
    const incoming = incomingFrom(getWorkspace("w1")!);
    incoming.workspace.catalogs[0].options = { region: "us" };
    // The same catalog id now points at a different server.
    incoming.workspace.catalogs[1].url = "grainlift+https://evil.example";
    const result = applyImport(planImport(listWorkspaces(), [incoming]), () => "replace");
    expect(result.imported).toEqual([{ id: "w1", name: "Finance", action: "replace" }]);
    const saved = getWorkspace("w1")!;
    expect(saved.catalogs[0].options).toEqual({ region: "us" });
    expect(saved.catalogs[0].color).toBe(6);
    expect(saved.catalogs[1].enabled).toBe(false);
    expect(catalogSecrets({ workspaceId: "w1", catalogId: "c1", url: saved.catalogs[0].url, catalogName: "sales" })).toEqual({ api_key: "keep-me" });
    expect(catalogSecrets({ workspaceId: "w1", catalogId: "c2", url: saved.catalogs[1].url, catalogName: "sqlite" })).toEqual({});
    // The kept secret is not asked for; the dropped one is.
    expect(result.secretsNeeded.map((s) => `${s.alias}.${s.option}`)).toEqual(["gw.password"]);
    expect(listWorkspaces()).toHaveLength(1);
  });

  test("keep both saves a copy under a new id, suffixed", () => {
    const ws = finance();
    const incoming = incomingFrom(ws);
    incoming.workspace.name = "Finance";
    incoming.workspace.defaultSchema = "other";
    const result = applyImport(planImport(listWorkspaces(), [incoming]), () => "keep-both");
    expect(result.imported).toHaveLength(1);
    const copy = result.imported[0];
    expect(copy.action).toBe("copy");
    expect(copy.id).not.toBe("w1");
    expect(copy.name).toBe(`Finance${IMPORTED_SUFFIX}`);
    expect(getWorkspace("w1")?.defaultSchema).toBe("main");
    expect(getWorkspace(copy.id)?.defaultSchema).toBe("other");
    expect(getOverlay(copy.id).catalogs.c1).toBeDefined();
  });

  test("raw options from a script are stored for evaluation at connect time", () => {
    const parsed = parseWorkspaceImport(JSON.stringify({ id: "wr", name: "R", catalogs: [{ id: "k", url: "https://a", catalogName: "x" }] }), newId).workspaces[0];
    applyImport(planImport([], [{ ...parsed, rawOptions: { k: "dates ['2024-01-01'::DATE]" } }]));
    expect(getWorkspace("wr")?.catalogs[0].rawOptions).toBe("dates ['2024-01-01'::DATE]");
  });

  test("aliases the store has to move are reported", () => {
    const parsed = parseWorkspaceImport(JSON.stringify({ name: "M", catalogs: [{ url: "https://a", catalogName: "memory", alias: "memory" }] }), newId);
    const result = applyImport(planImport([], parsed.workspaces));
    expect(result.notes.join("\n")).toContain('attached as "memory_2"');
  });
});
