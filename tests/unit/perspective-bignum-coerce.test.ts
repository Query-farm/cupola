/**
 * Tests for coerceArrowBufferForPerspective in src/lib/perspective-bignum-coerce.ts.
 *
 * Regression coverage for the "null pointer passed to rust" crash: Perspective's
 * static-snapshot loader (upstream C++ arrow_loader.cpp) can't ingest DuckDB's
 * lossless HUGEINT/UHUGEINT/BIGNUM/VARINT extension columns (raw-bytes
 * FixedSizeBinary/Binary), and aborts table construction instead of throwing a
 * catchable JS error — see the module doc comment for the full chain.
 */
import { test, expect, describe } from "bun:test";
import { Field, FixedSizeBinary, Binary, RecordBatch, Schema, Struct, Table, Utf8, makeData, tableFromIPC, tableToIPC, vectorFromArray, type Vector } from "@query-farm/apache-arrow";

const { coerceArrowBufferForPerspective } = await import("../../src/lib/perspective-bignum-coerce");

/** Encode a signed/unsigned 128-bit value as little-endian bytes, matching
 *  what DuckDB's Arrow export produces for HUGEINT/UHUGEINT under
 *  arrowLosslessConversion (mirrors format.ts's readInt128 layout). */
function int128Bytes(value: bigint): Uint8Array {
  const buf = new ArrayBuffer(16);
  const view = new DataView(buf);
  const unsigned = value < 0n ? (1n << 128n) + value : value;
  view.setBigUint64(0, unsigned & 0xFFFFFFFFFFFFFFFFn, true);
  view.setBigUint64(8, (unsigned >> 64n) & 0xFFFFFFFFFFFFFFFFn, true);
  return new Uint8Array(buf);
}

/** Encode DuckDB's BIGNUM/VARINT wire format: 3-byte header (sign bit +
 *  23-bit magnitude byte count) + big-endian magnitude, inverted when
 *  negative (mirrors format.ts's bignumBytesToBigInt layout). */
function bignumBytes(value: bigint): Uint8Array {
  const isPositive = value >= 0n;
  let magnitude = isPositive ? value : -value;
  const bytes: number[] = [];
  if (magnitude === 0n) bytes.push(0);
  while (magnitude > 0n) {
    bytes.unshift(Number(magnitude & 0xFFn));
    magnitude >>= 8n;
  }
  const dataSize = bytes.length;
  const header = [
    (isPositive ? 0x80 : 0) | ((dataSize >> 16) & 0x7F),
    (dataSize >> 8) & 0xFF,
    dataSize & 0xFF,
  ];
  const data = isPositive ? bytes : bytes.map((b) => (~b) & 0xFF);
  return new Uint8Array([...header, ...data]);
}

function extensionMetadata(typeName: string): Map<string, string> {
  return new Map([
    ["ARROW:extension:name", "arrow.opaque"],
    ["ARROW:extension:metadata", JSON.stringify({ type_name: typeName })],
  ]);
}

