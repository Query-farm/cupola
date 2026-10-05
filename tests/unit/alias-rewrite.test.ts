import { describe, expect, test } from "bun:test";
import { findAliasReferences, identifierText, needsQuoting, rewriteAlias, rewriteAliases, tokenizeSql } from "../../src/lib/workspace/alias-rewrite";

const count = (sql: string, alias = "sales") => findAliasReferences(sql, alias).count;

describe("tokenizeSql", () => {
  test("covers every character, in order", () => {
    const sql = `SELECT 'a''b', "x""y", $$z$$, $1, $p, \${q} -- c\n/* d /* e */ f */ 1.5e3 FROM t`;
    const tokens = tokenizeSql(sql);
    expect(tokens.map((t) => sql.slice(t.start, t.end)).join("")).toBe(sql);
    for (let i = 1; i < tokens.length; i++) expect(tokens[i].start).toBe(tokens[i - 1].end);
  });
  test("strings, quoted identifiers, dollar quotes, params and interpolation", () => {
    const kinds = (sql: string) => tokenizeSql(sql).filter((t) => t.kind !== "space").map((t) => [t.kind, t.value]);
    expect(kinds(`'it''s'`)).toEqual([["string", `'it''s'`]]);
    expect(kinds(`E'a\\'b'`)).toEqual([["string", `E'a\\'b'`]]);
    expect(kinds(`"a""b"`)).toEqual([["quoted", `a"b`]]);
    expect(kinds(`$tag$ sales.main.t $tag$`)).toEqual([["string", `$tag$ sales.main.t $tag$`]]);
    expect(kinds(`$$ x $$`)).toEqual([["string", `$$ x $$`]]);
    expect(kinds(`$country`)).toEqual([["param", `$country`]]);
    expect(kinds(`\${by_city}`)).toEqual([["interp", `\${by_city}`]]);
    expect(kinds(`/* a /* nested */ still comment */x`)).toEqual([["comment", `/* a /* nested */ still comment */`], ["ident", "x"]]);
  });
  test("unterminated strings and comments run to the end", () => {
    expect(tokenizeSql(`'open`).at(-1)).toMatchObject({ kind: "string", end: 5 });
    expect(tokenizeSql(`/* open`).at(-1)).toMatchObject({ kind: "comment", end: 7 });
    expect(tokenizeSql(`"open`).at(-1)).toMatchObject({ kind: "quoted", end: 5 });
  });
});

describe("findAliasReferences", () => {
  test("three-part names, bare and quoted, case-insensitive", () => {
    expect(count("SELECT * FROM sales.main.orders")).toBe(1);
    expect(count(`SELECT * FROM "sales"."main"."orders"`)).toBe(1);
    expect(count("SELECT * FROM SALES.main.orders")).toBe(1);
    expect(count(`SELECT * FROM "Sales".main.orders`)).toBe(1);
    expect(count("SELECT sales.main.orders.amount FROM sales.main.orders")).toBe(2);
    expect(count("SELECT * FROM sales . main . orders")).toBe(1);
  });
  test("two-part names only in a relation position", () => {
    expect(count("SELECT * FROM sales.orders")).toBe(1);
    expect(count("SELECT * FROM a JOIN sales.orders o ON true")).toBe(1);
    expect(count("SELECT * FROM a, sales.orders")).toBe(1);
    expect(count("INSERT INTO sales.orders VALUES (1)")).toBe(1);
    expect(count("CREATE TABLE sales.t AS SELECT 1")).toBe(1);
    expect(count("DROP TABLE IF EXISTS sales.t")).toBe(1);
    expect(count("DESCRIBE sales.orders")).toBe(1);
    expect(count("USE sales.main")).toBe(1);
  });
  test("the bare alias after USE and DETACH", () => {
    expect(count("USE sales")).toBe(1);
    expect(count("DETACH sales")).toBe(1);
    expect(count("DETACH DATABASE sales")).toBe(1);
  });
  test("false positives that are not catalog references", () => {
    // A column named like the alias.
    expect(count("SELECT sales FROM t")).toBe(0);
    expect(count("SELECT sum(sales) AS sales FROM t GROUP BY sales")).toBe(0);
    // A table alias named like it, qualifying a column.
    expect(count("SELECT sales.amount FROM orders AS sales WHERE sales.amount > 0")).toBe(0);
    expect(count("SELECT sales.* FROM orders sales")).toBe(0);
    // The alias as a later part of a chain.
    expect(count("SELECT * FROM x.sales")).toBe(0);
    expect(count("SELECT * FROM x.sales.orders")).toBe(0);
    expect(count("SELECT * FROM other.main.sales")).toBe(0);
    // A different identifier that contains it.
    expect(count("SELECT * FROM other_sales.main.t")).toBe(0);
    expect(count("SELECT * FROM sales_eu.main.t")).toBe(0);
    expect(count("SELECT * FROM salesx.t")).toBe(0);
    // Strings, comments, dollar quotes, parameters, interpolation.
    expect(count("SELECT 'sales.main.orders'")).toBe(0);
    expect(count("SELECT 'it''s sales.main.t'")).toBe(0);
    expect(count("SELECT 1 -- FROM sales.main.orders")).toBe(0);
    expect(count("SELECT 1 /* FROM sales.main.orders */")).toBe(0);
    expect(count("SELECT $$ sales.main.orders $$")).toBe(0);
    expect(count("SELECT $sales")).toBe(0);
    expect(count("SELECT * FROM ${sales}")).toBe(0);
    // A quoted identifier that only contains the alias.
    expect(count(`SELECT * FROM "sales.main".t`)).toBe(0);
  });
  test("a two-part name after a FROM clause has ended is not a relation", () => {
    expect(count("SELECT a FROM t WHERE x IN (1, sales.y)")).toBe(0);
    expect(count("SELECT a FROM t ORDER BY a, sales.y")).toBe(0);
    expect(count("SELECT a FROM (SELECT 1), sales.t")).toBe(1);
  });
  test("positions are 1-based lines and columns", () => {
    const refs = findAliasReferences("SELECT 1\nFROM  sales.main.t,\n  \"sales\".main.u", "sales").references;
    expect(refs.map((r) => [r.line, r.column, r.text, r.quoted])).toEqual([[2, 7, "sales", false], [3, 3, `"sales"`, true]]);
  });
  test("an empty alias matches nothing", () => {
    expect(count("SELECT 1", "")).toBe(0);
  });
});

