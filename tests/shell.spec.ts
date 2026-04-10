/**
 * DuckDB WASM Shell — Playwright integration tests.
 *
 * Requires:
 *   - Dev server running on localhost:4321
 *   - VGI server running on localhost:9003 (run-local-noauth.sh)
 *
 * Run: npx @playwright/test tests/shell.spec.ts
 */
import { test, expect, type Page } from "@playwright/test";

const SERVICE_URL = "http://localhost:9003";
const APP_URL = `http://localhost:4321/?service=${SERVICE_URL}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wait for the shell bridge to be ready (runQuery is set). */
async function waitForShell(page: Page, timeoutMs = 30_000): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as any).__bridge?.runQuery === "function",
    { timeout: timeoutMs },
  );
}

/** Run a dot-command or SQL via the shell bridge. */
async function shellRun(page: Page, command: string): Promise<void> {
  await page.evaluate((cmd) => (window as any).__bridge.runQuery(cmd), command);
}

/** Run a SQL query via bridge.query and return the parsed result.
 *  Arrow parsing happens in-page using the Vite-resolved apache-arrow module. */
async function shellQuery(page: Page, sql: string): Promise<{ ok: boolean; error?: string; numRows?: number; columns?: string[]; rows?: Record<string, any>[] }> {
  return page.evaluate(async (sql) => {
    const bridge = (window as any).__bridge;
    if (!bridge?.query) throw new Error("bridge.query not available");
    const result = await bridge.query(sql);
    if (!result.ok) return { ok: false, error: result.error };
    if (!result.arrowBuffers?.length) return { ok: true, numRows: 0, columns: [], rows: [] };
    // Use the Vite-resolved path for apache-arrow (bare specifier doesn't work in evaluate)
    const { tableFromIPC } = await import("/node_modules/apache-arrow/Arrow.mjs");
    const table = tableFromIPC(new Uint8Array(result.arrowBuffers[0]));
    const fields = table.schema.fields;
    const columns = fields.map((f: any) => f.name);
    const rows: Record<string, any>[] = [];
    for (let r = 0; r < table.numRows; r++) {
      const row: Record<string, any> = {};
      for (let c = 0; c < fields.length; c++) {
        const val = table.getChildAt(c)?.get(r);
        row[columns[c]] = val === null || val === undefined ? null : typeof val === "bigint" ? Number(val) : val;
      }
      rows.push(row);
    }
    return { ok: true, numRows: table.numRows, columns, rows };
  }, sql);
}

/** Collect console log messages matching a pattern, with timeout. */
async function waitForConsoleMatch(page: Page, pattern: RegExp, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      page.removeListener("console", handler);
      reject(new Error(`Timed out waiting for console match: ${pattern}`));
    }, timeoutMs);
    const handler = (msg: any) => {
      const text = msg.text();
      if (pattern.test(text)) {
        clearTimeout(timer);
        page.removeListener("console", handler);
        resolve(text);
      }
    };
    page.on("console", handler);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("DuckDB WASM Shell", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(APP_URL);
    await waitForShell(page);
  });

  test.describe("basic SQL execution", () => {
    test("SELECT literal values", async ({ page }) => {
      const result = await shellQuery(page, "SELECT 1 as a, 'hello' as b");
      expect(result.ok).toBe(true);
      expect(result.numRows).toBe(1);
      expect(result.columns).toEqual(["a", "b"]);
      expect(result.rows![0]).toEqual({ a: 1, b: "hello" });
    });

    test("SELECT arithmetic", async ({ page }) => {
      const result = await shellQuery(page, "SELECT 2 + 3 as sum, 10 * 5 as product");
      expect(result.ok).toBe(true);
      expect(result.rows![0]).toEqual({ sum: 5, product: 50 });
    });

    test("SELECT with multiple rows", async ({ page }) => {
      const result = await shellQuery(page, "SELECT * FROM generate_series(1, 5) t(n)");
      expect(result.ok).toBe(true);
      expect(result.numRows).toBe(5);
      expect(result.rows!.map((r) => r.n)).toEqual([1, 2, 3, 4, 5]);
    });

    test("SQL syntax error returns error", async ({ page }) => {
      const result = await shellQuery(page, "SELECTT 1");
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    });

    test("empty result set", async ({ page }) => {
      const result = await shellQuery(page, "SELECT 1 WHERE false");
      expect(result.ok).toBe(true);
      expect(result.numRows).toBe(0);
    });
  });

  test.describe("DDL and memory tables", () => {
    test("CREATE TABLE and query it", async ({ page }) => {
      await shellQuery(page, "CREATE OR REPLACE TABLE memory.main.test_tbl AS SELECT 42 as val, 'hello' as msg");
      const result = await shellQuery(page, "SELECT * FROM memory.main.test_tbl");
      expect(result.ok).toBe(true);
      expect(result.numRows).toBe(1);
      expect(result.rows![0]).toEqual({ val: 42, msg: "hello" });
      await shellQuery(page, "DROP TABLE IF EXISTS memory.main.test_tbl");
    });

    test("CREATE VIEW and query it", async ({ page }) => {
      await shellQuery(page, "CREATE OR REPLACE VIEW memory.main.test_view AS SELECT 99 as x");
      const result = await shellQuery(page, "SELECT * FROM memory.main.test_view");
      expect(result.ok).toBe(true);
      expect(result.rows![0].x).toBe(99);
      await shellQuery(page, "DROP VIEW IF EXISTS memory.main.test_view");
    });
  });

  test.describe("VGI catalog access", () => {
    test("query attached catalog", async ({ page }) => {
      const result = await shellQuery(page, "SELECT current_catalog()");
      expect(result.ok).toBe(true);
    });

    test("list schemas", async ({ page }) => {
      const result = await shellQuery(page, "SELECT schema_name FROM information_schema.schemata WHERE catalog_name = 'albemarle_gis' LIMIT 5");
      expect(result.ok).toBe(true);
      expect(result.numRows).toBeGreaterThan(0);
    });

    test("query remote table", async ({ page }) => {
      const result = await shellQuery(page, "SELECT COUNT(*) as cnt FROM albemarle_gis.property.parcels");
      expect(result.ok).toBe(true);
      expect(result.rows![0].cnt).toBeGreaterThan(0);
    });
  });

  test.describe("data types", () => {
    test("integer types", async ({ page }) => {
      const result = await shellQuery(page, "SELECT 127::tinyint as ti, 32767::smallint as si, 2147483647::integer as i, 9223372036854775807::bigint as bi");
      expect(result.ok).toBe(true);
      expect(result.rows![0].ti).toBe(127);
      expect(result.rows![0].si).toBe(32767);
      expect(result.rows![0].i).toBe(2147483647);
    });

    test("float and double", async ({ page }) => {
      const result = await shellQuery(page, "SELECT 3.14::float as f, 2.718281828::double as d");
      expect(result.ok).toBe(true);
      expect(result.rows![0].f).toBeCloseTo(3.14, 1);
      expect(result.rows![0].d).toBeCloseTo(2.718281828, 5);
    });

    test("string and boolean", async ({ page }) => {
      const result = await shellQuery(page, "SELECT 'hello world' as s, true as t, false as f");
      expect(result.ok).toBe(true);
      // Arrow returns booleans as 0/1 integers
      expect(result.rows![0].s).toBe("hello world");
      expect(result.rows![0].t).toBeTruthy();
      expect(result.rows![0].f).toBeFalsy();
    });

    test("NULL handling", async ({ page }) => {
      const result = await shellQuery(page, "SELECT NULL as n, COALESCE(NULL, 42) as c");
      expect(result.ok).toBe(true);
      expect(result.rows![0].n).toBeNull();
      expect(result.rows![0].c).toBe(42);
    });

    test("date and timestamp", async ({ page }) => {
      const result = await shellQuery(page, "SELECT DATE '2024-01-15' as d, TIMESTAMP '2024-01-15 10:30:00' as ts");
      expect(result.ok).toBe(true);
      // Arrow returns these as numbers (epoch ms for dates, epoch us for timestamps)
      expect(result.numRows).toBe(1);
    });
  });

  test.describe("format tests (.test_formats)", () => {
    test("107+ format tests pass", async ({ page }) => {
      const consolePromise = waitForConsoleMatch(page, /FORMAT_TEST:/);
      await shellRun(page, ".test_formats");
      const logLine = await consolePromise;
      // Parse "FORMAT_TEST: 107 passed, 3 failed." or "FORMAT_TEST: All 110 tests passed."
      const allPassed = /All \d+ tests passed/.test(logLine);
      const match = logLine.match(/(\d+) passed, (\d+) failed/);
      if (allPassed) {
        // Perfect score
      } else {
        expect(match).toBeTruthy();
        const passed = parseInt(match![1]);
        const failed = parseInt(match![2]);
        expect(passed).toBeGreaterThanOrEqual(107);
        // Known failures: timestamp_tz[0], timestamp_tz[1] (DuckDB WASM ICU), varchar[1] (tab in terminal)
        expect(failed).toBeLessThanOrEqual(3);
      }
    });
  });

  test.describe("dot commands", () => {
    test(".help shows help text", async ({ page }) => {
      const consolePromise = waitForConsoleMatch(page, /\.help|Show this help/, 5000).catch(() => null);
      await shellRun(page, ".help");
      // .help writes to terminal, not console — just verify it doesn't error
      // The command is handled if no error is thrown
    });

    test(".mode switches output mode", async ({ page }) => {
      // This just verifies the command doesn't crash
      await shellRun(page, ".mode line");
      await shellRun(page, ".mode box");
    });

    test(".maxrows changes display limit", async ({ page }) => {
      await shellRun(page, ".maxrows 20");
      await shellRun(page, ".maxrows 40");
    });
  });

  test.describe("query features", () => {
    test("EXPLAIN works", async ({ page }) => {
      const result = await shellQuery(page, "EXPLAIN SELECT 1");
      expect(result.ok).toBe(true);
      expect(result.columns).toContain("explain_key");
      expect(result.columns).toContain("explain_value");
    });

    test("CTEs work", async ({ page }) => {
      const result = await shellQuery(page, "WITH cte AS (SELECT 1 as x UNION ALL SELECT 2) SELECT SUM(x) as total FROM cte");
      expect(result.ok).toBe(true);
      // SUM returns hugeint (Uint8Array with lossless conversion) — check first byte
      const total = result.rows![0].total;
      expect(typeof total === "number" ? total : total[0]).toBe(3);
    });

    test("window functions work", async ({ page }) => {
      const result = await shellQuery(page, "SELECT n, SUM(n) OVER (ORDER BY n) as running_sum FROM generate_series(1,3) t(n)");
      expect(result.ok).toBe(true);
      // SUM returns hugeint (Uint8Array with lossless conversion) — extract first byte
      const sums = result.rows!.map((r) => typeof r.running_sum === "number" ? r.running_sum : r.running_sum[0]);
      expect(sums).toEqual([1, 3, 6]);
    });

    test("large result set", async ({ page }) => {
      const result = await shellQuery(page, "SELECT COUNT(*) as cnt FROM generate_series(1, 10000)");
      expect(result.ok).toBe(true);
      expect(result.rows![0].cnt).toBe(10000);
    });
  });

  test.describe("DuckDB extensions and features", () => {
    test("test_all_types() runs without error", async ({ page }) => {
      const result = await shellQuery(page, "SELECT COUNT(*) as cnt FROM test_all_types()");
      expect(result.ok).toBe(true);
      expect(result.rows![0].cnt).toBe(3); // min, max, null rows
    });

    test("enum types work", async ({ page }) => {
      const result = await shellQuery(page, "SELECT small_enum FROM test_all_types() WHERE small_enum IS NOT NULL LIMIT 1");
      expect(result.ok).toBe(true);
      expect(typeof result.rows![0].small_enum).toBe("string");
    });

    test("struct types work", async ({ page }) => {
      const result = await shellQuery(page, "SELECT {'x': 1, 'y': 2} as s");
      expect(result.ok).toBe(true);
      expect(result.numRows).toBe(1);
    });

    test("list types work", async ({ page }) => {
      const result = await shellQuery(page, "SELECT [1, 2, 3] as arr");
      expect(result.ok).toBe(true);
      expect(result.numRows).toBe(1);
    });

    test("JSON functions work", async ({ page }) => {
      const result = await shellQuery(page, "SELECT json_extract('{\"a\": 42}', '$.a')::int as val");
      expect(result.ok).toBe(true);
      expect(result.rows![0].val).toBe(42);
    });
  });
});
