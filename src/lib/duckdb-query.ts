/**
 * Shared helpers for querying DuckDB through the shell bridge.
 *
 * Every Arrow-result decode in the codebase routes through here. Previously,
 * six different sites each re-implemented the `result.ok` → `arrowBuffers[0]`
 * → `buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf` → `tableFromIPC`
 * sequence with subtly different error handling. A bug fix in any one of them
 * (e.g. the empty-result handling, the dynamic-vs-static import) had to be
 * repeated N times. These helpers are the only correct way to decode.
 */
import { tableFromIPC, RecordBatchFileReader, Table } from "@query-farm/apache-arrow";
import { engine } from "./shell-bridge";

/** SQL-escape a string for inlining into a literal. DuckDB uses SQL-standard
 *  single-quote doubling. Returns the escaped *body* — callers supply the
 *  surrounding quotes (`'${esc(x)}'`). Prefer `quoteLiteral` for new code. */
export function esc(s: string): string {
  return s.replace(/'/g, "''");
}

/** Quote a VALUE as a SQL string literal: `foo'bar` → `'foo''bar'`.
 *
 *  Use this anywhere a string is COMPARED or passed as an argument —
 *  `WHERE database_name = quoteLiteral(db)`, `vgi_table_statistics(...)`.
 *  Do NOT use `quoteIdent` there: DuckDB reads a double-quoted token as an
 *  identifier, so `WHERE database_name = "memory"` is a reference to a column
 *  named `memory` and fails with `Binder Error: Referenced column "memory" not
 *  found in FROM clause!`. That mistake silently disabled describe_table for
 *  memory/attached catalogs, which is why both helpers now live here together. */
export function quoteLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Quote an IDENTIFIER: `we"ird` → `"we""ird"`.
 *
 *  Use this only where a table/column/catalog NAME appears in the grammar —
 *  `FROM quoteIdent(cat).quoteIdent(schema).quoteIdent(table)`, `ORDER BY`.
 *  See `quoteLiteral` for the value case. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Decode an Arrow IPC buffer the caller already holds — e.g. one taken
 *  straight off a `QueryResult.arrowBuffers`.
 *
 *  Use this instead of calling `tableFromIPC` directly. The
 *  `buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf` shuffle was
 *  copy-pasted at eight call sites; it lives here once now. It is also no
 *  longer strictly needed — `duckdb-worker-boot` copies every result into a
 *  plain, non-shared ArrayBuffer — but is kept so the helper still accepts the
 *  Uint8Array views some paths carry. */
export function decodeArrowBuffer(buf: ArrayBuffer | Uint8Array): Table {
  return tableFromIPC(buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf);
}

/** `tableFromIPC` that preserves dictionary batches.
 *
 *  Arrow's plain `tableFromIPC` doesn't populate dictionary data from the IPC
 *  *file* format, which is what DuckDB returns — DICTIONARY-encoded columns
 *  (e.g. low-cardinality VARCHAR) come back with empty values. Reading the
 *  record batches explicitly and constructing the Table keeps them. Falls back
 *  to the plain path for anything the file reader can't parse. */
export function tableFromIPCWithDictionaries(buf: ArrayBuffer | Uint8Array): Table {
  try {
    const reader = RecordBatchFileReader.from(buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf);
    const batches = [...reader];
    if (batches.length === 0) return tableFromIPC(buf);
    return new Table(batches);
  } catch {
    return tableFromIPC(buf);
  }
}

/** Run SQL and decode the result to an Apache Arrow `Table`. Returns null if
 *  the query failed, the bridge isn't ready, or no Arrow buffer came back. */
export async function readTable(sql: string): Promise<Table | null> {
  const q = engine.query;
  if (!q) return null;
  const r = await q(sql);
  if (!r.ok || !r.arrowBuffers?.length) return null;
  return decodeArrowBuffer(r.arrowBuffers[0]);
}

/** Read an Arrow-encoded query result into an array of plain-object rows.
 *  Returns null if the query failed or returned no arrow buffers. */
export async function readRows(sql: string): Promise<Record<string, any>[] | null> {
  const table = await readTable(sql);
  if (!table) return null;
  return tableToRows(table);
}

/** Strongly-typed variant of `readRows` for callers that know the column
 *  shape. The values are still pulled via `getChild(name)?.get(i)` — no
 *  conversion is applied, so types must match the Arrow column types. */
export async function readRowsTyped<T>(sql: string): Promise<T[] | null> {
  const rows = await readRows(sql);
  return rows as T[] | null;
}

/** Decode an already-fetched Arrow Table into plain rows. Exposed for sites
 *  that already have a Table in hand (e.g. tab handlers receiving an Arrow
 *  buffer from Perspective) and want consistent row-shape semantics.
 *
 *  Values are coerced to JSON-safe forms via `coerceArrowValue` (BigInt →
 *  Number/String, Date → epoch ms). Callers that need raw Arrow precision
 *  should use the Arrow Table directly. The whole point of readRows is
 *  "give me plain JS rows I can stringify, splice into Vega specs, etc."
 *  — returning BigInt would break that contract on every JSON.stringify.
 */
export function tableToRows(table: Table): Record<string, any>[] {
  const fields = table.schema.fields.map((f: any) => f.name);
  const rows: Record<string, any>[] = [];
  for (let i = 0; i < table.numRows; i++) {
    const row: Record<string, any> = {};
    for (const name of fields) {
      row[name] = coerceArrowValue(table.getChild(name)?.get(i));
    }
    rows.push(row);
  }
  return rows;
}

// Well-known symbol apache-arrow tags its BigNum wrapper prototype with
// (util/bn.mjs: `Symbol.for('isArrowBigNum')`) — DECIMAL/HUGEINT/UHUGEINT
// columns' `.get()` returns one of these (BN.decimal(...)), not a primitive
// bigint. Matching on the registered symbol avoids importing the class.
const ARROW_BIGNUM_SYMBOL = Symbol.for("isArrowBigNum");

function isArrowBigNum(v: unknown): v is { toString(): string } {
  return v != null && typeof v === "object" && (v as any)[ARROW_BIGNUM_SYMBOL] === true;
}

/** Convert an Arrow scalar to a JSON-safe / JS-friendly form.
 *
 *  - BigInt → Number when within MAX_SAFE_INTEGER, otherwise String.
 *    DuckDB BIGINT (INT64) columns arrive as JS BigInt; JSON.stringify
 *    throws on BigInt, and Vega's expression engine refuses arithmetic
 *    on it. Numbers above 2^53 lose precision — stringifying preserves
 *    the exact value at the cost of typeof === "string".
 *  - Arrow BigNum (DECIMAL/HUGEINT/UHUGEINT columns) → same treatment,
 *    routed through the BigInt branch. Unlike a primitive bigint,
 *    `Number(bigNum)` *throws* a TypeError instead of losing precision
 *    once the value exceeds MAX_SAFE_INTEGER (its valueOf/Symbol.toPrimitive
 *    calls apache-arrow's bigIntToNumber, which rejects unsafe values) —
 *    `.toString()` is the only conversion on it that never throws.
 *  - Date → epoch ms. Same reasoning: Vega and most consumers prefer
 *    numeric timestamps.
 *  - Arrays / plain objects → recursively coerce (struct columns).
 *  - Everything else (string, number, bool, null, Uint8Array) → as-is.
 *    Typed arrays are NOT recursed into — they have their own efficient
 *    representation and consumers handle them specially. */
export function coerceArrowValue(v: any): any {
  if (v === null || v === undefined) return v;
  if (typeof v === "bigint") {
    const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
    const MIN_SAFE = -MAX_SAFE;
    if (v > MAX_SAFE || v < MIN_SAFE) return v.toString();
    return Number(v);
  }
  if (isArrowBigNum(v)) return coerceArrowValue(BigInt(v.toString()));
  if (v instanceof Date) return v.getTime();
  if (Array.isArray(v)) return v.map(coerceArrowValue);
  if (typeof v === "object" && v.constructor === Object) {
    const out: Record<string, any> = {};
    for (const [k, val] of Object.entries(v)) out[k] = coerceArrowValue(val);
    return out;
  }
  return v;
}
