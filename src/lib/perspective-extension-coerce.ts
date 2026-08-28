/**
 * Perspective's static-snapshot ingestion path (`perspectiveWorker.table()`
 * in `DuckDBShell.tsx`'s `loadPerspective`) runs through the vendored fork's
 * upstream C++ Arrow loader (`arrow_loader.cpp`), whose column-fill switch
 * only understands standard Arrow logical types.
 *
 * Under `arrowLosslessConversion: true` (`duckdb-worker-boot.ts`), DuckDB
 * exports every type it has no native Arrow equivalent for — HUGEINT,
 * UHUGEINT, oversized DECIMAL (BIGNUM/VARINT), BIT, TIME_TZ — as
 * `FixedSizeBinary`/`Binary` columns wrapped in the *canonical* Arrow
 * extension type `arrow.opaque` (DuckDB's `arrow_type_extension.cpp`: "we use
 * arrow.opaque as all the non-canonical extensions"), disambiguated by a
 * `type_name` field in `ARROW:extension:metadata` (see `format.ts`'s
 * `getDuckDBExtensionType`). UUID columns instead ride the real canonical
 * `arrow.uuid` extension. Because these are registered canonical extensions —
 * not an unrecognized name a reader would silently ignore — arrow-cpp
 * materializes a genuine `arrow::ExtensionType` column for every one of them,
 * and the C++ loader's switch has no case for `arrow::Type::EXTENSION`: it
 * falls into `default: PSP_COMPLAIN_AND_ABORT("Could not load Arrow column of
 * type \`extension\`")`, table construction never completes, and the
 * JS-visible table handle ends up invalid. `viewer.load()` then dereferences
 * it through wasm-bindgen glue, which throws its generic null-object guard:
 * "null pointer passed to rust" (wasm-bindgen's `rt::throw_null`) — a
 * different-looking symptom of the exact same cause when the abort races
 * `viewer.load()` instead of `table()` itself.
 *
 * The DuckDB-aware *virtual server* Perspective path
 * (`perspective-duckdb-handler.ts`, backed by the fork's Rust
 * `virtual_server/data.rs`) already handles every one of these extension
 * types — and even there, hugeint/uhugeint/bignum/varint are converted to
 * `Float64`, lossy past 2^53, because Perspective's own column storage is
 * f64-only regardless of source precision ("Lossy past 2^53 but keeps the
 * column numeric and sortable"). There is no lossless numeric path into
 * Perspective for these types — porting the Rust handling into the C++
 * loader would still land on Float64.
 *
 * This rewrites every extension-tagged column ahead of the static path's
 * ingestion so arrow-cpp never sees the extension wrapper at all:
 * hugeint/uhugeint/bignum/varint flatten to `Float64` (matching the virtual
 * server), bit/time_tz/uuid flatten to a formatted `Utf8` string (matching
 * how the grid already displays them), `arrow.bool8` flattens to a native
 * Arrow `Bool` (its storage is a plain Int8 — 0/1, one full byte per value,
 * per DuckDB's own extension registration — so simply stripping its tag like
 * the fallback below would leave it as an *integer* column, not a boolean
 * one), and anything else carrying `ARROW:extension:name` (geoarrow.*
 * geometry, or an extension this function doesn't specifically recognize)
 * simply has the extension tag stripped, leaving its underlying storage
 * type — the C++ loader already handles plain Binary/etc. columns, just not
 * their extension-wrapped form.
 */
import { Bool, Field, Float64, RecordBatch, Schema, Struct, Table, Utf8, makeData, tableToIPC, vectorFromArray } from "@query-farm/apache-arrow";
import { tableFromIPCWithDictionaries } from "./duckdb-query";
import { bignumBytesToBigInt, formatBitString, formatFixedBinaryTimeTz, formatUUID, getDuckDBExtensionType, readInt128 } from "./format";

/** How to neutralize one extension-tagged field so arrow-cpp reads it as a
 *  plain type instead of `arrow::ExtensionType`. */
type ExtensionAction =
  | { kind: "float64"; decode: (raw: Uint8Array) => number }
  | { kind: "string"; decode: (raw: Uint8Array) => string }
  // arrow.bool8's storage is a plain Int8 (0/1), so `column.get()` hands back
  // a number here, not raw bytes like the other kinds.
  | { kind: "bool"; decode: (raw: number) => boolean }
  // Metadata-only: keep the field's existing physical type and values,
  // just drop the two ARROW:extension:* keys.
  | { kind: "strip" };

/** Decode one column's raw bytes to a signed 64-bit-precision double,
 *  matching the virtual-server path's own hugeint/uhugeint/bignum handling. */
function bytesToFloat64(typeName: string, bytes: Uint8Array): number {
  const big =
    typeName === "hugeint" ? readInt128(bytes, true) :
    typeName === "uhugeint" ? readInt128(bytes, false) :
    bignumBytesToBigInt(bytes); // "bignum" | "varint"
  return Number(big);
}

/** Classify a field's extension handling, or `null` if it isn't
 *  extension-tagged at all (the overwhelmingly common case — most columns
 *  need no rewriting). */