describe("rewriteAlias", () => {
  test("rewrites references and keeps everything else byte for byte", () => {
    const sql = "-- sales.main.t stays\nSELECT 'sales.main.t', sales.amount\nFROM sales.main.orders AS sales\nJOIN sales.main.items i ON true";
    expect(rewriteAlias(sql, "sales", "sales_eu")).toBe("-- sales.main.t stays\nSELECT 'sales.main.t', sales.amount\nFROM sales_eu.main.orders AS sales\nJOIN sales_eu.main.items i ON true");
  });
  test("keeps quoting style, quoting the new alias only when it must", () => {
    expect(rewriteAlias(`SELECT * FROM "sales".main.t`, "sales", "eu")).toBe(`SELECT * FROM "eu".main.t`);
    expect(rewriteAlias("SELECT * FROM sales.main.t", "sales", "eu")).toBe("SELECT * FROM eu.main.t");
    expect(rewriteAlias("SELECT * FROM sales.main.t", "sales", "select")).toBe(`SELECT * FROM "select".main.t`);
    expect(rewriteAlias("SELECT * FROM sales.main.t", "sales", "Mixed Case")).toBe(`SELECT * FROM "Mixed Case".main.t`);
    expect(rewriteAlias(`SELECT * FROM "sales".main.t`, "sales", `a"b`)).toBe(`SELECT * FROM "a""b".main.t`);
  });
  test("matches case-insensitively", () => {
    expect(rewriteAlias("SELECT * FROM SALES.main.t, Sales.main.u", "sales", "eu")).toBe("SELECT * FROM eu.main.t, eu.main.u");
  });
  test("no references: the same text", () => {
    const sql = "SELECT sales FROM t";
    expect(rewriteAlias(sql, "sales", "eu")).toBe(sql);
  });
  test("several aliases at once, so a swap works", () => {
    const result = rewriteAliases("SELECT * FROM a.main.t JOIN b.main.u ON true", { a: "b", b: "a" });
    expect(result).toEqual({ text: "SELECT * FROM b.main.t JOIN a.main.u ON true", count: 2 });
  });
  test("USE and DETACH are rewritten", () => {
    expect(rewriteAlias("USE sales; USE sales.main; DETACH sales;", "sales", "eu")).toBe("USE eu; USE eu.main; DETACH eu;");
  });
});

describe("identifier quoting", () => {
  test("needsQuoting", () => {
    expect(needsQuoting("sales_eu")).toBe(false);
    expect(needsQuoting("_x1")).toBe(false);
    expect(needsQuoting("1x")).toBe(true);
    expect(needsQuoting("from")).toBe(true);
    expect(needsQuoting("has space")).toBe(true);
  });
  test("identifierText", () => {
    expect(identifierText("eu")).toBe("eu");
    expect(identifierText("eu", true)).toBe(`"eu"`);
    expect(identifierText("order")).toBe(`"order"`);
  });
});
