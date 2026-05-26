/**
 * Unit tests for the AI query-result serializer (src/lib/query-results.ts).
 *
 * These lock in that the AI's JSON view matches the shell/grid display path and guard the
 * specific divergences that previously fed the model wrong values (HUGEINT double-escaping,
 * lossy timestamps, garbled TIME/INTERVAL, etc.). They build Arrow columns with explicit
 * DuckDB-shaped types — the same shape DuckDB-WASM emits — and run them through the real
 * serializer, asserting the JSON the model receives.
 */
import { test, expect, describe } from "bun:test";
import {
  makeData, Vector, Table, vectorFromArray,
  Decimal, Timestamp, TimeUnit, TimeMicrosecond,
  Int32, Int64, Float64,
} from "apache-arrow";
import { formatArrowTableAsJson } from "../../src/lib/query-results";

/** First-cell value from a column built out of JS values (strings, booleans, …). */
function cellFromArray(name: string, values: any[]): any {
  const t = new Table({ [name]: vectorFromArray(values) });
  return JSON.parse(formatArrowTableAsJson(t).json).rows[0][name];
}

/** Build a single-column Arrow Table from an explicit type + chunk Data. */
function tableOf(name: string, type: any, data: any, opts: { nullBitmap?: Uint8Array; nullCount?: number } = {}): any {
  const length = data.length / (type instanceof Decimal ? 4 : 1);
  const d = makeData({ type, length, data, ...opts });
  const vec = new Vector([d]);
  return new Table({ [name]: vec });
}

/** Run a one-column, one-row table through the serializer and return that cell value. */
function cell(name: string, type: any, data: any): any {
  const { json } = formatArrowTableAsJson(tableOf(name, type, data));
  return JSON.parse(json).rows[0][name];
}

describe("HUGEINT / DECIMAL (the original SUM() bug)", () => {
  test("HUGEINT (Decimal128 scale 0) → plain integer string, not double-escaped", () => {
    // SUM(1,2,3) => HUGEINT => Decimal128(38,0) holding 6
    const v = cell("s", new Decimal(0, 38, 128), Uint32Array.from([6, 0, 0, 0]));
    expect(v).toBe("6");                 // not "\"\\\"6\\\"\""
  });

  test("DECIMAL(10,2) applies scale", () => {
    const v = cell("d", new Decimal(2, 10, 128), Uint32Array.from([12345, 0, 0, 0])); // 123.45
    expect(v).toBe("123.45");
  });

  test("large HUGEINT keeps full precision (exceeds Number.MAX_SAFE_INTEGER)", () => {
    // 2^64 + 1 = 18446744073709551617
    const v = cell("s", new Decimal(0, 38, 128), Uint32Array.from([1, 0, 1, 0]));
    expect(v).toBe("18446744073709551617");
  });
});

describe("numeric & temporal parity with the display path", () => {
  test("BIGINT (Int64) → integer string", () => {
    expect(cell("c", new Int64(), BigInt64Array.from([42n]))).toBe("42");
  });
  test("INTEGER (Int32) → integer string", () => {
    expect(cell("m", new Int32(), Int32Array.from([3]))).toBe("3");
  });
  test("DOUBLE → 2.0 style", () => {
    expect(cell("a", new Float64(), Float64Array.from([2]))).toBe("2.0");
  });
  test("TIMESTAMP(us) → native-precision, not off by 1000x", () => {
    // 2021-01-01T00:00:00Z = 1609459200000000 us
    const v = cell("t", new Timestamp(TimeUnit.MICROSECOND), BigInt64Array.from([1609459200000000n]));
    expect(v).toBe("2021-01-01 00:00:00");
  });
  test("TIME(us) → HH:MM:SS, not garbled hours", () => {
    // 01:02:03 = 3723000000 us
    const v = cell("tm", new TimeMicrosecond(), BigInt64Array.from([3723000000n]));
    expect(v).toBe("01:02:03");
  });
});

describe("scalars & null", () => {
  test("VARCHAR passthrough", () => {
    expect(cellFromArray("s", ["hi"])).toBe("hi");
  });
  test("BOOLEAN → true/false string", () => {
    expect(cellFromArray("b", [true])).toBe("true");
  });
  test("NULL stays JSON null (not empty string)", () => {
    const t = tableOf("n", new Int32(), Int32Array.from([0]),
      { nullCount: 1, nullBitmap: new Uint8Array([0]) });
    expect(JSON.parse(formatArrowTableAsJson(t).json).rows[0].n).toBeNull();
  });
});

describe("no double-escaping anywhere in the JSON", () => {
  test("serialized JSON for HUGEINT contains a clean value", () => {
    const { json } = formatArrowTableAsJson(tableOf("s", new Decimal(0, 38, 128), Uint32Array.from([6, 0, 0, 0])));
    expect(json).toContain('"s":"6"');
    expect(json).not.toContain('\\\\');   // no escaped backslashes => no nested stringify
  });
});
