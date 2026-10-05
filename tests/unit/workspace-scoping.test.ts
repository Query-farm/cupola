import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { aliasProblem } from "../../src/lib/workspace/aliases";
import { clearLegacyScopes, setLegacyScope } from "../../src/lib/workspace/legacy-scope";
import { addQueryHistoryEntry, loadAllQueryHistories, loadQueryHistory } from "../../src/lib/editor/query-history";
import { loadEditorState, saveEditorState } from "../../src/lib/editor/editor-store";
import { deleteEvidenceReport, listEvidenceReports, listUnsavedDrafts, loadRecoveryDraft, reportScope, type EvidenceReport } from "../../src/lib/evidence/reports";
import { planImport } from "../../src/lib/evidence/report-file";
import { engine } from "../../src/lib/shell-bridge";

// Per-workspace scoping of the stores that used to be keyed by service URL,
// with the old keys as a read-only fallback. Stubbed storage, restored
// afterwards (Bun shares one global scope across test files).
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
beforeAll(() => { g.localStorage = mem; });
afterAll(() => { g.localStorage = original; clearLegacyScopes(); });
beforeEach(() => { mem.clear(); clearLegacyScopes(); });

const URL_A = "http://a.test";
const enc = encodeURIComponent;
const report = (id: string, extra: Partial<EvidenceReport> = {}): EvidenceReport => ({
  version: 1, id, title: id, source: `# ${id}`, setupSql: "", serviceUrl: URL_A, parameters: [], values: {}, createdAt: 1, updatedAt: 1, ...extra,
});

describe("alias validation", () => {
  test("refuses empty, reserved, invalid and taken aliases", () => {
    expect(aliasProblem("", [])).toContain("required");
    expect(aliasProblem("memory", [])).toContain("reserved");
    expect(aliasProblem("1abc", [])).toContain("Letters");
    expect(aliasProblem("Sales", ["sales"])).toContain("already used");
    expect(aliasProblem("sales_2", ["sales"])).toBeNull();
  });
});

describe("query history per workspace", () => {
  test("reads the legacy URL list until the workspace records its own", () => {
    mem.setItem(`cupola.query-history.v1::${URL_A}`, JSON.stringify([{ id: 1, timestamp: 1, sql: "SELECT 'old'", executionTimeMs: 1, success: true }]));
    setLegacyScope("ws-h1", URL_A);
    expect(loadQueryHistory("ws-h1").map((e) => e.sql)).toEqual(["SELECT 'old'"]);
    addQueryHistoryEntry("ws-h1", { id: 2, timestamp: 2, sql: "SELECT 'new'", executionTimeMs: 1, success: true });
    expect(JSON.parse(mem.getItem("cupola.query-history.v1::ws-h1")!).map((e: { sql: string }) => e.sql)).toEqual(["SELECT 'new'", "SELECT 'old'"]);
    // The old key is never written.
    expect(JSON.parse(mem.getItem(`cupola.query-history.v1::${URL_A}`)!)).toHaveLength(1);
  });

  test("All workspaces lists every known workspace's entries, newest first", () => {
    addQueryHistoryEntry("ws-x", { id: 1, timestamp: 10, sql: "SELECT 'x'", executionTimeMs: 1, success: true });
    addQueryHistoryEntry("ws-y", { id: 1, timestamp: 20, sql: "SELECT 'y'", executionTimeMs: 1, success: true });
    mem.setItem("cupola.query-history.v1::http://unknown.test", JSON.stringify([{ id: 1, timestamp: 30, sql: "SELECT 'stray'", executionTimeMs: 1, success: true }]));
    const all = loadAllQueryHistories((scope) => scope.startsWith("ws-"));
    expect(all.map((r) => [r.scope, r.entry.sql])).toEqual([["ws-y", "SELECT 'y'"], ["ws-x", "SELECT 'x'"]]);
  });
});

describe("editor tabs per workspace", () => {
  test("fall back to the legacy URL's tabs, and save under the workspace", () => {
    mem.setItem(`vgi-sql-editor-docs::${URL_A}`, JSON.stringify({ version: 1, docs: [{ id: "d", name: "Query 1", sql: "SELECT 1", createdAt: 1, updatedAt: 1 }], activeId: "d" }));
    setLegacyScope("ws-e", URL_A);
    const state = loadEditorState("ws-e");
    expect(state.docs[0].sql).toBe("SELECT 1");
    saveEditorState({ ...state, docs: [{ ...state.docs[0], sql: "SELECT 2" }] }, "ws-e");
    expect(mem.getItem("vgi-sql-editor-docs::ws-e")).toContain("SELECT 2");
    expect(mem.getItem(`vgi-sql-editor-docs::${URL_A}`)).toContain("SELECT 1");
  });
});

describe("Evidence reports per workspace", () => {
  test("a workspace sees its own reports and its legacy URL's, not another service's", () => {
    mem.setItem(`cupola.evidence.report.v2:${enc(URL_A)}:old`, JSON.stringify(report("old")));
    mem.setItem(`cupola.evidence.report.v2:${enc("http://b.test")}:other`, JSON.stringify(report("other", { serviceUrl: "http://b.test" })));
    mem.setItem("cupola.evidence.report.v2:ws-r:mine", JSON.stringify(report("mine", { workspaceId: "ws-r" })));
    setLegacyScope("ws-r", URL_A);
    const listed = listEvidenceReports("ws-r");
    expect(listed.map((r) => r.id).sort()).toEqual(["mine", "old"]);
    expect(listed.every((r) => reportScope(r) === "ws-r")).toBe(true);
    // A workspace without that legacy URL does not see it.
    expect(listEvidenceReports("ws-elsewhere")).toEqual([]);
  });

  test("deleting removes the workspace copy and the legacy one, so it does not come back", () => {
    mem.setItem(`cupola.evidence.report.v2:${enc(URL_A)}:gone`, JSON.stringify(report("gone")));
    mem.setItem("cupola.evidence.report.v2:ws-d:gone", JSON.stringify(report("gone", { workspaceId: "ws-d" })));
    setLegacyScope("ws-d", URL_A);
    deleteEvidenceReport("ws-d", "gone");
    expect(listEvidenceReports("ws-d")).toEqual([]);
  });

  test("recovery drafts fall back to the legacy URL", () => {
    mem.setItem(`cupola.evidence.draft.v1:${enc(URL_A)}:draft`, JSON.stringify({ savedAt: 5, report: report("draft") }));
    setLegacyScope("ws-dr", URL_A);
    expect(loadRecoveryDraft("ws-dr", "draft")?.workspaceId).toBe("ws-dr");
    expect(listUnsavedDrafts("ws-dr", new Set()).map((d) => d.report.id)).toEqual(["draft"]);
  });

  test("an import is saved into the target workspace", () => {
    const [planned] = planImport([report("imp", { workspaceId: "from-elsewhere" })], [], { serviceUrl: "http://c.test", workspaceId: "ws-i" }, () => true);
    expect(planned.report.workspaceId).toBe("ws-i");
    expect(planned.report.serviceUrl).toBe("http://c.test");
  });
});

describe("engine.attached across a shell restart", () => {
  test("a waiter on a replaced attach cycle settles with the next one", async () => {
    const before = engine.attached!;
    let settled = false;
    void before.then(() => { settled = true; });
    engine.resetAttached!();
    expect(engine.attached).not.toBe(before);
    await Promise.resolve();
    expect(settled).toBe(false);
    engine.markAttached!();
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(true);
  });
});
