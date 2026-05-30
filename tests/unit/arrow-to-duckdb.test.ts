/**
 * Tests for arrowTypeToDuckDB / mapTypeString in src/lib/arrow-to-duckdb.ts.
 *
 * Regression guard: apache-arrow's Decimal.toString() emits the bracket form
 * `Decimal[<precision>e<±scale>]` (e.g. "Decimal[18e+4]"), NOT the
 * `Decimal128(p, s)` function form. The mapper must turn that into
 * DECIMAL(p, s) so the schema listing doesn't show the raw Arrow string.
 */
import { test, expect, describe } from "bun:test";

const { arrowTypeToDuckDB } = await import("../../src/lib/arrow-to-duckdb");

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
