/**
 * Perspective VirtualServerHandler backed by the VGI DuckDB WASM worker.
 *
 * Modeled on Perspective's DuckDBHandler but uses our existing __duckdbQuery
 * window function instead of @duckdb/duckdb-wasm's AsyncDuckDBConnection.
 *
 * Reference: ~/Development/perspective/rust/perspective-js/src/ts/virtual_servers/duckdb.ts
 */

import { tableFromIPC } from "apache-arrow";

// ---------------------------------------------------------------------------
// Traversal — tracks visible rows for collapse/expand in grouped views
// ---------------------------------------------------------------------------

interface TraversalNode {
  dbRowIndex: number;     // Row index in the DuckDB materialized view
  depth: number;          // Tree depth (0 = total, 1 = first group level, etc.)
  expanded: boolean;      // Whether children are visible in the traversal
  childCount: number;     // Number of direct children in the full tree
}

class ViewTraversal {
  nodes: TraversalNode[];        // Currently visible rows
  private allNodes: TraversalNode[];  // Full tree (immutable after build)
  private groupByLen: number;

  private constructor(allNodes: TraversalNode[], groupByLen: number) {
    this.allNodes = allNodes;
    this.nodes = [...allNodes]; // Start fully expanded
    this.groupByLen = groupByLen;
  }

  /** Build a traversal from the __GROUPING_ID__ column of a grouped DuckDB result. */
  static async build(viewId: string, groupByLen: number): Promise<ViewTraversal | null> {
    if (groupByLen === 0) return null;

    // Query just the grouping ID column to determine tree structure
    const qualifiedView = `memory.main."${viewId}"`;
    const result = await runQuery(
      `SELECT "__GROUPING_ID__" FROM ${qualifiedView}`
    );
    if (!result.ok || !result.arrowBuffers?.length) return null;

    const table = tableFromIPC(new Uint8Array(result.arrowBuffers[0]));
    const gidCol = table.getChildAt(0);
    if (!gidCol) return null;

    const allNodes: TraversalNode[] = [];
    for (let i = 0; i < table.numRows; i++) {
      let gid = gidCol.get(i);
      if (typeof gid === "bigint") gid = Number(gid);
      // depth = groupByLen - popcount(gid)
      // popcount: count set bits
      let bits = gid;
      let popcount = 0;
      while (bits > 0) { popcount += bits & 1; bits >>= 1; }
      const depth = groupByLen - popcount;

      allNodes.push({ dbRowIndex: i, depth, expanded: true, childCount: 0 });
    }

    // Calculate childCount for each node
    for (let i = 0; i < allNodes.length; i++) {
      const node = allNodes[i];
      let count = 0;
      for (let j = i + 1; j < allNodes.length; j++) {
        if (allNodes[j].depth <= node.depth) break;
        if (allNodes[j].depth === node.depth + 1) count++;
      }
      node.childCount = count;
    }

    return new ViewTraversal(allNodes, groupByLen);
  }

  get length(): number {
    return this.nodes.length;
  }

  /** Collapse the node at the given visible row index. Returns number of rows removed. */
  collapse(visibleIndex: number): number {
    if (visibleIndex < 0 || visibleIndex >= this.nodes.length) return 0;
    const node = this.nodes[visibleIndex];
    if (!node.expanded || node.childCount === 0) return 0;

    // Count visible descendants
    let numDescendants = 0;
    for (let i = visibleIndex + 1; i < this.nodes.length; i++) {
      if (this.nodes[i].depth <= node.depth) break;
      numDescendants++;
    }

    if (numDescendants === 0) return 0;

    // Remove descendants from visible nodes
    this.nodes.splice(visibleIndex + 1, numDescendants);
    node.expanded = false;
    return numDescendants;
  }

