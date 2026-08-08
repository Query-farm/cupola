/**
 * Tests for the per-conversation read_query_results store.
 *
 * The regression: this was a module-level Map with a 3-entry LRU and a
 * module-level id counter, shared by all three AI surfaces (AskAIChat, the
 * editor's AI panel, and the terminal's `.ai` mode). A query on any one of
 * them could evict a `result_id` another had just handed its model, so the
 * agent would try to page a result it had only just created and get
 * "Result 'result_N' not found or expired".
 *
 * The invariant now: one conversation's queries never affect another's.
 */
import { test, expect, describe } from "bun:test";
import { QueryResultCache, executeReadQueryResults } from "../../src/lib/query-results";

const row = (i: number) => ({ n: i });
const result = (n: number) => ({
  columns: ["n"],
  types: ["Int32"],
  rows: Array.from({ length: n }, (_, i) => row(i)),
  rowCount: n,
});

describe("isolation between conversations", () => {
  test("one conversation's queries never evict another's results", () => {
    const chat = new QueryResultCache();
    const editor = new QueryResultCache();

    const chatId = chat.store(result(3));

    // The editor runs enough queries to overflow its own LRU several times.
    for (let i = 0; i < 20; i++) editor.store(result(1));

    // The chat's result must still be readable — this is exactly what failed
    // when the two shared one module-level cache.
    const read = JSON.parse(executeReadQueryResults(chat, chatId));
    expect(read.error).toBeUndefined();
    expect(read.rows).toHaveLength(3);
  });

  test("ids are per-conversation, so the same id means different things", () => {
    const a = new QueryResultCache();
    const b = new QueryResultCache();
    const idA = a.store(result(1));
    const idB = b.store(result(9));
    // Both are "result_1" — the counter is per-instance, not global.
    expect(idA).toBe(idB);
    expect(JSON.parse(executeReadQueryResults(a, idA)).row_count).toBe(1);
    expect(JSON.parse(executeReadQueryResults(b, idB)).row_count).toBe(9);
  });

  test("reading an id from the wrong conversation reports not-found", () => {
    const a = new QueryResultCache();
    const b = new QueryResultCache();
    a.store(result(1));
    expect(JSON.parse(executeReadQueryResults(b, "result_1")).error).toBeTruthy();
  });
});

describe("eviction and lifetime", () => {
  test("evicts oldest-first past the cap", () => {
    const c = new QueryResultCache(3);
    const ids = [c.store(result(1)), c.store(result(2)), c.store(result(3))];
    expect(c.size).toBe(3);
    const fourth = c.store(result(4));
    expect(c.size).toBe(3);
    // Oldest gone, the rest still readable.
    expect(JSON.parse(executeReadQueryResults(c, ids[0])).error).toBeTruthy();
    expect(JSON.parse(executeReadQueryResults(c, ids[1])).error).toBeUndefined();
    expect(JSON.parse(executeReadQueryResults(c, fourth)).error).toBeUndefined();
  });

  test("retains more than the old global 3-entry limit by default", () => {
    const c = new QueryResultCache();
    const ids = Array.from({ length: 5 }, () => c.store(result(1)));
    // All five readable — the old shared cache held only 3 for the whole app.
    for (const id of ids) {
      expect(JSON.parse(executeReadQueryResults(c, id)).error).toBeUndefined();
    }
  });

  test("clear() frees everything (new conversation / .ai new)", () => {
    const c = new QueryResultCache();
    const id = c.store(result(2));
    c.clear();
    expect(c.size).toBe(0);
    expect(JSON.parse(executeReadQueryResults(c, id)).error).toBeTruthy();
  });
});

describe("paging", () => {
  test("offset and limit slice the stored rows", () => {
    const c = new QueryResultCache();
    const id = c.store(result(50));
    const page = JSON.parse(executeReadQueryResults(c, id, 10, 5));
    expect(page.rows.map((r: any) => r.n)).toEqual([10, 11, 12, 13, 14]);
    expect(page.offset).toBe(10);
    expect(page.showing).toBe(5);
    expect(page.row_count).toBe(50);
  });

  test("limit is capped at 100 so a page can't blow the context window", () => {
    const c = new QueryResultCache();
    const id = c.store(result(500));
    expect(JSON.parse(executeReadQueryResults(c, id, 0, 999)).rows).toHaveLength(100);
  });

  test("an offset past the end returns no rows rather than erroring", () => {
    const c = new QueryResultCache();
    const id = c.store(result(3));
    const page = JSON.parse(executeReadQueryResults(c, id, 99, 10));
    expect(page.rows).toEqual([]);
    expect(page.error).toBeUndefined();
  });
});
