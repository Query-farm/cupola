import { describe, expect, test } from "bun:test";
import { createQueryPivotSource, dropQueryPivotSource, pivotStatement } from "../../src/lib/pivot-source";

function recorder(result: { ok: boolean; error?: string } = { ok: true }) {
  const statements: string[] = [];
  return { statements, run: async (sql: string) => { statements.push(sql); return result; } };
}

describe("pivot statement", () => {
  test("wraps the statement that produced the result, without its terminator", () => {
    expect(pivotStatement("SELECT region, sum(x) FROM sales GROUP BY 1;")).toBe("SELECT region, sum(x) FROM sales GROUP BY 1");
    // A multi-statement run executed every statement; the grid shows the last.
    expect(pivotStatement("SET threads = 4;\nCREATE TEMP TABLE t AS SELECT 1 AS x;\nFROM t")).toBe("FROM t");
  });

  test("ignores trailing comment-only segments", () => {
    expect(pivotStatement("SELECT 1 AS x;\n-- SELECT 2;\n")).toBe("SELECT 1 AS x");
  });

  test("has nothing to wrap in an empty run", () => {
    expect(pivotStatement("  -- nothing here\n")).toBeNull();
  });
});

describe("query pivot sources", () => {
  test("a live view wraps the query in a TEMP view, a table materializes it", async () => {
    const { statements, run } = recorder();
    const view = await createQueryPivotSource("SELECT * FROM small.orders;", "view", run);
    const table = await createQueryPivotSource("SELECT * FROM small.orders -- all of them", "table", run);

    expect(view.tableId).toMatch(/^temp\.main\.__cupola_pivot_\d+$/);
    expect(table.tableId).not.toBe(view.tableId);
    expect(statements[0]).toBe(`CREATE TEMP VIEW "${view.tableId.slice(10)}" AS\nSELECT * FROM small.orders`);
    // The query starts on its own line, so a trailing comment ends harmlessly.
    expect(statements[1]).toBe(`CREATE TEMP TABLE "${table.tableId.slice(10)}" AS\nSELECT * FROM small.orders -- all of them`);

    await dropQueryPivotSource(view, run);
    await dropQueryPivotSource(table, run);
    expect(statements.slice(2)).toEqual([
      `DROP VIEW IF EXISTS temp.main."${view.tableId.slice(10)}"`,
      `DROP TABLE IF EXISTS temp.main."${table.tableId.slice(10)}"`,
    ]);
  });

  test("a query DuckDB cannot wrap says so and points at Snapshot", async () => {
    const { run } = recorder({ ok: false, error: "Parser Error: syntax error at or near \"PRAGMA\"" });
    await expect(createQueryPivotSource("PRAGMA database_size", "view", run))
      .rejects.toThrow(/can't be pivoted as a live view: Parser Error.*Snapshot works for any result/);
  });
});
