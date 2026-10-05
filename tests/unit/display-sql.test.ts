import { test, expect } from "bun:test";
import { displaySql } from "../../src/lib/sql/display-sql";

test("a one-line example is formatted across lines", () => {
  expect(displaySql("SELECT a, b FROM t WHERE a > 1")).toBe("SELECT\n  a,\n  b\nFROM\n  t\nWHERE\n  a > 1");
});

test("the author's own layout is kept", () => {
  const sql = "SELECT a,\n       b\nFROM t";
  expect(displaySql(`  ${sql}\n`)).toBe(sql);
});

test("DuckDB syntax formats without changing anything but whitespace", () => {
  for (const sql of [
    "SELECT * FROM cat.main.fn(1, unit := 'km') WHERE x::INT > 1",
    "SELECT {'a': 1} AS s, 'it''s' AS q FROM read_csv('a.csv', header := true) LIMIT 5",
    "FROM tbl SELECT a QUALIFY row_number() OVER (PARTITION BY a) = 1",
  ]) {
    const out = displaySql(sql);
    expect(out).toContain("\n");
    expect(out.replace(/\s+/g, "")).toBe(sql.replace(/\s+/g, ""));
  }
});

test("keyword case is left as written", () => {
  expect(displaySql("select year from t")).toBe("select\n  year\nfrom\n  t");
});

test("SQL the formatter can't parse is shown as written", () => {
  expect(displaySql("SELEKT ((( broken")).toBe("SELEKT ((( broken");
});
