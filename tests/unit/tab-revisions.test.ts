import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { deleteTabRevisions, loadTabRevisions, recordRevision, revisionText, REVISIONS_PER_TAB } from "../../src/lib/editor/tab-revisions";

const original = (globalThis as { localStorage?: Storage }).localStorage;
const store = new Map<string, string>();
let quota = Infinity;
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { if (v.length > quota) throw new Error("QuotaExceededError"); store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
};
afterAll(() => { (globalThis as { localStorage?: unknown }).localStorage = original; });

const S = "http://svc.test";
let doc = 0;
let tab = "";
beforeEach(() => { quota = Infinity; tab = `tab-${++doc}`; });

const kinds = () => loadTabRevisions(S, tab).revisions.map((r) => r.kind);
const texts = () => { const v = loadTabRevisions(S, tab); return v.revisions.map((r) => revisionText(v, r)); };

describe("tab revisions", () => {
  test("snapshots are newest first, with each text stored once", () => {
    recordRevision(S, tab, "SELECT 1", "run", { outcome: { success: true, rowCount: 1, ms: 3 } }, 1);
    recordRevision(S, tab, "SELECT 2", "ai", {}, 2);
    recordRevision(S, tab, "SELECT 1", "restore", {}, 3);
    expect(kinds()).toEqual(["restore", "ai", "run"]);
    expect(texts()).toEqual(["SELECT 1", "SELECT 2", "SELECT 1"]);
    expect(Object.keys(loadTabRevisions(S, tab).blobs)).toHaveLength(2);
  });

  test("unchanged text adds nothing; re-running it counts the run", () => {
    recordRevision(S, tab, "SELECT 1", "run", { outcome: { success: true, ms: 1 } }, 1);
    recordRevision(S, tab, "SELECT 1", "edit", {}, 2);
    recordRevision(S, tab, "SELECT 1", "run", { outcome: { success: false, error: "boom", ms: 2 } }, 3);
    const [only, ...rest] = loadTabRevisions(S, tab).revisions;
    expect(rest).toHaveLength(0);
    expect(only.outcome).toEqual({ success: false, error: "boom", ms: 2, runs: 2 });
    expect(only.at).toBe(3);
  });

  test("edits then a run of them become one run", () => {
    recordRevision(S, tab, "SELECT 9", "edit", {}, 1);
    recordRevision(S, tab, "SELECT 9", "run", { statement: "SELECT 9", outcome: { success: true, ms: 1 } }, 2);
    expect(kinds()).toEqual(["run"]);
    expect(loadTabRevisions(S, tab).revisions[0].outcome?.runs).toBe(1);
  });

  test("blank text is never recorded", () => {
    recordRevision(S, tab, "   ", "edit");
    expect(kinds()).toEqual([]);
  });

  test("capped per tab, unused blobs dropped, deleted with the tab", () => {
    for (let i = 0; i < REVISIONS_PER_TAB + 5; i++) recordRevision(S, tab, `SELECT ${i}`, "run", {}, i + 1);
    const v = loadTabRevisions(S, tab);
    expect(v.revisions).toHaveLength(REVISIONS_PER_TAB);
    expect(Object.keys(v.blobs)).toHaveLength(REVISIONS_PER_TAB);
    expect(revisionText(v, v.revisions.at(-1)!)).toBe("SELECT 5");
    deleteTabRevisions(S, tab);
    expect(kinds()).toEqual([]);
    expect([...store.keys()].some((k) => k.endsWith(`::${tab}`))).toBe(false);
  });

  test("a full storage keeps the newest half", () => {
    for (let i = 0; i < 8; i++) recordRevision(S, tab, `SELECT ${i}`, "run", {}, i + 1);
    quota = 400;
    recordRevision(S, tab, "SELECT 'last'", "run", {}, 100);
    const stored = JSON.parse(store.get(`cupola.editor-revisions.v1::${S}::${tab}`)!);
    expect(stored.revisions.length).toBeLessThan(9);
    expect(stored.revisions[0].hash).toBe(loadTabRevisions(S, tab).revisions[0].hash);
  });

  test("tabs are separate", () => {
    recordRevision(S, tab, "SELECT 'a'", "run", {}, 1);
    expect(loadTabRevisions(S, "some-other-tab").revisions).toHaveLength(0);
  });
});