  /** Expand the node at the given visible row index. Returns number of rows inserted. */
  expand(visibleIndex: number): number {
    if (visibleIndex < 0 || visibleIndex >= this.nodes.length) return 0;
    const node = this.nodes[visibleIndex];
    if (node.expanded || node.childCount === 0) return 0;

    // Find this node in allNodes
    const allIdx = this.allNodes.findIndex(n => n.dbRowIndex === node.dbRowIndex);
    if (allIdx < 0) return 0;

    // Collect direct children from allNodes
    const children: TraversalNode[] = [];
    for (let i = allIdx + 1; i < this.allNodes.length; i++) {
      if (this.allNodes[i].depth <= node.depth) break;
      if (this.allNodes[i].depth === node.depth + 1) {
        // Insert child as collapsed (don't recursively expand)
        children.push({ ...this.allNodes[i], expanded: false });
      }
    }

    if (children.length === 0) return 0;

    // Insert children after the node in visible list
    this.nodes.splice(visibleIndex + 1, 0, ...children);
    node.expanded = true;
    return children.length;
  }

  /** Get the DuckDB row indices for a viewport range. */
  getDbRowIndices(startRow: number, endRow: number): number[] {
    const start = Math.max(0, Math.floor(startRow));
    const end = Math.min(this.nodes.length, Math.ceil(endRow));
    const indices: number[] = [];
    for (let i = start; i < end; i++) {
      indices.push(this.nodes[i].dbRowIndex);
    }
    return indices;
  }
}

// Perspective column types
type ColumnType = "string" | "float" | "integer" | "date" | "boolean" | "datetime";

const NUMBER_AGGS = [
  "sum", "count", "any_value", "arbitrary", "array_agg", "avg", "bit_and",
  "bit_or", "bit_xor", "bitstring_agg", "bool_and", "bool_or", "countif",
  "favg", "fsum", "geomean", "kahan_sum", "last", "max", "min", "product",
  "string_agg", "sumkahan",
];

const STRING_AGGS = [
  "count", "any_value", "arbitrary", "first", "countif", "last", "string_agg",
];

const FILTER_OPS = [
  "==", "!=", "LIKE", "IS DISTINCT FROM", "IS NOT DISTINCT FROM",
  ">=", "<=", ">", "<",
];

function duckdbTypeToPsp(name: string): ColumnType {
  name = name.toLowerCase();
  if (name === "varchar" || name === "utf8") return "string";
  if (name === "double" || name === "hugeint" || name === "float64" || name.startsWith("decimal")) return "float";
  if (name === "bigint" || name.startsWith("int") || name.startsWith("uint") || name.startsWith("smallint") || name.startsWith("tinyint")) return "integer";
  if (name.startsWith("date")) return "date";
  if (name.startsWith("bool")) return "boolean";
  if (name.startsWith("timestamp")) return "datetime";
  if (name.startsWith("json") || name.startsWith("struct")) return "string";
  console.warn(`Unknown DuckDB type for Perspective: '${name}'`);
  return "string";
}

/** Execute a SQL query via the shared DuckDB WASM worker. */
async function runQuery(sql: string): Promise<{ arrowBuffers?: ArrayBuffer[]; ok: boolean; error?: string }> {
  const queryFn = (window as any).__duckdbQuery;
  if (!queryFn) throw new Error("DuckDB shell not initialized");
  return queryFn(sql);
}

/** Execute SQL and parse Arrow IPC into row objects. */
async function queryRows(sql: string): Promise<any[]> {
  const result = await runQuery(sql);
  if (!result.ok) throw new Error(result.error || "Query failed");
  if (!result.arrowBuffers?.length) return [];
  const table = tableFromIPC(new Uint8Array(result.arrowBuffers[0]));
  const rows: any[] = [];
  const fields = table.schema.fields;
  for (let r = 0; r < table.numRows; r++) {
    const row: any = {};
    for (let c = 0; c < fields.length; c++) {
      let val = table.getChildAt(c)?.get(r);
      if (typeof val === "bigint") val = Number(val);
      row[fields[c].name] = val;
    }
    rows.push(row);
  }
  return rows;
}

/**
 * VirtualServerHandler that bridges Perspective to our DuckDB WASM worker.
 */
