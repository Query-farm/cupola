/**
 * Tests for coerceArrowValue in src/lib/duckdb-query.ts.
 *
 * Every readRows() consumer relies on this — the function turns raw Arrow
 * scalars (BigInt, Date, structs) into JSON-safe / Vega-safe values. A
 * regression here would manifest as TypeError: Do not know how to
 * serialize a BigInt at runtime, far from the actual coercion site.
 */
import { test, expect, describe, mock } from "bun:test";
import { BN } from "@query-farm/apache-arrow/util/bn";

// service.ts pulls @query-farm/vgi-rpc/connect which doesn't resolve under bun
// without an alias; stub before importing duckdb-query (transitive dep).
mock.module("@query-farm/vgi-rpc/connect", () => ({ httpConnect: () => { throw new Error("stub"); } }));

const { coerceArrowValue } = await import("../../src/lib/duckdb-query");

/** Build the same BigNum wrapper apache-arrow's Decimal128 visitor returns
 *  from `.get(i)` (visitor/get.mjs: `getDecimal` → `BN.decimal(...)`), for
 *  a DuckDB DECIMAL/HUGEINT/UHUGEINT column under arrowLosslessConversion. */
function decimalBigNumFor(value: bigint): unknown {
  const buf = new ArrayBuffer(16); // Decimal128 = 16 bytes, little-endian
  const view = new DataView(buf);
  view.setBigUint64(0, value & 0xFFFFFFFFFFFFFFFFn, true);
  view.setBigUint64(8, value < 0n ? 0xFFFFFFFFFFFFFFFFn : 0n, true);
  return BN.decimal(new Uint32Array(buf));
}

describe("coerceArrowValue", () => {
  test("BigInt in safe range → Number", () => {
    expect(coerceArrowValue(42n)).toBe(42);
    expect(coerceArrowValue(0n)).toBe(0);
    expect(coerceArrowValue(-1234567890n)).toBe(-1234567890);
  });

  test("BigInt above MAX_SAFE_INTEGER → string", () => {
    const big = BigInt(Number.MAX_SAFE_INTEGER) + 1n; // 2^53
    const result = coerceArrowValue(big);
    expect(typeof result).toBe("string");
    expect(result).toBe(big.toString());
  });

  test("BigInt below -MAX_SAFE_INTEGER → string", () => {
    const negBig = -(BigInt(Number.MAX_SAFE_INTEGER) + 1n);
    const result = coerceArrowValue(negBig);
    expect(typeof result).toBe("string");
    expect(result).toBe(negBig.toString());
  });

  test("Arrow BigNum (DECIMAL/HUGEINT) in safe range → Number", () => {
    expect(coerceArrowValue(decimalBigNumFor(42n))).toBe(42);
    expect(coerceArrowValue(decimalBigNumFor(-1234567890n))).toBe(-1234567890);
  });

  test("Arrow BigNum above MAX_SAFE_INTEGER → string, not a thrown TypeError", () => {
    // Regression: Number(bigNum) throws "<n> is not safe to convert to a
    // number" from apache-arrow's bigIntToNumber instead of losing
    // precision like Number(bigint) does. Reports' ReportKpi crashed on
    // exactly this for a DECIMAL/HUGEINT column with a large value.
    const big = 2200620179644536746n;
    const result = coerceArrowValue(decimalBigNumFor(big));
    expect(typeof result).toBe("string");
    expect(result).toBe(big.toString());
  });

  test("Date → epoch ms", () => {
    const d = new Date("2024-01-15T00:00:00Z");
    expect(coerceArrowValue(d)).toBe(d.getTime());
  });

  test("plain object with nested BigInts is recursed", () => {
    const v = { a: 1n, b: { c: 99n, d: "ok" } };
    const out = coerceArrowValue(v);
    expect(out.a).toBe(1);
    expect(out.b.c).toBe(99);
    expect(out.b.d).toBe("ok");
  });

  test("array of BigInts is mapped", () => {
    expect(coerceArrowValue([1n, 2n, 3n])).toEqual([1, 2, 3]);
  });

  test("primitives pass through unchanged", () => {
    expect(coerceArrowValue(null)).toBe(null);
    expect(coerceArrowValue(undefined)).toBe(undefined);
    expect(coerceArrowValue("hello")).toBe("hello");
    expect(coerceArrowValue(3.14)).toBe(3.14);
    expect(coerceArrowValue(true)).toBe(true);
    expect(coerceArrowValue(false)).toBe(false);
  });

  test("Uint8Array passes through (typed arrays preserved for binary data)", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const out = coerceArrowValue(bytes);
    expect(out).toBe(bytes);
  });

  test("result of coerce can always be JSON.stringify'd", () => {
    // The actual regression this guards against: render_chart's sample
    // field was JSON.stringify'ing rows containing BigInts and throwing.
    const row = { id: 42n, label: "x", nested: { count: 999999999999999999n } };
    const safe = coerceArrowValue(row);
    expect(() => JSON.stringify(safe)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(safe));
    expect(parsed.id).toBe(42);
    expect(typeof parsed.nested.count).toBe("string"); // overflow → string
  });
});
