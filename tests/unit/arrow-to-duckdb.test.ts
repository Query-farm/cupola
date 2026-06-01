/**
 * Tests for arrowTypeToDuckDB / mapTypeString in src/lib/arrow-to-duckdb.ts.
 *
 * Regression guard: apache-arrow's Decimal.toString() emits the bracket form
 * `Decimal[<precision>e<±scale>]` (e.g. "Decimal[18e+4]"), NOT the
 * `Decimal128(p, s)` function form. The mapper must turn that into
 * DECIMAL(p, s) so the schema listing doesn't show the raw Arrow string.
 */
import { test, expect, describe } from "bun:test";

const { arrowTypeToDuckDB, shortTypeName, formatTypeMultiline } = await import("../../src/lib/arrow-to-duckdb");

// Minimal stand-in for an Arrow DataType: only toString() is consulted.
const t = (s: string) => ({ toString: () => s }) as any;

describe("arrowTypeToDuckDB — Decimal", () => {
  test("bracket form with positive scale → DECIMAL(p,s)", () => {
    expect(arrowTypeToDuckDB(t("Decimal[18e+4]"))).toBe("DECIMAL(18,4)");
    expect(arrowTypeToDuckDB(t("Decimal[38e+10]"))).toBe("DECIMAL(38,10)");
  });

  test("bracket form with zero scale → DECIMAL(p,0)", () => {
    expect(arrowTypeToDuckDB(t("Decimal[18e0]"))).toBe("DECIMAL(18,0)");
  });

  test("bracket form with negative scale → DECIMAL(p,-s)", () => {
    expect(arrowTypeToDuckDB(t("Decimal[10e-2]"))).toBe("DECIMAL(10,-2)");
  });

  test("nested inside a list → DECIMAL(p,s)[]", () => {
    expect(arrowTypeToDuckDB(t("List<item: Decimal[18e+4]>"))).toBe("DECIMAL(18,4)[]");
  });

  test("function-call fallback form still maps", () => {
    expect(arrowTypeToDuckDB(t("Decimal128(18, 4)"))).toBe("DECIMAL(18, 4)");
    expect(arrowTypeToDuckDB(t("Decimal256(38, 10)"))).toBe("DECIMAL(38, 10)");
  });
});

describe("arrowTypeToDuckDB — sanity", () => {
  test("simple types still map", () => {
    expect(arrowTypeToDuckDB(t("Int64"))).toBe("BIGINT");
    expect(arrowTypeToDuckDB(t("Utf8"))).toBe("VARCHAR");
  });
});

describe("arrowTypeToDuckDB — struct recursion", () => {
  test("inner field types are converted to DuckDB names", () => {
    expect(arrowTypeToDuckDB(t("Struct<{a: Utf8, b: Int64, c: Float64}>")))
      .toBe("STRUCT<{a: VARCHAR, b: BIGINT, c: DOUBLE}>");
  });

  test("nested struct converts at every level", () => {
    expect(arrowTypeToDuckDB(t("Struct<{outer: Int32, inner: Struct<{x: Utf8}>}>")))
      .toBe("STRUCT<{outer: INTEGER, inner: STRUCT<{x: VARCHAR}>}>");
  });

  test("list of struct → STRUCT<{...}>[]", () => {
    expect(arrowTypeToDuckDB(t("List<item: Struct<{x: Int64}>>")))
      .toBe("STRUCT<{x: BIGINT}>[]");
  });

  test("struct containing a list and a map", () => {
    expect(arrowTypeToDuckDB(t("Struct<{tags: List<item: Utf8>, props: Map<{key: Utf8, value: Int64}>}>")))
      .toBe("STRUCT<{tags: VARCHAR[], props: MAP(VARCHAR, BIGINT)}>");
  });
});

describe("arrowTypeToDuckDB — map recursion", () => {
  test("plain key/value form", () => {
    expect(arrowTypeToDuckDB(t("Map<{key: Utf8, value: Utf8}>"))).toBe("MAP(VARCHAR, VARCHAR)");
  });

  test("entries-wrapped form", () => {
    expect(arrowTypeToDuckDB(t("Map<entries: Struct<{key: Utf8, value: Int64}>>")))
      .toBe("MAP(VARCHAR, BIGINT)");
  });
});

describe("shortTypeName", () => {
  test("collapses a struct to STRUCT", () => {
    expect(shortTypeName("STRUCT<{a: VARCHAR, b: BIGINT}>")).toBe("STRUCT");
  });

  test("preserves [] for a list of struct", () => {
    expect(shortTypeName("STRUCT<{a: VARCHAR}>[]")).toBe("STRUCT[]");
  });

  test("leaves scalar and other types unchanged", () => {
    expect(shortTypeName("VARCHAR")).toBe("VARCHAR");
    expect(shortTypeName("DECIMAL(18,4)")).toBe("DECIMAL(18,4)");
    expect(shortTypeName("VARCHAR[]")).toBe("VARCHAR[]");
    expect(shortTypeName("MAP(VARCHAR, BIGINT)")).toBe("MAP(VARCHAR, BIGINT)");
  });
});

describe("formatTypeMultiline", () => {
  test("adds newlines and indentation for a struct", () => {
    // Indentation tracks full bracket depth — `<` and `{` each add a level.
    expect(formatTypeMultiline("STRUCT<{a: VARCHAR, b: BIGINT}>")).toBe(
      "STRUCT<{\n    a: VARCHAR,\n    b: BIGINT\n  }>"
    );
  });

  test("round-trips: stripping whitespace yields the original", () => {
    const type = "STRUCT<{a: VARCHAR, b: STRUCT<{x: BIGINT, y: VARCHAR[]}>, c: MAP(VARCHAR, BIGINT)}>";
    const strip = (s: string) => s.replace(/\s+/g, "");
    expect(strip(formatTypeMultiline(type))).toBe(strip(type));
  });

  test("leaves a scalar type unchanged", () => {
    expect(formatTypeMultiline("VARCHAR")).toBe("VARCHAR");
    expect(formatTypeMultiline("DECIMAL(18,4)")).toBe("DECIMAL(18,4)");
  });
});