export class VgiDuckDBHandler {
  private _sqlBuilder: any = null;
  private mod: any;
  private tableOrderingCache = new Map<string, { hasRowid: boolean; primaryKey: string[] | null }>();
  private renameViewCache = new Set<string>();
  /** Traversals for grouped views — enables collapse/expand. */
  private traversals = new Map<string, ViewTraversal>();

  constructor(perspectiveMod: any) {
    this.mod = perspectiveMod;
  }

  /** Detect whether a table has rowid or a primary key for stable ordering. */
  private async detectTableOrdering(tableId: string): Promise<{ hasRowid: boolean; primaryKey: string[] | null }> {
    // Test for rowid
    try {
      const r = await runQuery(`SELECT rowid FROM ${tableId} LIMIT 0`);
      if (r.ok) return { hasRowid: true, primaryKey: null };
    } catch {}

    // Check for primary key via duckdb_constraints()
    try {
      const parts = tableId.split(".");
      if (parts.length === 3) {
        const rows = await queryRows(
          `SELECT column_name FROM duckdb_constraints() WHERE database_name='${parts[0]}' AND schema_name='${parts[1]}' AND table_name='${parts[2]}' AND constraint_type='PRIMARY KEY'`
        );
        if (rows.length > 0) {
          return { hasRowid: false, primaryKey: rows.map((r: any) => r.column_name) };
        }
      }
    } catch {}

    return { hasRowid: false, primaryKey: null };
  }

  /** Replace unqualified view ID references with memory.main qualified version in SQL. */
  private qualifyViewSql(sql: string, viewId: string): string {
    // The SQL builder may or may not quote view IDs. Use regex with word boundary for safety.
    const escaped = viewId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return sql.replace(new RegExp(`(?<!")\\b${escaped}\\b(?!")`, "g"), `memory.main."${viewId}"`);
  }

  private get sqlBuilder() {
    if (!this._sqlBuilder) {
      // Get the WASM module from the already-initialized perspective-viewer custom element.
      // The viewer class has __wasm_module__ set after perspective.worker() is called.
      const viewerClass = customElements?.get("perspective-viewer") as any;
      const wasmMod = viewerClass?.__wasm_module__;
      if (wasmMod?.GenericSQLVirtualServerModel) {
        this._sqlBuilder = new wasmMod.GenericSQLVirtualServerModel();
      } else {
        throw new Error("Perspective WASM not initialized — call perspective.worker() first");
      }
    }
    return this._sqlBuilder;
  }

  getFeatures() {
    return {
      group_by: true,
      split_by: true,
      sort: true,
      expressions: true,
      group_rollup_mode: ["rollup", "flat", "total"],
      filter_ops: {
        integer: FILTER_OPS,
        float: FILTER_OPS,
        string: FILTER_OPS,
        boolean: FILTER_OPS,
        date: FILTER_OPS,
        datetime: FILTER_OPS,
      },
      aggregates: {
        integer: NUMBER_AGGS,
        float: NUMBER_AGGS,
        string: STRING_AGGS,
        boolean: STRING_AGGS,
        date: STRING_AGGS,
        datetime: STRING_AGGS,
      },
    };
  }

  async getHostedTables(): Promise<string[]> {
    // Use duckdb_tables() for full catalog.schema.table names
    const rows = await queryRows(
      "SELECT database_name, schema_name, table_name FROM duckdb_tables()"
    );
    return rows.map((row) => `${row.database_name}.${row.schema_name}.${row.table_name}`);
  }

  async tableSchema(tableId: string): Promise<Record<string, ColumnType>> {
    // If tableId has no dots, it's a view ID — qualify with memory.main
    let sql = this.sqlBuilder.tableSchema(tableId);
    if (!tableId.includes(".")) {
      sql = this.qualifyViewSql(sql, tableId);
    }
    const rows = await queryRows(sql);
    const schema: Record<string, ColumnType> = {};
    for (const row of rows) {
      if (!row.column_name?.startsWith("__")) {
        // Return hyphenated names to match Perspective's convention.
        // The rename view (created in tableMakeView) maps these back to
        // underscored DuckDB column names.
        const name = row.column_name.replace(/_/g, "-");
        schema[name] = duckdbTypeToPsp(row.column_type);
      }
    }
    return schema;
  }