function classifyExtensionField(field: any): ExtensionAction | null {
  const extName: string | undefined = field.metadata?.get?.("ARROW:extension:name");
  if (!extName) return null;

  // GeoArrow geometry (geoarrow.wkb/.point/.polygon/…): leave the WKB bytes
  // as plain Binary. Re-encoding is DataGrid/GeometryViewer's job, not this
  // function's — the goal here is just "don't let arrow-cpp abort".
  if (extName.startsWith("geoarrow.")) return { kind: "strip" };

  const typeName = getDuckDBExtensionType(field);
  if (typeName === "hugeint" || typeName === "uhugeint" || typeName === "bignum" || typeName === "varint") {
    return { kind: "float64", decode: (b) => bytesToFloat64(typeName, b) };
  }
  if (typeName === "bit") return { kind: "string", decode: formatBitString };
  if (typeName === "time_tz") return { kind: "string", decode: formatFixedBinaryTimeTz };
  if (typeName === "uuid" || extName === "arrow.uuid") return { kind: "string", decode: formatUUID };
  if (extName === "arrow.bool8") return { kind: "bool", decode: (raw) => raw !== 0 };

  // Any extension this function doesn't specifically recognize (a future
  // DuckDB/Arrow addition) — strip and pass the underlying storage bytes
  // through unchanged.
  return { kind: "strip" };
}

/**
 * Rewrite every `ARROW:extension:name`-tagged column in an Arrow IPC buffer
 * so Perspective's static-snapshot table loader can ingest it instead of
 * aborting on `arrow::Type::EXTENSION`. Returns the original buffer unchanged
 * (same reference) when no such columns are present — the common case — so
 * callers pay no re-serialization cost for ordinary result sets.
 *
 * Pass `preParsedTable` when the caller has already decoded the buffer
 * dictionary-safely for another purpose (`loadPerspective` builds diagnostics
 * from the same parse) to skip the second full IPC decode.
 *
 * Never throws: a decode/rebuild failure logs a warning and falls back to the
 * original buffer, since a crash-prone Perspective load is worse than one
 * that shows a raw or reformatted column, and a totally broken load is worse
 * than either.
 */
export function coerceArrowBufferForPerspective(arrowBuffer: ArrayBuffer, preParsedTable?: Table): ArrayBuffer {
  try {
    const table = preParsedTable ?? tableFromIPCWithDictionaries(arrowBuffer);
    const fields = table.schema.fields;

    // Decode each matching column across the whole table up front (Vector.get
    // walks chunk boundaries transparently), keyed by column index. Only
    // "float64"/"string" actions need decoded values — "strip" just needs
    // its field's metadata cleared, tracked separately below.
    const valueOverrides = new Map<number, { type: Float64 | Utf8 | Bool; values: (number | string | boolean | null)[] }>();
    const stripOnly = new Set<number>();
    const changedNames: string[] = [];

    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      const action = classifyExtensionField(field);
      if (!action) continue;

      if (action.kind === "strip") {
        stripOnly.add(i);
        changedNames.push(`${field.name} (untagged)`);
        continue;
      }

      const column = table.getChildAt(i);
      if (!column) continue;

      const values: (number | string | boolean | null)[] = new Array(table.numRows);
      for (let row = 0; row < table.numRows; row++) {
        const raw = column.get(row);
        values[row] = raw == null ? null : (action.decode as (raw: any) => number | string | boolean)(raw);
      }
      const type = action.kind === "float64" ? new Float64() : action.kind === "bool" ? new Bool() : new Utf8();
      valueOverrides.set(i, { type, values });
      changedNames.push(`${field.name} (${action.kind})`);
    }

    if (valueOverrides.size === 0 && stripOnly.size === 0) return arrowBuffer;
    console.warn(`[perspective] neutralized ${changedNames.length} extension column(s) for Perspective compatibility: ${changedNames.join(", ")}`);

    // Fresh Fields for every touched column: same name/nullability, the
    // extension metadata dropped (it either no longer describes the values —
    // float64/string — or would make arrow-cpp re-wrap the *same* storage
    // type as an ExtensionType again). Deliberately NOT done via
    // `Table.setChild` — this fork's `Table.setChildAt` rebuilds the Struct
    // type from the *original* schema.fields rather than the field it just
    // cloned, so a same-named replacement with a different Arrow type gets
    // new data under the old (wrong) type tag instead of the new one.
    const newFields = fields.map((f, i) => {
      const override = valueOverrides.get(i);
      if (override) return new Field(f.name, override.type, f.nullable, new Map());
      if (stripOnly.has(i)) return new Field(f.name, f.type, f.nullable, new Map());
      return f;
    });
    const newSchema = new Schema(newFields, table.schema.metadata);

    // Rebuild batch-by-batch so unaffected columns' underlying Data chunks —
    // including stripped ones, whose storage type/values don't change, only
    // their field's metadata — are reused as-is (no materialization, no risk
    // of mangling types this function doesn't need to touch: dictionaries,
    // structs, decimals, …). Only value-overridden columns get a fresh chunk
    // per batch, sliced from the full-column decode above.
    let rowOffset = 0;
    const newBatches = table.batches.map((batch) => {
      const length = batch.data.length;
      const children = batch.data.children.map((child, i) => {
        const override = valueOverrides.get(i);
        if (!override) return child;
        return vectorFromArray(override.values.slice(rowOffset, rowOffset + length) as any, override.type as any).data[0];
      });
      rowOffset += length;
      return new RecordBatch(newSchema, makeData({ type: new Struct(newFields), length, children }));
    });

    const bytes = tableToIPC(new Table(newSchema, newBatches));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  } catch (error: unknown) {
    console.warn("[perspective] extension coercion failed, loading original buffer", error);
    return arrowBuffer;
  }
}
