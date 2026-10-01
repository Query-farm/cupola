import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { QueryHistoryEntry } from "../../src/lib/shell-bridge";
import { addQueryHistoryEntry, clearQueryHistory, loadQueryHistory, QUERY_HISTORY_LIMIT, removeQueryHistoryEntry } from "../../src/lib/editor/query-history";
import { formatWhen } from "../../src/components/editor/QueryHistoryMenu";

const original = (globalThis as { localStorage?: Storage }).localStorage;
const store = new Map<string, string>();
let quota = Infinity;
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => { if (value.length > quota) throw new DOMException("full", "QuotaExceededError"); store.set(key, value); },
  removeItem: (key: string) => { store.delete(key); },
};
afterAll(() => { (globalThis as { localStorage?: unknown }).localStorage = original; });

const SERVICE = "http://history.test";
const entry = (sql: string, extra: Partial<QueryHistoryEntry> = {}): QueryHistoryEntry =>
  ({ id: 1000, timestamp: 1000, sql, executionTimeMs: 5, success: true, source: "editor", ...extra });

beforeEach(() => { quota = Infinity; clearQueryHistory(SERVICE); clearQueryHistory("http://other.test"); });

describe("query history", () => {
  test("keeps entries newest first, per server, with unique ids", () => {
    addQueryHistoryEntry(SERVICE, entry("SELECT 1"));
    addQueryHistoryEntry(SERVICE, entry("SELECT 2")); // same Date.now() id
    addQueryHistoryEntry("http://other.test", entry("SELECT 3"));
    const entries = loadQueryHistory(SERVICE);
    expect(entries.map((item) => item.sql)).toEqual(["SELECT 2", "SELECT 1"]);
    expect(new Set(entries.map((item) => item.id)).size).toBe(2);
    expect(loadQueryHistory("http://other.test").map((item) => item.sql)).toEqual(["SELECT 3"]);
    expect(JSON.parse(store.get(`cupola.query-history.v1::${SERVICE}`)!)).toHaveLength(2);
  });
  test("running the same query again counts the run instead of adding an entry", () => {
    addQueryHistoryEntry(SERVICE, entry("SELECT 1"));
    addQueryHistoryEntry(SERVICE, entry(" SELECT 1 ", { timestamp: 2000 }));
    addQueryHistoryEntry(SERVICE, entry("SELECT 1", { source: "shell" }));
    expect(loadQueryHistory(SERVICE).map((item) => [item.source, item.runs ?? 1, item.timestamp])).toEqual([["shell", 1, 1000], ["editor", 2, 2000]]);
  });
  test("is capped, and removes and clears", () => {
    for (let i = 0; i < QUERY_HISTORY_LIMIT + 5; i++) addQueryHistoryEntry(SERVICE, entry(`SELECT ${i}`, { id: i }));
    const entries = loadQueryHistory(SERVICE);
    expect(entries).toHaveLength(QUERY_HISTORY_LIMIT);
    expect(entries[0].sql).toBe(`SELECT ${QUERY_HISTORY_LIMIT + 4}`);
    removeQueryHistoryEntry(SERVICE, entries[0].id);
    expect(loadQueryHistory(SERVICE)[0].sql).toBe(`SELECT ${QUERY_HISTORY_LIMIT + 3}`);
    clearQueryHistory(SERVICE);
    expect(loadQueryHistory(SERVICE)).toEqual([]);
    expect(store.has(`cupola.query-history.v1::${SERVICE}`)).toBe(false);
  });
  test("a full storage keeps the newest entries it can", () => {
    for (let i = 0; i < 40; i++) addQueryHistoryEntry(SERVICE, entry(`SELECT ${i}`, { id: i }));
    quota = 2_000;
    addQueryHistoryEntry(SERVICE, entry("SELECT 'latest'"));
    const saved = JSON.parse(store.get(`cupola.query-history.v1::${SERVICE}`)!) as QueryHistoryEntry[];
    expect(saved.length).toBeGreaterThan(0);
    expect(saved.length).toBeLessThan(41);
    expect(saved[0].sql).toBe("SELECT 'latest'");
    expect(loadQueryHistory(SERVICE)).toHaveLength(41);
  });
  test("times read as a person would say them", () => {
    const now = new Date(2026, 8, 30, 15, 0).getTime();
    expect(formatWhen(now - 10_000, now)).toBe("just now");
    expect(formatWhen(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(formatWhen(new Date(2026, 8, 29, 9, 5).getTime(), now)).toStartWith("Yesterday ");
  });
});
