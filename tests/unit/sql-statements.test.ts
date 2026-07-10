/**
 * Tests for the editor's SQL statement splitter / cursor resolver.
 * Pure string logic — no DuckDB or CodeMirror dependency.
 */
import { test, expect, describe } from "bun:test";
import { splitStatements, statementAtCursor } from "../../src/lib/editor/sql-statements";

describe("splitStatements", () => {
  test("splits on top-level semicolons", () => {
    const stmts = splitStatements("SELECT 1; SELECT 2; SELECT 3");
    expect(stmts.map((s) => s.text)).toEqual(["SELECT 1", "SELECT 2", "SELECT 3"]);
  });

  test("drops empty segments", () => {
    const stmts = splitStatements("SELECT 1;;  ; SELECT 2;");
    expect(stmts.map((s) => s.text)).toEqual(["SELECT 1", "SELECT 2"]);
  });

  test("ignores semicolons inside single-quoted strings", () => {
    const stmts = splitStatements("SELECT 'a;b' AS x; SELECT 2");
    expect(stmts.map((s) => s.text)).toEqual(["SELECT 'a;b' AS x", "SELECT 2"]);
  });

  test("handles '' escaped quotes", () => {
    const stmts = splitStatements("SELECT 'it''s; fine'; SELECT 2");
    expect(stmts.map((s) => s.text)).toEqual(["SELECT 'it''s; fine'", "SELECT 2"]);
  });

  test("ignores semicolons inside double-quoted identifiers", () => {
    const stmts = splitStatements('SELECT "weird;col" FROM t; SELECT 2');
    expect(stmts.map((s) => s.text)).toEqual(['SELECT "weird;col" FROM t', "SELECT 2"]);
  });

  test("ignores semicolons inside line comments", () => {
    const stmts = splitStatements("SELECT 1 -- a; b\n; SELECT 2");
    expect(stmts.map((s) => s.text)).toEqual(["SELECT 1 -- a; b", "SELECT 2"]);
  });

  test("ignores semicolons inside block comments", () => {
    const stmts = splitStatements("SELECT 1 /* a; b; c */; SELECT 2");
    expect(stmts.map((s) => s.text)).toEqual(["SELECT 1 /* a; b; c */", "SELECT 2"]);
  });

  test("ignores semicolons inside dollar-quoted strings", () => {
    const stmts = splitStatements("SELECT $$a;b;c$$; SELECT 2");
    expect(stmts.map((s) => s.text)).toEqual(["SELECT $$a;b;c$$", "SELECT 2"]);
  });

  test("ignores semicolons inside tagged dollar quotes", () => {
    const stmts = splitStatements("SELECT $tag$a;b$tag$ AS x; SELECT 2");
    expect(stmts.map((s) => s.text)).toEqual(["SELECT $tag$a;b$tag$ AS x", "SELECT 2"]);
  });

  test("offsets point at the trimmed statement", () => {
    const sql = "  SELECT 1  ;  SELECT 2  ";
    const stmts = splitStatements(sql);
    expect(sql.slice(stmts[0].from, stmts[0].to)).toBe("SELECT 1");
    expect(sql.slice(stmts[1].from, stmts[1].to)).toBe("SELECT 2");
  });

  test("empty document → no statements", () => {
    expect(splitStatements("   \n  ")).toEqual([]);
  });

  test("drops comment-only segments", () => {
    expect(splitStatements("-- just a note\n")).toEqual([]);
    expect(splitStatements("/* block */")).toEqual([]);
    const doc = "SELECT 1;\n-- SELECT 2;\n-- SELECT 3;\n";
    expect(splitStatements(doc).map((s) => s.text)).toEqual(["SELECT 1"]);
  });

  test("a comment above a statement stays part of it", () => {
    const doc = "-- header\nSELECT 1;";
    expect(splitStatements(doc).map((s) => s.text)).toEqual(["-- header\nSELECT 1"]);
  });

  test("a `--` inside a string literal is code, not a comment", () => {
    expect(splitStatements("SELECT '--'").map((s) => s.text)).toEqual(["SELECT '--'"]);
  });
});

describe("statementAtCursor", () => {
  const sql = "SELECT 1;\nSELECT 2;\nSELECT 3";

  test("returns the statement containing the cursor", () => {
    expect(statementAtCursor(sql, 0)?.text).toBe("SELECT 1");
    // Cursor inside the second statement.
    const pos = sql.indexOf("SELECT 2") + 3;
    expect(statementAtCursor(sql, pos)?.text).toBe("SELECT 2");
    // Cursor in the trailing statement (no terminating semicolon).
    expect(statementAtCursor(sql, sql.length)?.text).toBe("SELECT 3");
  });

  test("cursor on the semicolon belongs to the statement it terminates", () => {
    const semi = sql.indexOf(";");
    expect(statementAtCursor(sql, semi)?.text).toBe("SELECT 1");
  });

  test("cursor in a blank tail falls back to the previous statement", () => {
    const doc = "SELECT 42;   \n\n  ";
    expect(statementAtCursor(doc, doc.length)?.text).toBe("SELECT 42");
  });

  test("empty document → null", () => {
    expect(statementAtCursor("  ", 1)).toBeNull();
  });

  test("comment-only document → null", () => {
    const doc = "-- nothing to run here\n";
    expect(statementAtCursor(doc, doc.length)).toBeNull();
  });

  // The reported bug: commented-out variants parked below the live query made
  // the trailing segment look runnable, so Ctrl+Enter with the cursor at the
  // end shipped nothing but comments to DuckDB and drew an empty grid.
  test("cursor in a trailing comment block falls back to the live statement", () => {
    const doc = [
      "-- Sparrow Trap: Exec Rec",
      "-- Stock queries below; the live one runs first.",
      "SELECT * FROM harbor.executions WHERE _partition_date='2026-07-06' LIMIT 100;",
      "-- SELECT * FROM harbor.executions WHERE bb_yellow_key LIKE '%AAPL%';",
      "-- SELECT COUNT(*) FROM harbor.executions GROUP BY execution_type;",
      "",
    ].join("\n");
    const stmt = statementAtCursor(doc, doc.length);
    expect(stmt?.text).toContain("LIMIT 100");
    expect(stmt?.text.endsWith("LIMIT 100")).toBe(true);
    // Same answer with the cursor parked mid-way through the dead comments.
    expect(statementAtCursor(doc, doc.indexOf("AAPL"))?.text).toBe(stmt?.text);
  });

  // A comment sitting above a statement is inside that statement's segment (a
  // `;` in a comment doesn't terminate anything), so it runs the statement
  // below it rather than falling back to the one above.
  test("cursor in a comment above a statement runs that statement", () => {
    const doc = "SELECT 1;\n-- dead code;\nSELECT 2;";
    expect(statementAtCursor(doc, doc.indexOf("dead"))?.text).toBe("-- dead code;\nSELECT 2");
  });

  test("comment-only segment between two statements falls back to the one above", () => {
    const doc = "SELECT 1;\n-- orphan\n;\nSELECT 2;";
    expect(statementAtCursor(doc, doc.indexOf("orphan"))?.text).toBe("SELECT 1");
  });
});
