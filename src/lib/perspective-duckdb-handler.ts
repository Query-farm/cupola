/**
 * Perspective VirtualServerHandler backed by the VGI DuckDB WASM worker.
 *
 * Modeled on Perspective's DuckDBHandler but uses our existing __duckdbQuery
 * window function instead of @duckdb/duckdb-wasm's AsyncDuckDBConnection.
 *
 * Reference: ~/Development/perspective/rust/perspective-js/src/ts/virtual_servers/duckdb.ts
 */

import { tableFromIPC } from "@query-farm/apache-arrow";
import { engine } from "@/lib/shell-bridge";
import { QUERY_PIVOT_PREFIX } from "@/lib/pivot-source";

// ---------------------------------------------------------------------------
// Traversal — tracks visible rows for collapse/expand in grouped views
// ---------------------------------------------------------------------------

interface TraversalNode {
  dbRowIndex: number;     // Row index in the DuckDB materialized view
  depth: number;          // Tree depth (0 = total, 1 = first group level, etc.)
  expanded: boolean;      // Whether children are visible in the traversal
  childCount: number;     // Number of direct children in the full tree
}

/**
 * Fully-qualified, quoted name for one of the handler's scratch views: the
 * source view per hosted table, and one view per Perspective view.
 *
 * They live in `temp.main` (VGI catalogs are read-only, so they need a
 * writable home). They used to live in `memory.main`, which broke over TEMP
 * sources: DuckDB binds the names inside a view in its own database's context,
 * so a memory.main view over an editor live-view pivot — a TEMP view of, say,
 * `SELECT * FROM large.orders_2m` — resolved `large` against the memory catalog
 * and failed ("schema large does not exist"). TEMP views keep the connection's
 * search path. DuckDB only creates in `temp` with the TEMP keyword, so every
 * CREATE of one says `CREATE TEMP VIEW`. They also stay out of the sidebar,
 * which lists the memory catalog and showed every one of these views.
 */
export function scratchView(name: string): string {
  return `temp.main.${ident(name)}`;
}

function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

class ViewTraversal {
  nodes: TraversalNode[];        // Currently visible rows
  private allNodes: TraversalNode[];  // Full tree (immutable after build)

  private constructor(allNodes: TraversalNode[], _groupByLen: number) {
    this.allNodes = allNodes;
    this.nodes = [...allNodes]; // Start fully expanded
  }

