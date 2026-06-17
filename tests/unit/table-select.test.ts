/**
 * Tests for the shared smart-insert helper (shell + editor).
 */
import { test, expect, describe, mock } from "bun:test";

// Stub getColumns so we don't need real Arrow-encoded TableInfo bytes.
mock.module("@/lib/service", () => ({
  getColumns: (t: any) => t._cols ?? [],
}));

const { buildTableSelect, isTableRef } = await import("../../src/lib/sql/table-select");

describe("isTableRef", () => {
  test("true for dotted identifiers", () => {
    expect(isTableRef("cat.schema.table")).toBe(true);
    expect(isTableRef("a.b")).toBe(true);
  });
  test("false for expressions / spaces / parens", () => {
    expect(isTableRef("SELECT 1")).toBe(false);
    expect(isTableRef("count(*)")).toBe(false);
    expect(isTableRef("plainname")).toBe(false);
    expect(isTableRef("a.b LIMIT 1")).toBe(false);
  });
});

describe("buildTableSelect", () => {
  const cat: any = {
    catalogName: "c",
    schemas: [
      {
        info: { name: "s" },
        tables: [
          { name: "plain", _cols: [{ name: "id", duckdbType: "INTEGER" }] },
          {
            name: "geo",
            _cols: [
              { name: "id", duckdbType: "INTEGER" },
              { name: "geom", duckdbType: "GEOMETRY" },
              { name: "shape", duckdbType: "GEOMETRY" },
            ],
          },
        ],
      },
    ],
  };

  test("no geometry → plain SELECT", () => {
    expect(buildTableSelect("c.s.plain", [cat])).toBe("SELECT * FROM c.s.plain LIMIT 100");
  });

  test("excludes geometry columns", () => {
    expect(buildTableSelect("c.s.geo", [cat])).toBe("SELECT * EXCLUDE (geom, shape) FROM c.s.geo LIMIT 100");
  });

  test("unknown table → plain SELECT (no exclusion)", () => {
    expect(buildTableSelect("c.s.missing", [cat])).toBe("SELECT * FROM c.s.missing LIMIT 100");
    expect(buildTableSelect("other.s.t", [cat])).toBe("SELECT * FROM other.s.t LIMIT 100");
  });

  test("tolerates null/empty catalogs", () => {
    expect(buildTableSelect("c.s.geo", [null, undefined])).toBe("SELECT * FROM c.s.geo LIMIT 100");
  });
});
