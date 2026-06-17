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
});
