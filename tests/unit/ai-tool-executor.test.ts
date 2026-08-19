/**
 * Tests for the AI agent's shared tool implementations.
 *
 * Two regressions are locked in here, both of which shipped and both of
 * which were invisible from the outside:
 *
 *   1. SQL QUOTING. The duckdb_columns()/duckdb_tables()/duckdb_constraints()
 *      lookups compared names with DOUBLE quotes, which DuckDB parses as
 *      identifiers — `WHERE database_name = "memory"` is a reference to a
 *      column named `memory` and raises
 *        Binder Error: Referenced column "memory" not found in FROM clause!
 *      Every caller maps a failed query to "not found" and falls back, so
 *      describe_table silently returned nothing for memory/attached catalogs
 *      and never enriched view columns. These tests assert on the emitted SQL
 *      TEXT rather than on the parsed result, because the failure mode was
 *      precisely that the text was wrong while the code path "worked".
 *
 *   2. onEnd ON REJECTION. executeRunSql's onEnd callback clears the caller's
 *      spinner / queryRunning flag. It used to sit after an empty try/finally,
 *      so a rejected env.query skipped it and the surface stayed busy forever.
 */
import { test, expect, describe, mock } from "bun:test";

// shell-bridge -> service.ts pulls @query-farm/vgi-rpc/connect which doesn't
// resolve under bun's test path resolution. Stub the chain before importing.
mock.module("@query-farm/vgi-rpc/connect", () => ({ httpConnect: () => { throw new Error("stub"); } }));

const { describeTableWithFallback, executeRunSql } = await import("../../src/lib/ai-tool-executor");
const { quoteIdent, quoteLiteral, esc } = await import("../../src/lib/duckdb-query");

/** A query env that records every SQL string and always reports failure, so
 *  describeTableWithFallback walks its whole ladder and we see all the SQL. */
function recordingEnv() {
  const sql: string[] = [];
  return {
    sql,
    env: {
      query: async (s: string) => {
        sql.push(s);
        return { ok: false, error: "stubbed" };
      },
    },
  };
}

describe("quoting helpers", () => {
  test("quoteLiteral wraps in single quotes and doubles embedded quotes", () => {
    expect(quoteLiteral("memory")).toBe("'memory'");
    expect(quoteLiteral("O'Brien")).toBe("'O''Brien'");
    expect(quoteLiteral("")).toBe("''");
  });

  test("quoteIdent wraps in double quotes and doubles embedded quotes", () => {
    expect(quoteIdent("parcels")).toBe('"parcels"');
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
  });

  test("esc returns the escaped body only (callers add the quotes)", () => {
    expect(esc("O'Brien")).toBe("O''Brien");
  });

  test("quoteLiteral and quoteIdent are not interchangeable", () => {
    // The whole bug in one assertion: swapping these changes the meaning of
    // the SQL from "compare to this string" to "read this column".
    expect(quoteLiteral("memory")).not.toBe(quoteIdent("memory"));
  });
});

describe("describeTableWithFallback — introspection SQL", () => {
  test("compares names as string literals, never as identifiers", async () => {
    const { sql, env } = recordingEnv();
    await describeTableWithFallback(null, env, {
      catalog: "memory",
      schema: "main",
      table: "parcels",
    });

    expect(sql.length).toBeGreaterThan(0);
    for (const s of sql) {
      // The exact shape that produced the binder error.
      expect(s).not.toContain('database_name = "');
      expect(s).not.toContain('schema_name = "');
      expect(s).not.toContain('table_name = "');
      expect(s).toContain("database_name = 'memory'");
      expect(s).toContain("schema_name = 'main'");
      expect(s).toContain("table_name = 'parcels'");
    }
  });

  test("queries duckdb_columns() for a secondary catalog", async () => {
    const { sql, env } = recordingEnv();
    await describeTableWithFallback(null, env, {
      catalog: "memory",
      schema: "main",
      table: "parcels",
    });
    expect(sql.some((s) => s.includes("duckdb_columns()"))).toBe(true);
  });

  test("escapes single quotes in names instead of breaking out of the literal", async () => {
    const { sql, env } = recordingEnv();
    await describeTableWithFallback(null, env, {
      catalog: "cat'alog",
      schema: "sch'ema",
      table: "tab'le",
    });
    for (const s of sql) {
      expect(s).toContain("database_name = 'cat''alog'");
      expect(s).toContain("schema_name = 'sch''ema'");
      expect(s).toContain("table_name = 'tab''le'");
    }
  });

  test("reports not-found (rather than throwing) when introspection fails", async () => {
    const { env } = recordingEnv();
    const out = await describeTableWithFallback(null, env, {
      catalog: "memory",
      schema: "main",
      table: "missing",
    });
    expect(JSON.parse(out)).toHaveProperty("error");
  });

  test("returns the introspected columns when duckdb_columns() answers", async () => {
    // Minimal Arrow-free stand-in is not possible here (the helper decodes
    // real Arrow IPC), so drive the not-found path above for shape and assert
    // the happy path only through the SQL that would fetch it. Covered
    // end-to-end by the Playwright AI specs.
    const { sql, env } = recordingEnv();
    await describeTableWithFallback(null, env, { catalog: "db", schema: "s", table: "t" });
    const colQuery = sql.find((s) => s.includes("duckdb_columns()"));
    expect(colQuery).toBeDefined();
    expect(colQuery).toContain("ORDER BY column_index");
  });
});

describe("executeRunSql — onEnd lifecycle", () => {
  test("calls onEnd when the query resolves with an error result", async () => {
    let started = 0;
    let ended = 0;
    await expect(
      executeRunSql("SELECT 1", { query: async () => ({ ok: false, error: "boom" }) }, {
        onStart: () => { started++; },
        onEnd: () => { ended++; },
      }),
    ).rejects.toThrow("boom");
    expect(started).toBe(1);
    expect(ended).toBe(1);
  });

  test("calls onEnd when the query itself REJECTS", async () => {
    // The regression: a rejected env.query used to skip onEnd entirely,
    // leaving the caller's spinner spinning for the rest of the session.
    let ended = 0;
    await expect(
      executeRunSql("SELECT 1", { query: async () => { throw new Error("worker died"); } }, {
        onEnd: () => { ended++; },
      }),
    ).rejects.toThrow("worker died");
    expect(ended).toBe(1);
  });

  test("calls onEnd exactly once on the success path", async () => {
    let ended = 0;
    const out = await executeRunSql(
      "SET x = 1",
      { query: async () => ({ ok: true, arrowBuffers: [] }) },
      { onEnd: () => { ended++; } },
    );
    expect(ended).toBe(1);
    expect(JSON.parse(out)).toEqual({ ok: true, message: "Query executed successfully" });
  });

  test("marks VGI transport failures fatal so the agent loop stops", async () => {
    const outcomes: string[] = [];
    await expect(
      executeRunSql("SELECT 1", { query: async () => ({ ok: false, error: "HTTP Error: 503" }) }, {
        onOutcome: (o) => { outcomes.push(o.kind); },
      }),
    ).rejects.toMatchObject({ fatal: true });
    expect(outcomes).toEqual(["error"]);
  });

  test("keeps upstream rate limits non-fatal so agents do not abandon their draft", async () => {
    let error: any;
    try {
      await executeRunSql("SELECT 1", { query: async () => ({ ok: false, error: "Open-Meteo HTTP 429: rate limit exceeded" }) });
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Open-Meteo HTTP 429: rate limit exceeded");
    expect(error).not.toHaveProperty("fatal");
  });
});