  async tableSize(tableId: string): Promise<number> {
    let sql = this.sqlBuilder.tableSize(tableId);
    if (!tableId.includes(".")) {
      sql = this.qualifyViewSql(sql, tableId);
    }
    const rows = await queryRows(sql);
    return Number(rows[0]?.["count_star()"] ?? 0);
  }

  /** Ensure a rename view exists for a table, mapping underscored column names to hyphenated ones. */
  private async ensureRenameView(tableId: string): Promise<string> {
    const renameViewId = `memory.main."__psp_rename_${tableId.replace(/\./g, "_")}"`;
    if (this.renameViewCache.has(tableId)) return renameViewId;

    // Get source columns
    const descSql = this.sqlBuilder.tableSchema(tableId);
    const rows = await queryRows(descSql);
    const aliases = rows
      .filter((r: any) => !r.column_name?.startsWith("__"))
      .map((r: any) => `"${r.column_name}" as "${r.column_name.replace(/_/g, "-")}"`)
      .join(", ");

    await runQuery(`CREATE OR REPLACE VIEW ${renameViewId} AS SELECT ${aliases} FROM ${tableId}`);
    this.renameViewCache.add(tableId);
    return renameViewId;
  }

  async tableMakeView(tableId: string, viewId: string, config: any): Promise<void> {
    // Create a rename view that maps underscored columns to hyphenated names.
    // The SQL builder uses hyphenated names everywhere, so we point it at the
    // rename view where those names actually exist.
    const renameView = await this.ensureRenameView(tableId);
    let sql = this.sqlBuilder.tableMakeView(renameView, viewId, config);

    // Detect table ordering capability (cached per table)
    if (!this.tableOrderingCache.has(tableId)) {
      this.tableOrderingCache.set(tableId, await this.detectTableOrdering(tableId));
    }
    const ordering = this.tableOrderingCache.get(tableId)!;

    if (ordering.hasRowid) {
      // Has rowid — use CREATE VIEW (lazy, no materialization)
      sql = sql.replace(/CREATE TABLE\s+/i, "CREATE VIEW ");
    } else if (ordering.primaryKey) {
      // Has PK but no rowid — use CREATE VIEW with PK ordering
      // PK column names need hyphenation to match the rename view
      const pkCols = ordering.primaryKey.map(c => `"${c.replace(/_/g, "-")}"`).join(", ");
      sql = sql.replace(/\s+ORDER BY rowid\b/gi, ` ORDER BY ${pkCols}`);
      sql = sql.replace(/CREATE TABLE\s+/i, "CREATE VIEW ");
    } else {
      // No rowid, no PK — materialize (CREATE TABLE) for stable ordering
      sql = sql.replace(/\s+ORDER BY rowid\b/gi, "");
    }

    // VGI catalogs are read-only — create in memory.main schema
    sql = this.qualifyViewSql(sql, viewId);
    const result = await runQuery(sql);
    if (!result.ok) throw new Error(result.error || "Failed to create view");

    // Build traversal for grouped views to support collapse/expand.
    // Skip traversal for views with no data columns (e.g. filter dropdown views)
    // to avoid leaking __db_row_idx__ into the CSV output.
    const groupByLen = config.group_by?.length ?? 0;
    const isFlat = config.group_rollup_mode === "flat";
    const hasDataColumns = config.columns?.length > 0;
    if (groupByLen > 0 && !isFlat && hasDataColumns) {
      const traversal = await ViewTraversal.build(viewId, groupByLen);
      if (traversal) {
        this.traversals.set(viewId, traversal);
      }
    } else {
      this.traversals.delete(viewId);
    }
  }

  async viewDelete(viewId: string): Promise<void> {
    let sql = this.sqlBuilder.viewDelete(viewId);
    sql = this.qualifyViewSql(sql, viewId);
    const result = await runQuery(sql);
    if (!result.ok) {
      const viewSql = sql.replace(/DROP TABLE/i, "DROP VIEW");
      await runQuery(viewSql);
    }
    this.traversals.delete(viewId);
  }

