/**
 * Shared helpers for the AI agent's tool implementations.
 *
 * Each AI surface (AskAIChat React panel, terminal `.ai` mode) owns its own
 * tool-dispatch switch — the side effects diverge too much to fully
 * unify (UI state updates vs terminal output). These helpers extract the
 * pure, identical parts so a bug fix lands in one place:
 *
 *   - executeRunSql: error classification (fatal vs retryable), DDL vs
 *     empty vs row-bearing result detection, recording, JSON serialization.
 *     UI side effects (print, navigate, refresh) come in as callbacks.
 *   - describeTableWithFallback: the SQL-fallback path for tables in
 *     secondary-attached catalogs that aren't in the primary CatalogData.
 *   - validateChartSpec: shape-walk for the render_chart tool that rejects
 *     any external-resource reference (url/href/src) at any nesting depth.
 *
 * Tools that have no UI side effects (read_query_results, list_tables,
 * the in-catalog describe_table) are already shared via their direct
 * exports from `./ai-agent` — both surfaces import them as-is.
 */
import { tableFromIPC, type Table } from "apache-arrow";
import { formatArrowTableAsJson, executeDescribeTable } from "./ai-agent";
import type { CatalogData } from "./service";
import type { QueryResult } from "./shell-bridge";

// ---------------------------------------------------------------------------
// run_sql
// ---------------------------------------------------------------------------

export interface RunSqlEnv {
  query: (sql: string) => Promise<QueryResult>;
}

export type RunSqlOutcome =
  /** Query failed. errMsg is the user-facing message; isFatal means the
   *  outer agent loop should stop (VGI server unreachable, etc.). */
  | { kind: "error"; errMsg: string; elapsedMs: number; isFatal: boolean }
  /** Query succeeded with no result buffer (e.g. SET, COMMENT, INSERT). */
  | { kind: "empty"; elapsedMs: number }
  /** DDL — single "Count" column, ≤1 row. Surface should refresh catalog. */
  | { kind: "ddl"; sql: string; elapsedMs: number }
  /** Normal result table. Surface should render to UI. */
  | { kind: "table"; sql: string; table: Table; json: string; elapsedMs: number };

export interface RunSqlCallbacks {
  /** Called once before the query fires (e.g. start spinner, set running flag). */
  onStart?: () => void;
  /** Called once after the query completes, win or lose. */
  onEnd?: () => void;
  /** Called with the classified outcome so the surface can render. */
  onOutcome?: (outcome: RunSqlOutcome) => void | Promise<void>;
}

/** Classify a DuckDB / VGI error message as fatal (stop the agent loop)
 *  or retryable (let the model see the error and try again). Errors that
 *  look like the VGI server itself is unreachable are fatal — retrying
 *  would just keep failing. */
function isFatalSqlError(errMsg: string): boolean {
  return errMsg.includes("HTTP Error") || errMsg.includes("HTTP 5");
}

/**
 * Run a SQL query as part of the AI agent's `run_sql` tool. Returns the
 * JSON string for the tool_result (what the model sees). The provided
 * callbacks handle UI rendering — this helper owns only the classification.
 *
 * Throws on fatal errors (caller's agent loop catches and stops).
 */
export async function executeRunSql(
  sql: string,
  env: RunSqlEnv,
  callbacks: RunSqlCallbacks = {},
): Promise<string> {
  callbacks.onStart?.();
  const t0 = performance.now();
  let result: QueryResult;
  try {
    result = await env.query(sql);
  } finally {
    // onEnd runs even on thrown query errors so spinners/flags get cleared.
    // The classification below still happens against the captured result.
  }
  const elapsedMs = performance.now() - t0;
  callbacks.onEnd?.();

  if (!result.ok) {
    const errMsg = result.error || "Query failed";
    const isFatal = isFatalSqlError(errMsg);
    await callbacks.onOutcome?.({ kind: "error", errMsg, elapsedMs, isFatal });
    if (isFatal) {
      const err = new Error(`VGI connection error: ${errMsg}`);
      (err as any).fatal = true;
      throw err;
    }
    throw new Error(errMsg);
  }

  const firstBuf = result.arrowBuffers?.[0];
  const isEmptyBuf =
    !firstBuf ||
    (firstBuf instanceof ArrayBuffer ? firstBuf.byteLength === 0 : (firstBuf as Uint8Array).length === 0);
  if (isEmptyBuf) {
    await callbacks.onOutcome?.({ kind: "empty", elapsedMs });
    return JSON.stringify({ ok: true, message: "Query executed successfully" });
  }

  const table = tableFromIPC(firstBuf instanceof ArrayBuffer ? new Uint8Array(firstBuf) : firstBuf);

  // DDL: DuckDB returns a single "Count" column with ≤1 row for
  // CREATE/DROP/ALTER and similar statements that don't produce a row set.
  const fields = table.schema.fields;
  if (fields.length === 1 && fields[0].name === "Count" && table.numRows <= 1) {
    await callbacks.onOutcome?.({ kind: "ddl", sql, elapsedMs });
    return JSON.stringify({ ok: true, message: "Query executed successfully" });
  }

  const { json } = formatArrowTableAsJson(table);
  await callbacks.onOutcome?.({ kind: "table", sql, table, json, elapsedMs });
  return json;
}

