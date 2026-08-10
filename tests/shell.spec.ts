/**
 * DuckDB WASM Shell — Playwright integration tests.
 *
 * Requires:
 *   - Dev server (started by playwright.config.ts, or point CUPOLA_APP_ORIGIN
 *     at a running one)
 *   - Any VGI server — see helpers.ts for the default and VGI_SERVICE_URL.
 *
 * The catalog-access tests discover whatever catalog the server attached rather
 * than naming one. They used to hardcode `albemarle_gis` on localhost:9003,
 * which meant they only passed against one developer's local dataset and failed
 * as soon as that server was serving something else.
 *
 * Run: npx @playwright/test tests/shell.spec.ts
 */
import { test, expect, type Page } from "@playwright/test";
import { APP_URL } from "./helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wait for the shell bridge to be ready (runQuery is set). */
async function waitForShell(page: Page, timeoutMs = 30_000): Promise<void> {
  // `waitForFunction(fn, arg, options)` — the options object must go in the
  // THIRD position. Passed second it is treated as the page-function argument
  // and silently ignored, so this fell back to the config's 10s actionTimeout
  // and every test in this file failed in beforeEach waiting for a DuckDB boot
  // + ATTACH that legitimately needs longer.
  await page.waitForFunction(
    () => typeof (window as any).__bridge?.runQuery === "function",
    null,
    { timeout: timeoutMs },
  );
  // `runQuery` exists ~4s in, but the boot sequence (extension INSTALL/LOAD
  // then ATTACH) keeps running after that, and a command submitted into the
  // terminal during it is swallowed — `.test_formats` would produce no output
  // at all, not even its first line, and the test timed out with no diagnostic.
  // Await the ATTACH barrier, then wait for the read loop to actually print a
  // prompt. The barrier alone is not enough: the first command submitted before
  // the prompt appears is swallowed, so `.test_formats` produced no output at
  // all — not even its first line — and the test timed out with no diagnostic.
  await page.evaluate(
    (ms) =>
      Promise.race([
        (window as any).__bridge?.attached ?? Promise.resolve(),
        new Promise((r) => setTimeout(r, ms)),
      ]),
    timeoutMs,
  );
  // Historically the shell published `terminal.runQuery` before xterm-readline
  // was inside `read()`, so the first submitted command vanished. Fixed in
  // shell-init by resolving the prompt's catalog before the handoff; this probe
  // stays as the regression guard — if the window reopens, `.help` produces no
  // output and this fails fast with a clear message instead of a bare timeout.
  const interactive = await page
    .waitForFunction(
      () => {
        const b = (window as any).__bridge;
        if (!b?.shellTerm || typeof b.runQuery !== "function") return false;
        try { b.runQuery(".help"); } catch { return false; }
        const buf = b.shellTerm.buffer.active;
        for (let i = 0; i < buf.length; i++) {
          if (/\.maxrows|\.perspective/.test(buf.getLine(i)?.translateToString(true) ?? "")) return true;
        }
        return false;
      },
      null,
      { timeout: timeoutMs, polling: 500 },
    )
    .then(() => true)
    .catch(() => false);
  if (!interactive) throw new Error("shell terminal never became interactive");
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
    // Use the Vite-resolved path for apache-arrow (bare specifier doesn't work
    // in evaluate). Held in a variable so TypeScript treats it as a runtime
    // specifier instead of resolving the literal on the checking host.
    const arrowUrl = "/node_modules/@query-farm/apache-arrow/Arrow.mjs";
    const { tableFromIPC } = await import(arrowUrl);
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
  // Every test boots a fresh page: WASM download + compile, eight extension
  // INSTALL/LOADs, ATTACH, then the first prompt. That legitimately outruns the
  // 30s default, and since it happens in beforeEach a per-test `setTimeout` in
  // the body is too late to raise it. This is a ceiling, not a wait.
  test.describe.configure({ timeout: 120_000 });

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

  /** The catalog the VGI server ATTACHed, whatever it is called. */
  async function attachedCatalog(page: Page): Promise<string | null> {
    const r = await shellQuery(
      page,
      `SELECT DISTINCT catalog_name FROM information_schema.schemata
        WHERE catalog_name NOT IN ('memory', 'system', 'temp')
        ORDER BY 1 LIMIT 1`,
    );
    return (r.rows?.[0]?.catalog_name as string) ?? null;
  }

  test.describe("VGI catalog access", () => {
    test("query attached catalog", async ({ page }) => {
      const result = await shellQuery(page, "SELECT current_catalog()");
      expect(result.ok).toBe(true);
    });

    test("list schemas", async ({ page }) => {
      const catalog = await attachedCatalog(page);
      test.skip(!catalog, "VGI server attached no catalog");
      const result = await shellQuery(
        page,
        `SELECT schema_name FROM information_schema.schemata
          WHERE catalog_name = '${catalog}' LIMIT 5`,
      );
      expect(result.ok).toBe(true);
      expect(result.numRows).toBeGreaterThan(0);
    });

    test("query remote table", async ({ page }) => {
      const catalog = await attachedCatalog(page);
      test.skip(!catalog, "VGI server attached no catalog");

      const tables = await shellQuery(
        page,
        `SELECT table_schema, table_name FROM information_schema.tables
          WHERE table_catalog = '${catalog}'
            AND table_schema NOT IN ('information_schema', 'pg_catalog')
          LIMIT 1`,
      );
      expect(tables.ok).toBe(true);
      test.skip(!tables.rows?.length, `catalog ${catalog} exposes no tables`);

      const { table_schema, table_name } = tables.rows![0];
      // A successful COUNT(*) is the assertion: it proves the whole remote path
      // (DuckDB -> VGI extension -> RPC -> Arrow) round-trips. Row count is not
      // asserted to be non-zero — an empty table is a legitimate catalog.
      const result = await shellQuery(
        page,
        `SELECT COUNT(*) as cnt FROM "${catalog}"."${table_schema}"."${table_name}"`,
      );
      expect(result.ok, result.error).toBe(true);
      expect(typeof result.rows![0].cnt).toBe("number");
      expect(result.rows![0].cnt).toBeGreaterThanOrEqual(0);
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
      test.setTimeout(90_000);
      // ~110 comparisons take north of 15s here. At the old default this timed
      // out before the summary line was logged, turning a legible "N passed, M
      // failed" into an opaque hang — and `runFormatTests` reports its errors
      // to the xterm buffer only, so nothing reached the test output either.
      const consolePromise = waitForConsoleMatch(page, /FORMAT_TEST:/, 60_000);
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
        expect(passed).toBeGreaterThanOrEqual(106);
        // Known failures, all rendering-only:
        //   timestamp_tz[0/1], timestamptz_array[1] — DuckDB WASM ICU renders a
        //     DST offset where the CLI reference used a fixed one. The instants
        //     agree (18:23:45-05 == 19:23:45-04); only the printed offset differs.
        //   varchar[1] — embedded tab, collapsed by the terminal.
        // This was 9 until `arrowLosslessConversion` was enabled at instantiation
        // (see duckdb-worker-boot.ts); the other 5 were real decoding bugs —
        // uhugeint read as signed, BIT as an untagged blob, TIME_TZ losing its
        // offset — and are fixed, not tolerated.
        expect(failed).toBeLessThanOrEqual(4);
      }
    });
  });

  test.describe("dot commands", () => {
    test(".help shows help text", async ({ page }) => {
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