  async viewCollapse(viewId: string, rowIndex: number): Promise<number> {
    const traversal = this.traversals.get(viewId);
    if (!traversal) return 0;
    return traversal.collapse(rowIndex);
  }

  async viewExpand(viewId: string, rowIndex: number): Promise<number> {
    const traversal = this.traversals.get(viewId);
    if (!traversal) return 0;
    return traversal.expand(rowIndex);
  }

  async viewGetData(
    viewId: string,
    config: any,
    schema: Record<string, ColumnType>,
    viewport: any,
    dataSlice: any,
  ): Promise<void> {
    const traversal = this.traversals.get(viewId);

    if (traversal) {
      // Use traversal to fetch only visible rows
      const dbIndices = traversal.getDbRowIndices(
        viewport.start_row ?? 0,
        viewport.end_row ?? traversal.length
      );
      if (dbIndices.length === 0) return;

      // Query specific rows by their DuckDB row index
      const qualifiedView = `memory.main."${viewId}"`;
      const sql = `SELECT * FROM (
        SELECT *, ROW_NUMBER() OVER () - 1 as __db_row_idx__
        FROM ${qualifiedView}
      ) sub WHERE __db_row_idx__ IN (${dbIndices.join(",")})
      ORDER BY array_position([${dbIndices.join(",")}]::INTEGER[], __db_row_idx__::INTEGER)`;
      const result = await runQuery(sql);
      if (!result.ok) throw new Error(result.error || "Query failed");
      if (result.arrowBuffers?.length) {
        // Remove the __db_row_idx__ helper column before passing to Perspective
        // fromArrowIpc will handle the coercion
        dataSlice.fromArrowIpc(new Uint8Array(result.arrowBuffers[0]));
      }
    } else {
      // No traversal — pass through to SQL builder
      let sql = this.sqlBuilder.viewGetData(viewId, config, viewport, schema);
      sql = this.qualifyViewSql(sql, viewId);
      const result = await runQuery(sql);
      if (!result.ok) throw new Error(result.error || "Query failed");
      if (result.arrowBuffers?.length) {
        dataSlice.fromArrowIpc(new Uint8Array(result.arrowBuffers[0]));
      }
    }
  }

  async viewSize(viewId: string): Promise<number> {
    const traversal = this.traversals.get(viewId);
    if (traversal) return traversal.length;
    let sql = this.sqlBuilder.viewSize(viewId);
    sql = this.qualifyViewSql(sql, viewId);
    const rows = await queryRows(sql);
    return Number(Object.values(rows[0] ?? {})[0] ?? 0);
  }

  async viewSchema(viewId: string): Promise<Record<string, ColumnType>> {
    // Describe the view table in memory.main
    const rows = await queryRows(`DESCRIBE memory.main."${viewId}"`);
    const schema: Record<string, ColumnType> = {};
    for (const row of rows) {
      if (!row.column_name?.startsWith("__")) {
        schema[row.column_name] = duckdbTypeToPsp(row.column_type);
      }
    }
    return schema;
  }

  async tableValidateExpression(tableId: string, expression: string): Promise<ColumnType> {
    const sql = this.sqlBuilder.tableValidateExpression(tableId, expression);
    const rows = await queryRows(sql);
    return duckdbTypeToPsp(rows[0]?.column_type ?? "varchar");
  }

  async viewGetMinMax(viewId: string, columnName: string, config: any): Promise<{ min: any; max: any }> {
    let sql = this.sqlBuilder.viewGetMinMax(viewId, columnName, config);
    sql = this.qualifyViewSql(sql, viewId);
    const rows = await queryRows(sql);
    let [min, max] = Object.values(rows[0] ?? {});
    if (typeof min === "bigint") min = Number(min);
    if (typeof max === "bigint") max = Number(max);
    return { min: min ?? null, max: max ?? null };
  }
}
