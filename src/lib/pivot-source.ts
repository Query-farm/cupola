/**
 * Query-backed Perspective pivots: register the editor's query in DuckDB under
 * a name, so Perspective's virtual server can pivot it with SQL instead of
 * receiving a copy of the result.
 *
 * - `view`: `CREATE TEMP VIEW … AS <query>`. Nothing is copied; every pivot
 *   change, scroll, row count, and filter list re-runs the query, so DuckDB
 *   can push projections and LIMITs down and fetch only what each request
 *   needs. There is no `rowid`, so an unsorted flat grid has no guaranteed
 *   row order unless the query sorts.
 * - `table`: `CREATE TEMP TABLE … AS <query>`. The query runs once and its
 *   result lives in DuckDB; pivots read that copy, in stable `rowid` order.
 *
 * TEMP objects last for the connection, and cupola runs every query — editor,
 * shell, Perspective — on the one connection opened at boot, so they survive
 * Perspective's repeated queries and vanish on reload. They also stay out of
 * the sidebar, which lists the `memory` catalog; `temp` is a separate one.
 *
 * DuckDB stores a view as SQL text and resolves its table names each time it
 * is queried, against the search path at that moment (probed on haybarn: a
 * `USE memory` after creation broke even `small.monthly_targets`). A later
 * `USE` can therefore break a live-view pivot; the table mode resolved its
 * names once, at creation.
 */
import { splitStatements } from "@/lib/editor/sql-statements";

export type QueryPivotMode = "view" | "table";
export type PerspectivePivotMode = QueryPivotMode | "snapshot";

export interface QueryPivotSource {
  /** Three-part name, safe to interpolate: the handler puts it in FROM verbatim. */
  tableId: string;
  mode: QueryPivotMode;
}

type RunSql = (sql: string) => Promise<{ ok: boolean; error?: string }>;

/**
 * The statement a pivot wraps: the last one that ran, without its terminator.
 * A multi-statement run already executed the earlier statements, and its
 * result grid shows the last one's rows.
 */
export function pivotStatement(sql: string): string | null {
  const last = splitStatements(sql).at(-1)?.text.replace(/;\s*$/, "").trim();
  return last || null;
}

/** Name prefix of every pivot source; the handler lists these views as hosted. */
export const QUERY_PIVOT_PREFIX = "__cupola_pivot_";

let sequence = 0;

/**
 * Every pivot gets a fresh name. The virtual-server handler caches a table's
 * schema, size, ordering, and rename view by name, so reusing one would serve
 * the previous query's answers.
 */
export async function createQueryPivotSource(sql: string, mode: QueryPivotMode, run: RunSql): Promise<QueryPivotSource> {
  const statement = pivotStatement(sql);
  if (!statement) throw new Error("There is no query to pivot.");
  const name = `${QUERY_PIVOT_PREFIX}${++sequence}`;
  // A newline, not a space, before the query: a trailing `-- comment` on the
  // CREATE line would otherwise swallow it.
  const result = await run(`CREATE TEMP ${mode === "view" ? "VIEW" : "TABLE"} "${name}" AS\n${statement}`);
  if (!result.ok) {
    const how = mode === "view" ? "a live view" : "a table";
    throw new Error(`This result can't be pivoted as ${how}: ${result.error ?? "DuckDB rejected the query"}. Snapshot works for any result.`);
  }
  return { tableId: `temp.main.${name}`, mode };
}

export async function dropQueryPivotSource(source: QueryPivotSource, run: RunSql): Promise<void> {
  const name = source.tableId.slice("temp.main.".length);
  await run(`DROP ${source.mode === "view" ? "VIEW" : "TABLE"} IF EXISTS temp.main."${name}"`);
}
