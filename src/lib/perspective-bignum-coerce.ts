/**
 * Perspective's static-snapshot ingestion path (`perspectiveWorker.table()`
 * in `DuckDBShell.tsx`'s `loadPerspective`) runs through the vendored fork's
 * upstream C++ Arrow loader (`arrow_loader.cpp`), which only understands
 * standard Arrow logical types.
 *
 * Under `arrowLosslessConversion: true` (`duckdb-worker-boot.ts`), DuckDB
 * exports HUGEINT/UHUGEINT and oversized-precision DECIMAL/BIGNUM results as
 * `FixedSizeBinary`/`Binary` columns tagged with `ARROW:extension:name` /
 * `ARROW:extension:metadata` (see `format.ts`'s `getDuckDBExtensionType`).
 * The C++ loader's column-fill switch has no case for those — it falls into
 * `default: PSP_COMPLAIN_AND_ABORT`, table construction never completes, and
 * the JS-visible table handle ends up null. `viewer.load()` then dereferences
 * it through wasm-bindgen glue, which throws its generic null-object guard:
 * "null pointer passed to rust" (wasm-bindgen's `rt::throw_null`).
 *
 * The DuckDB-aware *virtual server* Perspective path (`perspective-duckdb-handler.ts`,
 * backed by the fork's Rust `virtual_server/data.rs`) already handles these
 * same extension types — and even there, hugeint/uhugeint/bignum/varint are
 * converted to `Float64`, lossy past 2^53, because Perspective's own column
 * storage is f64-only regardless of source precision (see
 * `virtual_server/data.rs`'s "Lossy past 2^53 but keeps the column numeric
 * and sortable" comment). There is no lossless numeric path into Perspective
 * for these types — porting the Rust handling into the C++ loader would still
 * land on Float64.
 *
 * This coerces the same columns to `Float64` ahead of the static path's
 * ingestion, so it degrades exactly the way the virtual-server path already
 * does instead of crashing.
 */
import { Field, Float64, RecordBatch, Schema, Struct, Table, makeData, tableToIPC, vectorFromArray } from "@query-farm/apache-arrow";
import { tableFromIPCWithDictionaries } from "./duckdb-query";
import { bignumBytesToBigInt, getDuckDBExtensionType, readInt128 } from "./format";

/** DuckDB extension type names that arrive as raw bytes (FixedSizeBinary for
 *  hugeint/uhugeint, variable-length Binary for bignum/varint) and are
 *  otherwise numeric — safe to flatten to Float64 without changing their
 *  meaning. Deliberately excludes non-numeric extension types (uuid, bit,
 *  time_tz, geoarrow.*): those aren't crashing here, and Float64 would be the
 *  wrong shape for them. */
const NUMERIC_BIGNUM_TYPES = new Set(["hugeint", "uhugeint", "bignum", "varint"]);

/** Decode one column's raw bytes to a signed 64-bit-precision double,
 *  matching the virtual-server path's own hugeint/uhugeint/bignum handling. */
function bytesToFloat64(extType: string, bytes: Uint8Array): number {
  const big =
    extType === "hugeint" ? readInt128(bytes, true) :
    extType === "uhugeint" ? readInt128(bytes, false) :
    bignumBytesToBigInt(bytes); // "bignum" | "varint"
  return Number(big);
}

/**
 * Rewrite HUGEINT/UHUGEINT/BIGNUM/VARINT columns in an Arrow IPC buffer to
 * plain Float64, so Perspective's static-snapshot table loader can ingest
 * them instead of aborting. Returns the original buffer unchanged (same
 * reference) when no such columns are present — the common case — so callers
 * pay no re-serialization cost for ordinary result sets.
 *
 * Never throws: a decode/rebuild failure logs a warning and falls back to the
 * original buffer, since a crash-prone Perspective load is worse than one
 * that shows the raw column, and a totally broken load is worse than either.
 */
export function coerceArrowBufferForPerspective(arrowBuffer: ArrayBuffer): ArrayBuffer {
  try {
    const table = tableFromIPCWithDictionaries(arrowBuffer);
    const fields = table.schema.fields;

    // Decode each matching column across the whole table up front (Vector.get
    // walks chunk boundaries transparently), keyed by column index.
    const overrides = new Map<number, (number | null)[]>();
    const coercedNames: string[] = [];
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      const extType = getDuckDBExtensionType(field);
      if (!extType || !NUMERIC_BIGNUM_TYPES.has(extType)) continue;

      const column = table.getChildAt(i);
      if (!column) continue;

      const values: (number | null)[] = new Array(table.numRows);
      for (let row = 0; row < table.numRows; row++) {
        const raw = column.get(row);
        values[row] = raw == null ? null : bytesToFloat64(extType, raw as Uint8Array);
      }
      overrides.set(i, values);
      coercedNames.push(`${field.name} (${extType})`);
    }

    if (overrides.size === 0) return arrowBuffer;
    console.warn(`[perspective] coerced ${overrides.size} column(s) to Float64 for Perspective compatibility: ${coercedNames.join(", ")}`);

    // Fresh Fields for the overridden columns only: same name/nullability,
    // Float64 type, and the extension metadata dropped (it described the
    // raw-bytes encoding, which no longer applies). Deliberately NOT done via
    // `Table.setChild` — this fork's `Table.setChildAt` rebuilds the Struct
    // type from the *original* schema.fields rather than the field it just
    // cloned, so a same-named replacement with a different Arrow type gets
    // new data under the old (wrong) type tag instead of the new one.
    const newFields = fields.map((f, i) => (overrides.has(i) ? new Field(f.name, new Float64(), f.nullable, new Map()) : f));
    const newSchema = new Schema(newFields, table.schema.metadata);

    // Rebuild batch-by-batch so unaffected columns' underlying Data chunks
    // are reused as-is (no materialization, no risk of mangling types this
    // function doesn't need to touch — dictionaries, structs, decimals, …);
    // only the overridden columns get a fresh Float64 chunk per batch,
    // sliced from the full-column decode above.
    let rowOffset = 0;
    const newBatches = table.batches.map((batch) => {
      const length = batch.data.length;
      const children = batch.data.children.map((child, i) => {
        const values = overrides.get(i);
        if (!values) return child;
        return vectorFromArray(values.slice(rowOffset, rowOffset + length), new Float64()).data[0];
      });
      rowOffset += length;
      return new RecordBatch(newSchema, makeData({ type: new Struct(newFields), length, children }));
    });

    const bytes = tableToIPC(new Table(newSchema, newBatches));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  } catch (error: unknown) {
    console.warn("[perspective] bignum coercion failed, loading original buffer", error);
    return arrowBuffer;
  }
}