// ---------------------------------------------------------------------------
// describe_table
// ---------------------------------------------------------------------------

export interface DescribeTableInput {
  schema: string;
  table: string;
  catalog?: string;
}

/** Quote a SQL identifier (double-quote with embedded "" escaping). */
function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

/** Fetch column rows for any DuckDB-attached relation (table OR view) via
 *  duckdb_columns(). Returns null if the relation isn't found, the query
 *  fails, or it has no columns — callers treat null as "fall back". */
async function fetchColumnsViaSql(
  env: RunSqlEnv,
  database: string,
  schema: string,
  table: string,
): Promise<any[] | null> {
  const colSql = `SELECT column_name, data_type, is_nullable, column_default, comment FROM duckdb_columns() WHERE database_name = ${quoteIdent(database)} AND schema_name = ${quoteIdent(schema)} AND table_name = ${quoteIdent(table)} ORDER BY column_index`;
  const r = await env.query(colSql);
  if (!r.ok || !r.arrowBuffers?.length) return null;
  const buf = r.arrowBuffers[0];
  const t = tableFromIPC(buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf);
  if (t.numRows === 0) return null;
  const cols: any[] = [];
  for (let i = 0; i < t.numRows; i++) {
    const col: any = {
      name: String(t.getChildAt(0)?.get(i)),
      type: String(t.getChildAt(1)?.get(i)),
      nullable: String(t.getChildAt(2)?.get(i)) === "YES",
    };
    const def = t.getChildAt(3)?.get(i);
    if (def) col.default = String(def);
    const cmt = t.getChildAt(4)?.get(i);
    if (cmt) col.comment = String(cmt);
    cols.push(col);
  }
  return cols;
}

/**
 * describe_table that handles tables in secondary-attached or memory
 * catalogs by querying duckdb_columns()/duckdb_tables()/duckdb_constraints()
 * directly. For tables in the primary VGI catalog, delegates to the
 * shared executeDescribeTable (which uses the already-fetched CatalogData).
 *
 * Views are a special case: the VGI catalog payload (ViewInfo) ships no
 * column schema, so executeDescribeTable returns a columnless view stub.
 * We enrich it with live duckdb_columns() introspection (which covers views)
 * plus the view's SQL definition and column comments from the catalog —
 * otherwise the agent gets no column names and loops re-listing tables.
 */
