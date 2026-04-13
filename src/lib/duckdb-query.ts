/**
 * Shared helpers for querying DuckDB through the shell bridge.
 * Used by duckdb-catalog.ts, catalog-identity.ts, and other modules
 * that need to run SQL against the in-browser DuckDB instance.
 */
import { tableFromIPC } from "apache-arrow";
import { bridge } from "./shell-bridge";

/** SQL-escape a string for inlining into a literal. DuckDB uses SQL-standard
 *  single-quote doubling. */
export function esc(s: string): string {
  return s.replace(/'/g, "''");
}

/** Read an Arrow-encoded query result into an array of plain-object rows.
 *  Returns null if the query failed or returned no arrow buffers. */
export async function readRows(sql: string): Promise<Record<string, any>[] | null> {
  const q = bridge.query;
  if (!q) return null;
  const r = await q(sql);
  if (!r.ok || !r.arrowBuffers?.length) return null;
  const buf = r.arrowBuffers[0];
  const table = tableFromIPC(buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf);
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
