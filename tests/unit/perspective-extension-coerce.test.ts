/**
 * Tests for coerceArrowBufferForPerspective in src/lib/perspective-extension-coerce.ts.
 *
 * Regression coverage for two symptoms of the same cause: DuckDB's lossless
 * Arrow export wraps HUGEINT/UHUGEINT/BIGNUM/VARINT/BIT/TIME_TZ/UUID columns
 * in canonical Arrow extension types, which the vendored Perspective fork's
 * upstream C++ arrow_loader.cpp can't ingest —
 *   - "Could not load Arrow column of type `extension`" when it aborts
 *     inside `table()` itself, and
 *   - "null pointer passed to rust" when the abort instead leaves an invalid
 *     table handle that `viewer.load()` dereferences.
 * See the module doc comment for the full chain.
 */
import { test, expect, describe } from "bun:test";
import { Binary, Field, FixedSizeBinary, Int8, RecordBatch, Schema, Struct, Table, Utf8, makeData, tableFromIPC, tableToIPC, vectorFromArray, type Vector } from "@query-farm/apache-arrow";

const { coerceArrowBufferForPerspective } = await import("../../src/lib/perspective-extension-coerce");

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

/** Encode DuckDB's BIT wire format: first byte is the padding-bit count,
 *  remaining bytes are the bitstring (mirrors format.ts's formatBitString). */
function bitBytes(paddingBits: number, bits: string): Uint8Array {
  const padded = "0".repeat(paddingBits) + bits;
  const bytes: number[] = [paddingBits];
  for (let i = 0; i < padded.length; i += 8) {
    bytes.push(parseInt(padded.slice(i, i + 8).padEnd(8, "0"), 2));
  }
  return new Uint8Array(bytes);
}

/** Encode DuckDB's TIME_TZ wire format: bits[63:24] = microseconds,
 *  bits[23:0] = 57599 - offset_seconds (mirrors format.ts's
 *  formatFixedBinaryTimeTz). */
function timeTzBytes(micros: number, offsetSecs: number): Uint8Array {
  const raw = (BigInt(micros) << 24n) | BigInt(57599 - offsetSecs);
  const buf = new ArrayBuffer(8);
  new DataView(buf).setBigUint64(0, raw, true);
  return new Uint8Array(buf);
}

function uuidBytes(hex: string): Uint8Array {
  const clean = hex.replace(/-/g, "");
  return new Uint8Array(clean.match(/../g)!.map((h) => parseInt(h, 16)));
}

/** Metadata for one of DuckDB's own extension types, riding the canonical
 *  `arrow.opaque` wrapper (see the module doc comment). */
