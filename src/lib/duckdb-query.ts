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
import { tableFromIPC, type Table } from "apache-arrow";
import { bridge } from "./shell-bridge";

/** SQL-escape a string for inlining into a literal. DuckDB uses SQL-standard
 *  single-quote doubling. */
export function esc(s: string): string {
  return s.replace(/'/g, "''");
}

/** Run SQL and decode the result to an Apache Arrow `Table`. Returns null if
 *  the query failed, the bridge isn't ready, or no Arrow buffer came back. */
export async function readTable(sql: string): Promise<Table | null> {
  const q = bridge.query;
  if (!q) return null;
  const r = await q(sql);
  if (!r.ok || !r.arrowBuffers?.length) return null;
  const buf = r.arrowBuffers[0];
  return tableFromIPC(buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf);
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
 *  buffer from Perspective) and want consistent row-shape semantics. */
export function tableToRows(table: Table): Record<string, any>[] {
  const fields = table.schema.fields.map((f: any) => f.name);
  const rows: Record<string, any>[] = [];
  for (let i = 0; i < table.numRows; i++) {
    const row: Record<string, any> = {};
    for (const name of fields) {
      row[name] = table.getChild(name)?.get(i);
    }
    rows.push(row);
  }
  return rows;
}