export async function describeTableWithFallback(
  catalogData: CatalogData | null,
  env: RunSqlEnv,
  input: DescribeTableInput,
): Promise<string> {
  // Primary-catalog fast path — use the in-memory CatalogData.
  if ((!input.catalog || (catalogData && input.catalog === catalogData.catalogName)) && catalogData) {
    const base = executeDescribeTable(catalogData, input.schema, input.table);
    const parsed = JSON.parse(base);
    // Tables (and not-found errors) already carry everything they can; only
    // views need the live-column enrichment below.
    if (parsed?.type !== "view") return base;

    const cols = await fetchColumnsViaSql(env, catalogData.catalogName, input.schema, input.table);
    const viewInfo = catalogData.schemas
      .find((s) => s.info.name === input.schema)?.views
      .find((v) => v.name === input.table);
    if (cols) {
      // DuckDB often lacks per-column comments for views; the VGI catalog's
      // column_comments map is authoritative, so backfill from it.
      const comments = viewInfo?.column_comments;
      if (comments) {
        for (const c of cols) if (!c.comment && comments[c.name]) c.comment = comments[c.name];
      }
      parsed.columns = cols;
    }
    // The view's SQL definition lets the agent see exactly how each column is
    // derived — cheap to include and high-value for query planning.
    if (viewInfo?.definition) parsed.definition = viewInfo.definition;
    return JSON.stringify(parsed);
  }

  // Secondary catalog (memory / attached) — query DuckDB introspection tables.
  const cols = await fetchColumnsViaSql(env, input.catalog!, input.schema, input.table);
  if (!cols) {
    // Fall back to whatever the primary catalog knows (may be empty).
    return catalogData ? executeDescribeTable(catalogData, input.schema, input.table)
                       : JSON.stringify({ error: `Table ${input.schema}.${input.table} not found` });
  }

  const commentR = await env.query(`SELECT comment FROM duckdb_tables() WHERE database_name = ${quoteIdent(input.catalog!)} AND schema_name = ${quoteIdent(input.schema)} AND table_name = ${quoteIdent(input.table)}`);
  let tableComment: string | null = null;
  if (commentR.ok && commentR.arrowBuffers?.length) {
    const cbuf = commentR.arrowBuffers[0];
    const ct = tableFromIPC(cbuf instanceof ArrayBuffer ? new Uint8Array(cbuf) : cbuf);
    if (ct.numRows > 0) tableComment = String(ct.getChildAt(0)?.get(0) ?? "") || null;
  }

  const constraintR = await env.query(`SELECT constraint_type, constraint_column_names FROM duckdb_constraints() WHERE database_name = ${quoteIdent(input.catalog!)} AND schema_name = ${quoteIdent(input.schema)} AND table_name = ${quoteIdent(input.table)}`);
  let primaryKey: string[] | null = null;
  const checkConstraints: string[] = [];
  const uniqueConstraints: string[][] = [];
  if (constraintR.ok && constraintR.arrowBuffers?.length) {
    const cbuf2 = constraintR.arrowBuffers[0];
    const ct2 = tableFromIPC(cbuf2 instanceof ArrayBuffer ? new Uint8Array(cbuf2) : cbuf2);
    for (let i = 0; i < ct2.numRows; i++) {
      const ctype = String(ct2.getChildAt(0)?.get(i));
      const ccols = ct2.getChildAt(1)?.get(i);
      const colNames = ccols ? (Array.isArray(ccols) ? ccols.map(String) : [String(ccols)]) : [];
      if (ctype === "PRIMARY KEY") primaryKey = colNames;
      else if (ctype === "UNIQUE") uniqueConstraints.push(colNames);
      else if (ctype === "CHECK") checkConstraints.push(colNames.join(", "));
    }
  }

  return JSON.stringify({
    catalog: input.catalog,
    schema: input.schema,
    name: input.table,
    type: "table",
    comment: tableComment,
    primary_key: primaryKey,
    unique_constraints: uniqueConstraints.length > 0 ? uniqueConstraints : null,
    check_constraints: checkConstraints.length > 0 ? checkConstraints : null,
    columns: cols,
  });
}

// ---------------------------------------------------------------------------
// render_chart spec validation
// ---------------------------------------------------------------------------

/** Keys that, if present anywhere in a Vega-Lite spec, could trigger a network
 *  fetch (or worse). Rejecting them anywhere in the spec tree is overly strict
 *  but the chart tool's contract is "data comes from DuckDB, period" — there
 *  is no legitimate reason for these keys to appear. */
const FORBIDDEN_KEYS = new Set(["url", "href", "src"]);

/** Validate (and lightly normalize) a Vega-Lite spec from the LLM.
 *
 *  Returns:
 *    - errors[]: human-readable rejection reasons (empty = ok).
 *    - sanitized: a copy of the spec with `data` removed (we always inject
 *      rows from the SQL result).
 *
 *  This is a belt-and-suspenders defense; the embed call also passes a
 *  Vega loader that rejects all network requests. Both layers exist because
 *  Vega-Lite has more network surfaces than this validator can be sure to
 *  enumerate — locking the loader is the real guarantee. */
