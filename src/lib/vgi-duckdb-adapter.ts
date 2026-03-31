/**
 * DuckDB adapter that wraps the shell's existing DuckDB-WASM worker.
 * Implements the DatabaseAdapter / DatabaseConnection interfaces from
 * @kepler.gl/duckdb so kepler.gl's SQL panel and data pipeline can
 * query our VGI-attached DuckDB instance.
 *
 * Queries are correlated via queryId so multiple concurrent queries
 * get the correct results back.
 */

import { tableFromIPC } from "apache-arrow";
import type { Table } from "apache-arrow";

/** Matches @kepler.gl/duckdb DatabaseConnection interface. */
export class VgiDuckDBConnection {
  async query(statement: string): Promise<Table> {
    const queryFn = (window as any).__duckdbQuery;
    if (!queryFn) throw new Error("DuckDB shell not initialized — open the SQL Shell tab first");
    console.log("[VgiDuckDB] query:", statement.slice(0, 120));
    const result = await queryFn(statement);
    if (!result.ok) {
      console.error("[VgiDuckDB] error:", result.error);
      throw new Error(result.error || "Query failed");
    }
    if (!result.arrowBuffers?.length) {
      console.log("[VgiDuckDB] OK (no result rows)");
      const { makeTable } = await import("apache-arrow");
      return makeTable({});
    }
    const table = tableFromIPC(result.arrowBuffers[0]);
    console.log("[VgiDuckDB] result:", table.numRows, "rows,", table.schema.fields.length, "cols");
    return table;
  }

  async insertArrowTable(_arrowTable: Table, _opts: { name: string }): Promise<void> {
    // Not supported — our DuckDB is read-only via VGI
  }

  async close(): Promise<void> {
    // No-op — worker persists across the session
  }
}

/** Matches @kepler.gl/duckdb DatabaseAdapter interface. */
export class VgiDuckDBAdapter {
  async connect(): Promise<VgiDuckDBConnection> {
    return new VgiDuckDBConnection();
  }

  async registerFileText(_name: string, _text: string): Promise<void> {
    // Not supported in our worker
  }

  async registerFileHandle(
    _name: string,
    _handle: any,
    _protocol: number,
    _directIO: boolean
  ): Promise<void> {
    // Not supported in our worker
  }
}