  /** Build a traversal from the __GROUPING_ID__ column of a grouped DuckDB result. */
  static async build(viewId: string, groupByLen: number): Promise<ViewTraversal | null> {
    if (groupByLen === 0) return null;

    // Query just the grouping ID column to determine tree structure
    const qualifiedView = scratchView(viewId);
    const result = await runQuery(
      `SELECT "__GROUPING_ID__" FROM ${qualifiedView}`,
      "viewTraversal",
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

// Filter operators, aggregates, and window aggregates mirror upstream's own
// DuckDB handler (`virtual_servers/duckdb.ts`, 5.5.1).
const FILTER_OPS = [
  "==", "!=", "IS DISTINCT FROM", "IS NOT DISTINCT FROM",
  ">=", "<=", ">", "<", "is null", "is not null",
];

const STRING_FILTER_OPS = [
  ...FILTER_OPS,
  "begins with", "not begins with", "contains", "not contains",
  "ends with", "not ends with", "matches", "not matches", "in", "not in",
  "LIKE", "NOT LIKE", "ILIKE", "NOT ILIKE",
];

const FRAMES = ["rows", "range", "cumulative"];

const WINDOW_AGGREGATES = [
  { name: "sum", frames: FRAMES, result_type: "float" },
  { name: "avg", frames: FRAMES, result_type: "float" },
  { name: "count", frames: FRAMES, result_type: "float" },
  { name: "min", frames: FRAMES },
  { name: "max", frames: FRAMES },
  { name: "product", frames: FRAMES, result_type: "float" },
  { name: "median", frames: FRAMES, result_type: "float" },
  { name: "stddev_samp", frames: FRAMES, result_type: "float" },
  { name: "stddev_pop", frames: FRAMES, result_type: "float" },
  { name: "var_samp", frames: FRAMES, result_type: "float" },
  { name: "var_pop", frames: FRAMES, result_type: "float" },
  { name: "first_value", frames: FRAMES },
  { name: "last_value", frames: FRAMES },
  { name: "nth_value", frames: FRAMES, offset: true },
  { name: "lag", offset: true },
  { name: "lead", offset: true },
  { name: "row_number", result_type: "float" },
  { name: "rank", result_type: "float" },
  { name: "dense_rank", result_type: "float" },
  { name: "percent_rank", result_type: "float" },
  { name: "cume_dist", result_type: "float" },
  { name: "ntile", offset: true, result_type: "float" },
  { name: "diff", offset: true, result_type: "float" },
  { name: "rate", frames: ["range"], result_type: "float" },
];

// Arithmetic is undefined for the non-numeric types; ordering and navigation are not.
const WINDOW_AGGREGATES_ANY = [
  { name: "count", frames: FRAMES, result_type: "float" },
  { name: "min", frames: FRAMES },
  { name: "max", frames: FRAMES },
  { name: "first_value", frames: FRAMES },
  { name: "last_value", frames: FRAMES },
  { name: "nth_value", frames: FRAMES, offset: true },
  { name: "lag", offset: true },
  { name: "lead", offset: true },
  { name: "row_number", result_type: "float" },
  { name: "rank", result_type: "float" },
  { name: "dense_rank", result_type: "float" },
  { name: "percent_rank", result_type: "float" },
  { name: "cume_dist", result_type: "float" },
  { name: "ntile", offset: true, result_type: "float" },
];

/**
 * How a hosted table is served, chosen per table by whether it has a `rowid`
 * (DuckDB tables do; views and VGI catalog tables do not) — see
 * `perspectiveServeMode`.
 *
 * - `materialized`: upstream's DuckDB configuration. Each Perspective layout
 *   is a TEMP TABLE and `rowid` gives unsorted grids a stable order, so
 *   split_by (a data-dependent PIVOT) and natural-order windows work.
 * - `live`: each layout is a TEMP VIEW, so nothing is copied and every page
 *   is read from the source on demand. With no row identity, unsorted grids
 *   have no guaranteed order (the `row_id_expr` orders by nothing),
 *   windows need an explicit order (`unordered`), and split_by is off —
 *   DuckDB will not store a data-dependent PIVOT in a view. Upstream's
 *   view-based servers (Postgres, ClickHouse) make the same trade.
 */
export type PerspectiveServeMode = "materialized" | "live";

const SQL_MODEL_COMMON = { column_separator: "|", like_escape_clause: "\\", regex_fn: "regexp_matches" };
// Scratch objects live in `temp.main` (see `scratchView`), and DuckDB only
// creates there with the TEMP keyword.
const SQL_MODEL_ARGS: Record<PerspectiveServeMode, Record<string, string>> = {
  materialized: { ...SQL_MODEL_COMMON, create_entity: "TEMP TABLE", drop_entity: "TABLE" },
  // A typed NULL orders by nothing. A bare `NULL` is refused by DuckDB
  // ("ORDER BY non-integer literal has no effect"); a cast is an expression.
  live: { ...SQL_MODEL_COMMON, create_entity: "TEMP VIEW", drop_entity: "VIEW", row_id_expr: "CAST(NULL AS INTEGER)" },
};

import { Type as ArrowType } from "@query-farm/apache-arrow";

/**
 * Map an Arrow field's DataType to a Perspective column type.
 * Returns null for types Perspective cannot handle (nested, geometry, blob, etc.).
 * Uses Arrow's numeric typeId for reliable classification instead of string matching.
 */
function arrowTypeToPsp(field: any): ColumnType | null {
  const dt = field.type;
  if (!dt) return null;
  const id = dt.typeId;

  // Check extension metadata for geometry types
  const extName = field.metadata?.get?.("ARROW:extension:name") ?? "";
  if (extName.startsWith("geoarrow.")) return null;

  switch (id) {
    // Strings
    case ArrowType.Utf8:
    case ArrowType.LargeUtf8:
      return "string";

    // Integers
    case ArrowType.Int8:
    case ArrowType.Int16:
    case ArrowType.Int32:
    case ArrowType.Int64:
    case ArrowType.Uint8:
    case ArrowType.Uint16:
    case ArrowType.Uint32:
    case ArrowType.Uint64:
    case ArrowType.Int:
      return "integer";

    // Floats
    case ArrowType.Float16:
    case ArrowType.Float32:
    case ArrowType.Float64:
    case ArrowType.Float:
    case ArrowType.Decimal:
      return "float";

    // Boolean
    case ArrowType.Bool:
      return "boolean";

    // Date
    case ArrowType.Date:
    case ArrowType.DateDay:
    case ArrowType.DateMillisecond:
      return "date";

    // Timestamp (with or without timezone)
    case ArrowType.Timestamp:
    case ArrowType.TimestampSecond:
    case ArrowType.TimestampMillisecond:
    case ArrowType.TimestampMicrosecond:
    case ArrowType.TimestampNanosecond:
      return "datetime";

    // FixedSizeBinary — only accept known sizes:
    // 16 bytes: hugeint/uhugeint (no ext name), uuid (arrow.uuid)
    // 8 bytes: timetz
    case ArrowType.FixedSizeBinary: {
      const size = dt.byteWidth;
      if (size === 16 && extName === "arrow.uuid") return "string";
      if (size === 16) return "float"; // hugeint/uhugeint → f64
      if (size === 8) return "string"; // timetz
      return null; // unknown fixed-size binary — exclude
    }

    // Binary types — only accept bit (small). Blob/bignum/varint excluded.
    case ArrowType.Binary:
    case ArrowType.LargeBinary: {
      const extMeta = field.metadata?.get?.("ARROW:extension:metadata");
      if (extMeta) {
        try {
          if (JSON.parse(extMeta)?.type_name === "bit") return "string";
        } catch {}
      }
      return null;
    }

    // Interval
    case ArrowType.Interval:
    case ArrowType.IntervalDayTime:
    case ArrowType.IntervalYearMonth:
      return "string";

    // Dictionary-encoded (typically enum/low-cardinality strings)
    case ArrowType.Dictionary:
      return "string";

    // Nested/composite types — Perspective cannot handle these
    case ArrowType.List:
    case ArrowType.Struct:
    case ArrowType.Map:
    case ArrowType.DenseUnion:
    case ArrowType.SparseUnion:
    case ArrowType.FixedSizeList:
      // No LargeList case: Arrow's `Type` enum has no such member (large lists
      // only exist as a flatbuffers wire type). The `default` below already
      // returns null, so they — and any future nested type — are rejected the
      // same way.
      return null;

    default:
      return null;
  }
}

/** Get Arrow schema fields for a table by querying LIMIT 0. */
async function getArrowSchema(tableId: string, step: string): Promise<any[]> {
  const result = await runQuery(`SELECT * FROM ${tableId} LIMIT 0`, step);
  if (!result.ok || !result.arrowBuffers?.length) return [];
  const table = tableFromIPC(new Uint8Array(result.arrowBuffers[0]));
  return table.schema.fields;
}

/**
 * Execute a SQL query via the shared DuckDB WASM worker, logging it.
 *
 * Every query the virtual server runs passes through here, so this is where
 * Perspective's SQL becomes visible: the builder generates it inside wasm and
 * nothing else shows it. Each line names the handler step that issued it
 * (`tableMakeView`, `viewGetData`, …), its time, and its result size or error.
 * Failures are logged, not warned: the `rowid` probes fail by design on views.
 */
async function runQuery(sql: string, step: string): Promise<{ arrowBuffers?: ArrayBuffer[]; ok: boolean; error?: string }> {
  const queryFn = engine.query;
  if (!queryFn) throw new Error("DuckDB shell not initialized");
  const started = performance.now();
  const result = await queryFn(sql);
  const took = `${Math.round(performance.now() - started)} ms`;
  if (result.ok) {
    const bytes = result.arrowBuffers?.reduce((sum, buffer) => sum + buffer.byteLength, 0) ?? 0;
    console.log(`[perspective sql] ${step} · ${took} · ${formatBytes(bytes)}\n${sql}`);
  } else {
    console.log(`[perspective sql] ${step} · ${took} · failed: ${result.error}\n${sql}`);
  }
  return result;
}

/** The same logged runner, for cupola's own Perspective SQL (query pivot sources). */
export const runPerspectiveQuery = runQuery;

/**
 * Which handler serves a table: `materialized` when it has a `rowid` (DuckDB
 * tables — Table-mode pivots, `memory` tables), `live` otherwise (views and
 * VGI catalog tables). The probe binds without scanning.
 */
export async function perspectiveServeMode(tableId: string): Promise<PerspectiveServeMode> {
  const probe = await runQuery(`SELECT rowid FROM ${tableId} LIMIT 0`, "serveMode");
  return probe.ok ? "materialized" : "live";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Execute SQL and parse Arrow IPC into row objects. */
async function queryRows(sql: string, step: string): Promise<any[]> {
  const result = await runQuery(sql, step);
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
  private tableSizeCache = new Map<string, number>();
  private tableSchemaCache = new Map<string, Record<string, ColumnType>>();
  private viewSizeCache = new Map<string, number>();
  private sourceViewCache = new Set<string>();
  /** Traversals for grouped views — enables collapse/expand. */
  private traversals = new Map<string, ViewTraversal>();

  constructor(_perspectiveMod: any, readonly mode: PerspectiveServeMode = "live") {
  }

  /**
   * Fully-qualified, quoted name for a Perspective-generated view id.
   *
   * The SQL model's scratch views are created in `temp.main` (see
   * `scratchView`) and every reference to them has to say so. The builder
   * interpolates whatever id it is given verbatim, and *only* ever in a table
   * position — `CREATE {entity} {} AS`, `DROP {entity} IF EXISTS {}`, `FROM {}`,
   * `DESCRIBE {}` — so handing it the qualified name up front produces correct
   * SQL directly.
   *
   * This replaces a regex that rewrote the id inside already-generated SQL. That
   * approach had to guess at token boundaries with a lookbehind and would
   * happily rewrite an identically-named token inside a string literal, so a
   * filter on the right value could corrupt the query.
   */
  private qualifiedView(viewId: string): string {
    return scratchView(viewId);
  }

  private get sqlBuilder() {
    if (!this._sqlBuilder) {
      // Get the WASM module from the already-initialized perspective-viewer custom element.
      // The viewer class has __wasm_module__ set after perspective.worker() is called.
      const viewerClass = customElements?.get("perspective-viewer") as any;
      const wasmMod = viewerClass?.__wasm_module__;
      if (wasmMod?.GenericSQLVirtualServerModel) {
        this._sqlBuilder = new wasmMod.GenericSQLVirtualServerModel(SQL_MODEL_ARGS[this.mode]);
      } else {
        throw new Error("Perspective WASM not initialized — call perspective.worker() first");
      }
    }
    return this._sqlBuilder;
  }

  getFeatures() {
    const live = this.mode === "live";
    return {
      group_by: true,
      split_by: !live,
      sort: true,
      expressions: true,
      // No row identity: Perspective then rejects a window without an
      // explicit order_by, rather than the SQL failing on `rowid`.
      unordered: live,
      window_aggregates: {
        integer: WINDOW_AGGREGATES,
        float: WINDOW_AGGREGATES,
        string: WINDOW_AGGREGATES_ANY,
        date: WINDOW_AGGREGATES_ANY,
        datetime: WINDOW_AGGREGATES_ANY,
        boolean: WINDOW_AGGREGATES_ANY,
      },
      group_rollup_mode: ["rollup", "flat", "total"],
      ...(live ? {} : { split_rollup_mode: ["flat", "rollup"] }),
      filter_ops: {
        integer: FILTER_OPS,
        float: FILTER_OPS,
        string: STRING_FILTER_OPS,
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
    // Perspective refuses to open a table missing from this list ("No table
    // set"), and duckdb_tables() has no views. The editor's live-view pivots
    // are TEMP views, so they are listed too — only those, not every view, or
    // the handler's own scratch views would appear wherever the list shows.
    const pivotViews = QUERY_PIVOT_PREFIX.replace(/_/g, "\\_");
    const rows = await queryRows(`
      SELECT database_name, schema_name, table_name FROM duckdb_tables()
      UNION ALL
      SELECT database_name, schema_name, view_name FROM duckdb_views()
       WHERE temporary AND view_name LIKE '${pivotViews}%' ESCAPE '\\'`, "getHostedTables");
    return rows.map((row) => `${row.database_name}.${row.schema_name}.${row.table_name}`);
  }

  async tableSchema(tableId: string): Promise<Record<string, ColumnType>> {
    const cached = this.tableSchemaCache.get(tableId);
    if (cached) return cached;
    const qualifiedId = tableId.includes(".") ? tableId : scratchView(tableId);
    const fields = await getArrowSchema(qualifiedId, "tableSchema");
    const schema: Record<string, ColumnType> = {};
    for (const field of fields) {
      if (field.name.startsWith("__")) continue;
      const pspType = arrowTypeToPsp(field);
      if (pspType === null) continue;
      schema[field.name] = pspType;
    }
    this.tableSchemaCache.set(tableId, schema);
    return schema;
  }

  async tableSize(tableId: string): Promise<number> {
    const cached = this.tableSizeCache.get(tableId);
    if (cached !== undefined) return cached;
    // A bare id (no dots) is one of our scratch views, not a catalog table.
    const sql = this.sqlBuilder.tableSize(
      tableId.includes(".") ? tableId : this.qualifiedView(tableId),
    );
    const rows = await queryRows(sql, "tableSize");
    const size = Number(rows[0]?.["count_star()"] ?? 0);
    this.tableSizeCache.set(tableId, size);
    return size;
  }

  private sourceViewId(tableId: string): string {
    return scratchView(`__psp_source_${tableId.replace(/\./g, "_")}`);
  }

  /**
   * Forget a hosted table its owner is about to drop — a query pivot's
   * scratch view or table. Drops the source view built over it and every
   * cache keyed by its name, which would otherwise outlive it.
   */
  async releaseTable(tableId: string): Promise<void> {
    if (this.sourceViewCache.has(tableId)) await runQuery(`DROP VIEW IF EXISTS ${this.sourceViewId(tableId)}`, "releaseTable");
    this.sourceViewCache.delete(tableId);
    this.tableSizeCache.delete(tableId);
    this.tableSchemaCache.delete(tableId);
  }

  /**
   * The view Perspective's SQL builder reads a hosted table through: its
   * displayable columns under their own names, with dates and timestamps
   * clamped to the range JavaScript can show.
   *
   * It used to also rename every `_` to `-`, a workaround for Perspective's
   * SQL builder building split_by column names from DuckDB's `_`-joined PIVOT
   * output (perspective-dev/perspective#3187). Upstream fixed that in 5.0 —
   * the builder now joins with `|` and passes underscores through — so the
   * rename only changed the user's column names, and collided `a_b` with
   * `a-b`.
   */
  private async ensureSourceView(tableId: string): Promise<string> {
    const sourceViewId = this.sourceViewId(tableId);
    if (this.sourceViewCache.has(tableId)) return sourceViewId;

    // Get Arrow schema to classify columns by their actual Arrow DataType
    const fields = await getArrowSchema(tableId, "sourceView");
    const aliases = fields
      .filter((f: any) => !f.name.startsWith("__") && arrowTypeToPsp(f) !== null)
      .map((f: any) => {
        const col = ident(f.name);
        const alias = col;
        const pspType = arrowTypeToPsp(f);
        const typeStr = f.type?.toString() ?? "";
        const isTz = typeStr.includes(",") && typeStr.includes("Timestamp"); // Timestamp<MICROSECOND, UTC>

        // Clamp date values to JS Date range to avoid RangeError in Perspective's datagrid
        if (pspType === "date") {
          return `CASE WHEN ${col} BETWEEN '0001-01-01'::DATE AND '9999-12-31'::DATE THEN ${col} ELSE NULL END as ${alias}`;
        }
        if (pspType === "datetime") {
          // Precision variants (Second, Nanosecond) need TRY_CAST to avoid overflow with extreme values
          const targetType = isTz ? "TIMESTAMPTZ" : "TIMESTAMP";
          const isBase = typeStr.includes("MICROSECOND") || typeStr.includes("MILLISECOND");
          const castCol = isBase ? col : `TRY_CAST(${col} AS ${targetType})`;
          const caseExpr = `CASE WHEN ${castCol} BETWEEN '0001-01-01'::${targetType} AND '9999-12-31'::${targetType} THEN ${castCol} ELSE NULL END`;
          return isTz ? `CAST(${caseExpr} AS ${targetType}) as ${alias}` : `${caseExpr} as ${alias}`;
        }
        return `${col} as ${alias}`;
      })
      .join(", ");

    // A materialized source's `rowid` is re-exported as a column: the builder
    // orders by `rowid` against this view, and a pseudo-column does not pass
    // through a view on its own.
    const selectCols = this.mode === "materialized" ? `rowid, ${aliases}` : aliases;

    // Checked: a failure here otherwise surfaced one step later, from the
    // first pivot view, as a misleading "table … does not exist".
    const created = await runQuery(`CREATE OR REPLACE TEMP VIEW ${sourceViewId} AS SELECT ${selectCols} FROM ${tableId}`, "sourceView");
    if (!created.ok) throw new Error(created.error || `Could not create ${sourceViewId}`);
    this.sourceViewCache.add(tableId);
    return sourceViewId;
  }

  async tableMakeView(tableId: string, viewId: string, config: any): Promise<void> {
    const sourceView = await this.ensureSourceView(tableId);
    // Window order keys need column types for `range` frame emission.
    const schema = Object.keys(config.windows ?? {}).length ? await this.tableSchema(tableId) : undefined;
    // `create_entity` makes this a TEMP TABLE or TEMP VIEW per mode, and
    // `row_id_expr` gives it the right natural order — no rewriting needed.
    const sql = this.sqlBuilder.tableMakeView(sourceView, this.qualifiedView(viewId), config, schema);

    const result = await runQuery(sql, "tableMakeView");
    if (!result.ok) throw new Error(result.error || "Failed to create view");
    this.viewSizeCache.delete(viewId);

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
    // `drop_entity` matches `create_entity`, so no DROP TABLE-then-VIEW retry.
    await runQuery(this.sqlBuilder.viewDelete(this.qualifiedView(viewId)), "viewDelete");
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
      const qualifiedView = scratchView(viewId);
      const sql = `SELECT * FROM (
        SELECT *, ROW_NUMBER() OVER () - 1 as __db_row_idx__
        FROM ${qualifiedView}
      ) sub WHERE __db_row_idx__ IN (${dbIndices.join(",")})
      ORDER BY array_position([${dbIndices.join(",")}]::INTEGER[], __db_row_idx__::INTEGER)`;
      const result = await runQuery(sql, "viewGetData");
      if (!result.ok) throw new Error(result.error || "Query failed");
      if (result.arrowBuffers?.length) {
        // Remove the __db_row_idx__ helper column before passing to Perspective
        // fromArrowIpc will handle the coercion
        dataSlice.fromArrowIpc(new Uint8Array(result.arrowBuffers[0]));
      }
    } else {
      // No traversal — pass through to SQL builder
      const sql = this.sqlBuilder.viewGetData(
        this.qualifiedView(viewId), config, viewport, schema,
      );
      const result = await runQuery(sql, "viewGetData");
      if (!result.ok) throw new Error(result.error || "Query failed");
      if (result.arrowBuffers?.length) {
        dataSlice.fromArrowIpc(new Uint8Array(result.arrowBuffers[0]));
      }
    }
  }

  async viewSize(viewId: string): Promise<number> {
    const traversal = this.traversals.get(viewId);
    if (traversal) return traversal.length;
    const cached = this.viewSizeCache.get(viewId);
    if (cached !== undefined) return cached;
    const sql = this.sqlBuilder.viewSize(this.qualifiedView(viewId));
    const rows = await queryRows(sql, "viewSize");
    const size = Number(Object.values(rows[0] ?? {})[0] ?? 0);
    this.viewSizeCache.set(viewId, size);
    return size;
  }

  async viewSchema(viewId: string): Promise<Record<string, ColumnType>> {
    const fields = await getArrowSchema(scratchView(viewId), "viewSchema");
    const schema: Record<string, ColumnType> = {};
    for (const field of fields) {
      if (field.name.startsWith("__")) continue;
      const pspType = arrowTypeToPsp(field);
      if (pspType === null) continue;
      schema[field.name] = pspType;
    }
    return schema;
  }

  async tableValidateExpression(tableId: string, expression: string): Promise<ColumnType> {
    // Expression validation still uses DESCRIBE since the SQL builder generates the query
    const sql = this.sqlBuilder.tableValidateExpression(tableId, expression);
    const result = await runQuery(sql, "validateExpression");
    if (!result.ok || !result.arrowBuffers?.length) return "string";
    const table = tableFromIPC(new Uint8Array(result.arrowBuffers[0]));
    const field = table.schema.fields[0];
    return field ? (arrowTypeToPsp(field) ?? "string") : "string";
  }

  async viewGetMinMax(viewId: string, columnName: string, config: any): Promise<{ min: any; max: any }> {
    const sql = this.sqlBuilder.viewGetMinMax(this.qualifiedView(viewId), columnName, config);
    const rows = await queryRows(sql, "viewGetMinMax");
    let [min, max] = Object.values(rows[0] ?? {});
    if (typeof min === "bigint") min = Number(min);
    if (typeof max === "bigint") max = Number(max);
    return { min: min ?? null, max: max ?? null };
  }
}