export function validateChartSpec(spec: unknown): { errors: string[]; sanitized: Record<string, any> } {
  const errors: string[] = [];
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    return { errors: ["spec must be a JSON object"], sanitized: {} };
  }
  // Deep-walk to find any forbidden keys anywhere in the tree. Note: we
  // walk the ORIGINAL spec (with `data` still attached) so the LLM can't
  // smuggle a url under data.* either; we strip data only after the walk.
  walkForForbiddenKeys(spec, "", errors);
  const sanitized = { ...(spec as Record<string, any>) };
  // Strip both `data` and `datasets`. We inject the SQL result as the
  // top-level data; an LLM-supplied `datasets` (used for multi-source
  // Vega-Lite charts) collides with our injection if it reuses the
  // internal data name and triggers "Duplicate data set name" at compile.
  // Multi-source charts aren't supported in v1 of render_chart anyway —
  // the LLM should produce a single SELECT with a category column.
  if ("data" in sanitized) delete sanitized.data;
  if ("datasets" in sanitized) delete sanitized.datasets;
  return { errors, sanitized };
}

// ---------------------------------------------------------------------------
// render_chart `extraData` validation
// ---------------------------------------------------------------------------

/** Reserved name for the primary dataset injected by the embed pipeline.
 *  Kept in sync with CUPOLA_DATA_NAME in components/chat/chart-embed.ts —
 *  duplicated here to avoid a React component import in a pure helper. */
const PRIMARY_DATA_NAME = "__cupola_data";

/** Vega-Lite dataset name pattern. Must start with a letter or underscore;
 *  rest can include alphanumerics + underscores. Matches what's safe to
 *  splice into a `data: { name: '...' }` reference without surprises. */
const EXTRA_DATA_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Soft cap on extra datasets per chart — defends against runaway agent
 *  loops that fan out into many SQL queries per chart. */
const MAX_EXTRA_DATA = 5;

export interface ExtraDataItem {
  name: string;
  sql: string;
}

/**
 * Validate the `extraData` parameter of render_chart. Returns a cleaned
 * array (trimmed strings) on success or an array of error strings.
 *
 * Rules:
 *  - At most MAX_EXTRA_DATA entries.
 *  - Each `name` matches EXTRA_DATA_NAME_RE.
 *  - No `name` equals PRIMARY_DATA_NAME (collision with primary).
 *  - `name`s are unique across the array.
 *  - `sql` is non-empty after trim.
 */
export function validateExtraData(extras: unknown): { errors: string[]; cleaned: ExtraDataItem[] } {
  if (extras === undefined || extras === null) return { errors: [], cleaned: [] };
  if (!Array.isArray(extras)) {
    return { errors: ["extraData must be an array"], cleaned: [] };
  }
  const errors: string[] = [];
  if (extras.length > MAX_EXTRA_DATA) {
    errors.push(`extraData has ${extras.length} entries (max ${MAX_EXTRA_DATA}). Combine sources or drop the least essential.`);
  }
  const cleaned: ExtraDataItem[] = [];
  const seenNames = new Set<string>();
  extras.forEach((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push(`extraData[${i}] must be an object with { name, sql }`);
      return;
    }
    const name = typeof (item as any).name === "string" ? (item as any).name.trim() : "";
    const sql = typeof (item as any).sql === "string" ? (item as any).sql.trim() : "";
    if (!name) {
      errors.push(`extraData[${i}].name is required`);
      return;
    }
    if (!EXTRA_DATA_NAME_RE.test(name)) {
      errors.push(`extraData[${i}].name "${name}" must match /^[a-zA-Z_][a-zA-Z0-9_]*$/`);
      return;
    }
    if (name === PRIMARY_DATA_NAME) {
      errors.push(`extraData[${i}].name "${name}" is reserved for the primary dataset`);
      return;
    }
    if (seenNames.has(name)) {
      errors.push(`extraData[${i}].name "${name}" is duplicated`);
      return;
    }
    if (!sql) {
      errors.push(`extraData[${i}].sql is required (got empty string)`);
      return;
    }
    seenNames.add(name);
    cleaned.push({ name, sql });
  });
  return { errors, cleaned };
}

function walkForForbiddenKeys(node: unknown, path: string, errors: string[]): void {
  if (node === null || node === undefined) return;
  if (typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((child, i) => walkForForbiddenKeys(child, `${path}[${i}]`, errors));
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (FORBIDDEN_KEYS.has(key) && typeof value === "string") {
      errors.push(`spec${path}.${key} is not allowed (external resources are forbidden in charts)`);
      continue;
    }
    walkForForbiddenKeys(value, `${path}.${key}`, errors);
  }
}

