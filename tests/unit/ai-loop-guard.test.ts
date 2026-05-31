/**
 * Unit tests for the repeated-tool-call loop-breaker.
 *
 * Locks in: deterministic metadata tools are blocked after MAX_IDENTICAL_TOOL_CALLS
 * identical calls, key-order doesn't matter, different args are independent, and
 * non-deterministic tools (run_sql etc.) are never blocked.
 */
import { test, expect, describe } from "bun:test";
import {
  recordToolCall,
  repeatedCallMessage,
  MAX_IDENTICAL_TOOL_CALLS,
} from "../../src/lib/ai-loop-guard";

describe("recordToolCall", () => {
  test("blocks list_tables after the allowed number of identical calls", () => {
    const counts = new Map<string, number>();
    const results = [1, 2, 3, 4].map(() => recordToolCall(counts, "list_tables", {}));
    // First MAX_IDENTICAL_TOOL_CALLS calls execute; subsequent ones block.
    expect(results.slice(0, MAX_IDENTICAL_TOOL_CALLS).every((r) => !r.block)).toBe(true);
    expect(results[MAX_IDENTICAL_TOOL_CALLS].block).toBe(true);
    expect(results[3].block).toBe(true);
    expect(results[3].count).toBe(4);
  });

  test("treats different describe_table args independently", () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 5; i++) recordToolCall(counts, "describe_table", { schema: "a", table: "x" });
    // A different table has its own counter and is not blocked.
    expect(recordToolCall(counts, "describe_table", { schema: "a", table: "y" }).block).toBe(false);
    // The hammered one is blocked.
    expect(recordToolCall(counts, "describe_table", { schema: "a", table: "x" }).block).toBe(true);
  });

  test("key ordering does not matter (stable stringify)", () => {
    const counts = new Map<string, number>();
    recordToolCall(counts, "describe_table", { schema: "a", table: "x" });
    recordToolCall(counts, "describe_table", { table: "x", schema: "a" });
    // Both counted under the same key → third identical (any order) blocks.
    expect(recordToolCall(counts, "describe_table", { schema: "a", table: "x" }).block).toBe(true);
  });

  test("never blocks non-deterministic tools (run_sql, render_chart, ask_user)", () => {
    const counts = new Map<string, number>();
    for (const name of ["run_sql", "render_chart", "ask_user"]) {
      for (let i = 0; i < 10; i++) {
        expect(recordToolCall(counts, name, { sql: "SELECT 1" }).block).toBe(false);
      }
    }
  });

  test("repeatedCallMessage reports the prior call count", () => {
    expect(repeatedCallMessage("list_tables", 3)).toContain("2 time(s)");
    expect(repeatedCallMessage("list_tables", 3)).toContain("list_tables");
  });
});