function opaqueMetadata(typeName: string): Map<string, string> {
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
      new Field("total", new FixedSizeBinary(16), true, opaqueMetadata("hugeint")),
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
      new Field("total", new FixedSizeBinary(16), true, opaqueMetadata("uhugeint")),
    ]);
    const totalVector = vectorFromArray([int128Bytes(999999999999n)], new FixedSizeBinary(16));
    const buffer = tableToBuffer(buildTable(schema, [totalVector]));

    const decoded = tableFromIPC(new Uint8Array(coerceArrowBufferForPerspective(buffer)));
    expect(decoded.getChild("total")!.get(0)).toBe(999999999999);
  });

  test("BIGNUM/VARINT column is flattened to Float64", () => {
    const schema = new Schema([
      new Field("amount", new Binary(), true, opaqueMetadata("bignum")),
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
      new Field("total", new FixedSizeBinary(16), true, opaqueMetadata("hugeint")),
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

  test("BIT column is flattened to a formatted bitstring", () => {
    const schema = new Schema([
      new Field("flags", new Binary(), true, opaqueMetadata("bit")),
    ]);
    const flagsVector = vectorFromArray([bitBytes(3, "10101"), null], new Binary());
    const buffer = tableToBuffer(buildTable(schema, [flagsVector]));

    const decoded = tableFromIPC(new Uint8Array(coerceArrowBufferForPerspective(buffer)));
    const field = decoded.schema.fields.find((f) => f.name === "flags")!;
    expect(field.type.toString()).toBe("Utf8");
    expect(field.metadata.get("ARROW:extension:name")).toBeUndefined();

    const column = decoded.getChild("flags")!;
    expect(column.get(0)).toBe("10101");
    expect(column.get(1)).toBe(null);
  });

  test("TIME_TZ column is flattened to a formatted time+offset string", () => {
    const schema = new Schema([
      new Field("t", new FixedSizeBinary(8), true, opaqueMetadata("time_tz")),
    ]);
    const tVector = vectorFromArray([timeTzBytes(12 * 3600 * 1_000_000, -18000)], new FixedSizeBinary(8)); // 12:00:00-05:00
    const buffer = tableToBuffer(buildTable(schema, [tVector]));

    const decoded = tableFromIPC(new Uint8Array(coerceArrowBufferForPerspective(buffer)));
    const field = decoded.schema.fields.find((f) => f.name === "t")!;
    expect(field.type.toString()).toBe("Utf8");
    expect(decoded.getChild("t")!.get(0)).toBe("12:00:00-05");
  });

  test("UUID column (DuckDB type_name metadata) is flattened to a formatted string", () => {
    const schema = new Schema([
      new Field("id", new FixedSizeBinary(16), true, opaqueMetadata("uuid")),
    ]);
    const idVector = vectorFromArray([uuidBytes("12345678-1234-5678-1234-567812345678")], new FixedSizeBinary(16));
    const buffer = tableToBuffer(buildTable(schema, [idVector]));

    const decoded = tableFromIPC(new Uint8Array(coerceArrowBufferForPerspective(buffer)));
    const field = decoded.schema.fields.find((f) => f.name === "id")!;
    expect(field.type.toString()).toBe("Utf8");
    expect(decoded.getChild("id")!.get(0)).toBe("12345678-1234-5678-1234-567812345678");
  });

  test("UUID column (canonical arrow.uuid extension name) is also flattened", () => {
    const schema = new Schema([
      new Field("id", new FixedSizeBinary(16), true, new Map([["ARROW:extension:name", "arrow.uuid"]])),
    ]);
    const idVector = vectorFromArray([uuidBytes("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")], new FixedSizeBinary(16));
    const buffer = tableToBuffer(buildTable(schema, [idVector]));

    const decoded = tableFromIPC(new Uint8Array(coerceArrowBufferForPerspective(buffer)));
    expect(decoded.getChild("id")!.get(0)).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  });

  test("geoarrow.* geometry columns are untagged but left as raw WKB bytes", () => {
    const wkb = new Uint8Array([1, 2, 3, 4]);
    const schema = new Schema([
      new Field("geom", new Binary(), true, new Map([["ARROW:extension:name", "geoarrow.wkb"]])),
    ]);
    const geomVector = vectorFromArray([wkb], new Binary());
    const buffer = tableToBuffer(buildTable(schema, [geomVector]));

    const decoded = tableFromIPC(new Uint8Array(coerceArrowBufferForPerspective(buffer)));
    const field = decoded.schema.fields.find((f) => f.name === "geom")!;
    expect(field.type.toString()).toBe("Binary");
    expect(field.metadata.get("ARROW:extension:name")).toBeUndefined();
    expect(decoded.getChild("geom")!.get(0)).toEqual(wkb);
  });

  test("arrow.bool8 column is flattened to a native Bool, not left as a raw 0/1 integer", () => {
    // DuckDB registers arrow.bool8 with Arrow C Data Interface format "c"
    // (Int8) — one full byte per value, not Arrow's native bit-packed Bool —
    // so leaving it as its bare storage type would show as an integer
    // column in Perspective instead of a boolean one.
    const schema = new Schema([
      new Field("active", new Int8(), true, new Map([["ARROW:extension:name", "arrow.bool8"]])),
    ]);
    const activeVector = vectorFromArray([1, 0, null], new Int8());
    const buffer = tableToBuffer(buildTable(schema, [activeVector]));

    const decoded = tableFromIPC(new Uint8Array(coerceArrowBufferForPerspective(buffer)));
    const field = decoded.schema.fields.find((f) => f.name === "active")!;
    expect(field.type.toString()).toBe("Bool");
    expect(field.metadata.get("ARROW:extension:name")).toBeUndefined();

    const column = decoded.getChild("active")!;
    expect(column.get(0)).toBe(true);
    expect(column.get(1)).toBe(false);
    expect(column.get(2)).toBe(null);
  });

  test("an extension name this function doesn't recognize is untagged, storage type and values unchanged", () => {
    const schema = new Schema([
      new Field("flag", new FixedSizeBinary(1), true, new Map([["ARROW:extension:name", "arrow.some_future_type"]])),
    ]);
    const flagVector = vectorFromArray([new Uint8Array([1])], new FixedSizeBinary(1));
    const buffer = tableToBuffer(buildTable(schema, [flagVector]));

    const decoded = tableFromIPC(new Uint8Array(coerceArrowBufferForPerspective(buffer)));
    const field = decoded.schema.fields.find((f) => f.name === "flag")!;
    expect(field.type.toString()).toBe("FixedSizeBinary[1]");
    expect(field.metadata.get("ARROW:extension:name")).toBeUndefined();
    expect(decoded.getChild("flag")!.get(0)).toEqual(new Uint8Array([1]));
  });

  test("malformed buffer falls back to the original reference instead of throwing", () => {
    const garbage = new ArrayBuffer(8);
    expect(() => coerceArrowBufferForPerspective(garbage)).not.toThrow();
    expect(coerceArrowBufferForPerspective(garbage)).toBe(garbage);
  });
});
