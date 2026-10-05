import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { migrateToWorkspaces, MIGRATED_KEY } from "../../src/lib/workspace/migrate";
import { listWorkspaces, resetWorkspaceCache, setWorkspaceTestHooks } from "../../src/lib/workspace/store";
import { catalogSecrets, SECRET_STORE_KEY } from "../../src/lib/attach/secret-store";
import { clearLegacyScopes, setLegacyScope } from "../../src/lib/workspace/legacy-scope";
import { listEvidenceReports, saveEvidenceReport } from "../../src/lib/evidence/reports";
import { loadReportHistory } from "../../src/lib/evidence/revisions";
import { loadQueryHistory } from "../../src/lib/editor/query-history";
import { loadEditorState } from "../../src/lib/editor/editor-store";

// Stubbed storage, restored afterwards: Bun runs every unit test file in one
// global scope (CLAUDE.md, "Testing").
class MemoryStorage {
  map = new Map<string, string>();
  quota = Infinity;
  get length() { return this.map.size; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) {
    if (v.length > this.quota) throw new DOMException("full", "QuotaExceededError");
    this.map.set(k, v);
  }
  removeItem(k: string) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

const g = globalThis as { localStorage?: unknown };
const original = g.localStorage;
const mem = new MemoryStorage();
let ids = 0;

beforeAll(() => { g.localStorage = mem; });
afterAll(() => {
  g.localStorage = original;
  setWorkspaceTestHooks();
  resetWorkspaceCache();
  clearLegacyScopes();
});
beforeEach(() => {
  mem.clear();
  mem.quota = Infinity;
  ids = 0;
  setWorkspaceTestHooks({ newId: () => `id${++ids}`, now: () => 5_000 });
  resetWorkspaceCache();
  clearLegacyScopes();
});

const A = "http://a.test";
const B = "http://b.test";
const report = (id: string, serviceUrl: string, title = id) => ({
  version: 1, id, title, source: `# ${title}`, setupSql: "", serviceUrl, parameters: [], values: {}, createdAt: 1, updatedAt: 1,
});
const enc = encodeURIComponent;

function seedLegacy() {
  mem.setItem("vgi-recent-services", JSON.stringify([
    { url: A, catalogName: "sales", lastUsed: "2026-01-02T00:00:00Z", options: { region: "eu" } },
    // A pre-structured entry: its credential moves to the secret store on read.
    { url: B, catalogName: "ops", lastUsed: "2026-01-01T00:00:00Z", attachOptions: "api_key 'b-secret', max_rows 5" },
  ]));
  mem.setItem(`vgi-sql-editor-docs::${A}`, JSON.stringify({ version: 1, docs: [{ id: "d1", name: "Query 1", sql: "SELECT 42", createdAt: 1, updatedAt: 1 }], activeId: "d1" }));
  mem.setItem(`cupola.query-history.v1::${A}`, JSON.stringify([{ id: 1, timestamp: 1, sql: "SELECT 'from history'", executionTimeMs: 1, success: true, source: "editor" }]));
  mem.setItem(`cupola.evidence.report.v2:${enc(A)}:r1`, JSON.stringify(report("r1", A, "Sales report")));
  mem.setItem(`cupola.evidence.history.v1:${enc(A)}:r1`, JSON.stringify({ revisions: [], blobs: {} }));
  mem.setItem(`cupola.evidence.draft.v1:${enc(A)}:r2`, JSON.stringify({ savedAt: 2, report: report("r2", A, "Draft") }));
  mem.setItem(SECRET_STORE_KEY, JSON.stringify({ [JSON.stringify([A, "sales", "token"])]: "a-secret" }));
}

describe("workspace migration", () => {
  test("turns each recent server into an untitled single-catalog workspace", () => {
    seedLegacy();
    const result = migrateToWorkspaces();
    expect(result.ran).toBe(true);
    expect(result.workspaces).toBe(2);
    const workspaces = listWorkspaces();
    // Most recently used first; aliased under the old catalog name.
    expect(workspaces.map((w) => [w.name, w.catalogs.map((c) => [c.url, c.alias, c.catalogName])])).toEqual([
      [null, [[A, "sales", "sales"]]],
      [null, [[B, "ops", "ops"]]],
    ]);
    expect(workspaces[0].catalogs[0].options).toEqual({ region: "eu" });
    expect(workspaces[0].legacyServiceUrl).toBe(A);
    expect(workspaces[1].catalogs[0].options).toEqual({ max_rows: "5" });
    expect(mem.getItem(MIGRATED_KEY)).not.toBeNull();
  });

  test("re-keys editor tabs, history, reports, report history, drafts and secrets, keeping the old keys", () => {
    seedLegacy();
    migrateToWorkspaces();
    const [a, b] = listWorkspaces();
    expect(mem.getItem(`vgi-sql-editor-docs::${a.id}`)).toContain("SELECT 42");
    expect(mem.getItem(`cupola.query-history.v1::${a.id}`)).toContain("from history");
    const copied = JSON.parse(mem.getItem(`cupola.evidence.report.v2:${enc(a.id)}:r1`)!);
    expect(copied.workspaceId).toBe(a.id);
    expect(copied.title).toBe("Sales report");
    expect(mem.getItem(`cupola.evidence.history.v1:${enc(a.id)}:r1`)).not.toBeNull();
    expect(JSON.parse(mem.getItem(`cupola.evidence.draft.v1:${enc(a.id)}:r2`)!).report.workspaceId).toBe(a.id);
    const secrets = JSON.parse(mem.getItem(SECRET_STORE_KEY)!);
    expect(secrets[`${a.id}:${a.catalogs[0].id}:token`]).toBe("a-secret");
    expect(secrets[`${b.id}:${b.catalogs[0].id}:api_key`]).toBe("b-secret");
    // Old keys stay, read-only.
    expect(mem.getItem(`vgi-sql-editor-docs::${A}`)).not.toBeNull();
    expect(mem.getItem(`cupola.query-history.v1::${A}`)).not.toBeNull();
    expect(mem.getItem(`cupola.evidence.report.v2:${enc(A)}:r1`)).not.toBeNull();
    expect(secrets[JSON.stringify([A, "sales", "token"])]).toBe("a-secret");
    // The stores read it under the workspace.
    expect(listEvidenceReports(a.id).map((r) => r.id)).toEqual(["r1"]);
    expect(loadQueryHistory(a.id).map((e) => e.sql)).toEqual(["SELECT 'from history'"]);
    expect(loadEditorState(a.id).docs.map((d) => d.sql)).toEqual(["SELECT 42"]);
    expect(catalogSecrets({ workspaceId: b.id, catalogId: b.catalogs[0].id, url: B, catalogName: "ops" })).toEqual({ api_key: "b-secret" });
  });

  test("is idempotent: a second run changes nothing", () => {
    seedLegacy();
    migrateToWorkspaces();
    const snapshot = JSON.stringify([...mem.map.entries()].sort());
    resetWorkspaceCache();
    const again = migrateToWorkspaces();
    expect(again.ran).toBe(false);
    expect(JSON.stringify([...mem.map.entries()].sort())).toBe(snapshot);
  });

  test("never overwrites a key the workspace already has", () => {
    seedLegacy();
    migrateToWorkspaces();
    const [a] = listWorkspaces();
    mem.setItem(`cupola.query-history.v1::${a.id}`, "[]");
    mem.removeItem(MIGRATED_KEY);
    resetWorkspaceCache();
    migrateToWorkspaces();
    expect(mem.getItem(`cupola.query-history.v1::${a.id}`)).toBe("[]");
    expect(listWorkspaces()).toHaveLength(2);
  });

  test("with nothing to migrate it only sets the marker", () => {
    expect(migrateToWorkspaces().workspaces).toBe(0);
    expect(listWorkspaces()).toEqual([]);
    expect(mem.getItem(MIGRATED_KEY)).not.toBeNull();
  });

  test("the legacy fallback reads URL-keyed data written after the migration, and writes only the workspace key", () => {
    migrateToWorkspaces();
    mem.setItem(`cupola.evidence.report.v2:${enc(A)}:late`, JSON.stringify(report("late", A, "Late report")));
    mem.setItem(`cupola.evidence.history.v1:${enc(A)}:late`, JSON.stringify({ revisions: [], blobs: {} }));
    setLegacyScope("ws-1", A);
    const listed = listEvidenceReports("ws-1");
    expect(listed.map((r) => [r.id, r.workspaceId])).toEqual([["late", "ws-1"]]);
    expect(loadReportHistory("ws-1", "late").revisions).toEqual([]);
    saveEvidenceReport({ ...listed[0], title: "Saved under the workspace" });
    expect(JSON.parse(mem.getItem(`cupola.evidence.report.v2:ws-1:late`)!).title).toBe("Saved under the workspace");
    expect(JSON.parse(mem.getItem(`cupola.evidence.report.v2:${enc(A)}:late`)!).title).toBe("Late report");
    // The workspace's copy wins.
    expect(listEvidenceReports("ws-1").map((r) => r.title)).toEqual(["Saved under the workspace"]);
  });

  test("a storage too full to copy into still finishes, counting what failed", () => {
    seedLegacy();
    mem.setItem(`cupola.evidence.report.v2:${enc(A)}:big`, JSON.stringify({ ...report("big", A), source: "x".repeat(5_000) }));
    mem.quota = 3_000;
    const result = migrateToWorkspaces();
    expect(result.ran).toBe(true);
    expect(result.failed).toBeGreaterThan(0);
  });
});