function tableToBuffer(table: Table): ArrayBuffer {
  const bytes = tableToIPC(table);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Build a single-batch Table from a schema and one Vector per field, in
 *  order. `new Table(schema, ...vectors)` doesn't work here — the Table
 *  constructor's `unwrap` treats a bare Vector as an iterable of its row
 *  values (spreading a Utf8 vector into per-character recursion), not as a
 *  column — so batches must be built explicitly via `makeData`/`RecordBatch`,
 *  the same route `Table.setChildAt` uses internally. */
function buildTable(schema: Schema, vectors: Vector[]): Table {
  const length = vectors[0]?.length ?? 0;
  const structData = makeData({
    type: new Struct(schema.fields),
    length,
    children: vectors.map((v) => v.data[0]),
  });
  return new Table(schema, new RecordBatch(schema, structData));
}

describe("coerceArrowBufferForPerspective", () => {
  test("ordinary buffer with no extension columns passes through unchanged (same reference)", () => {
    const schema = new Schema([new Field("name", new Utf8(), true)]);
    const nameVector = vectorFromArray(["alice", "bob"], new Utf8());
    const buffer = tableToBuffer(buildTable(schema, [nameVector]));

    const result = coerceArrowBufferForPerspective(buffer);
    expect(result).toBe(buffer);
  });

  test("HUGEINT column is flattened to Float64, values preserved within safe range", () => {
    const schema = new Schema([
      new Field("id", new Utf8(), true),
      new Field("total", new FixedSizeBinary(16), true, extensionMetadata("hugeint")),
    ]);
    const idVector = vectorFromArray(["a", "b", "c"], new Utf8());
    const totalVector = vectorFromArray(
      [int128Bytes(42n), int128Bytes(-1234567890n), null],
      new FixedSizeBinary(16),
    );
    const buffer = tableToBuffer(buildTable(schema, [idVector, totalVector]));

    const result = coerceArrowBufferForPerspective(buffer);
    expect(result).not.toBe(buffer);

    const decoded = tableFromIPC(new Uint8Array(result));
    const field = decoded.schema.fields.find((f) => f.name === "total")!;
    expect(field.type.toString()).toBe("Float64");
    expect(field.metadata.get("ARROW:extension:name")).toBeUndefined();

    const column = decoded.getChild("total")!;
    expect(column.get(0)).toBe(42);
    expect(column.get(1)).toBe(-1234567890);
    expect(column.get(2)).toBe(null);
  });

  test("UHUGEINT column decodes as unsigned", () => {
    const schema = new Schema([
      new Field("total", new FixedSizeBinary(16), true, extensionMetadata("uhugeint")),
    ]);
    const totalVector = vectorFromArray([int128Bytes(999999999999n)], new FixedSizeBinary(16));
    const buffer = tableToBuffer(buildTable(schema, [totalVector]));

    const decoded = tableFromIPC(new Uint8Array(coerceArrowBufferForPerspective(buffer)));
    expect(decoded.getChild("total")!.get(0)).toBe(999999999999);
  });

  test("BIGNUM/VARINT column is flattened to Float64", () => {
    const schema = new Schema([
      new Field("amount", new Binary(), true, extensionMetadata("bignum")),
    ]);
    const amountVector = vectorFromArray(
      [bignumBytes(2200620179644536746n), bignumBytes(-500n), null],
      new Binary(),
    );
    const buffer = tableToBuffer(buildTable(schema, [amountVector]));

    const decoded = tableFromIPC(new Uint8Array(coerceArrowBufferForPerspective(buffer)));
    const field = decoded.schema.fields.find((f) => f.name === "amount")!;
    expect(field.type.toString()).toBe("Float64");

    const column = decoded.getChild("amount")!;
    expect(column.get(0)).toBeCloseTo(2200620179644536746, -5); // beyond 2^53: lossy by design
    expect(column.get(1)).toBe(-500);
    expect(column.get(2)).toBe(null);
  });

  test("value beyond Number.MAX_SAFE_INTEGER degrades to an imprecise double rather than throwing", () => {
    const schema = new Schema([
      new Field("total", new FixedSizeBinary(16), true, extensionMetadata("hugeint")),
    ]);
    const huge = 170141183460469231731687303715884105727n; // near i128::MAX
    const totalVector = vectorFromArray([int128Bytes(huge)], new FixedSizeBinary(16));
    const buffer = tableToBuffer(buildTable(schema, [totalVector]));

    expect(() => coerceArrowBufferForPerspective(buffer)).not.toThrow();
    const decoded = tableFromIPC(new Uint8Array(coerceArrowBufferForPerspective(buffer)));
    const value = decoded.getChild("total")!.get(0) as number;
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThan(0);
  });

  test("unrelated non-numeric extension types (e.g. uuid) are left untouched", () => {
    const schema = new Schema([
      new Field("id", new FixedSizeBinary(16), true, extensionMetadata("uuid")),
    ]);
    const idVector = vectorFromArray([int128Bytes(1n)], new FixedSizeBinary(16));
    const buffer = tableToBuffer(buildTable(schema, [idVector]));

    const result = coerceArrowBufferForPerspective(buffer);
    expect(result).toBe(buffer);
  });

  test("malformed buffer falls back to the original reference instead of throwing", () => {
    const garbage = new ArrayBuffer(8);
    expect(() => coerceArrowBufferForPerspective(garbage)).not.toThrow();
    expect(coerceArrowBufferForPerspective(garbage)).toBe(garbage);
  });
});
