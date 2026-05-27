/**
 * Session-scoped row cache for the AI chart tool.
 *
 * Keyed by chartId (a per-block uuid issued when render_chart runs). The
 * VegaChartBlock component reads rows from here on mount; the refresh button
 * re-runs the chart's SQL and replaces the entry.
 *
 * Each chartId can carry a PRIMARY dataset plus zero-or-more named EXTRAS
 * (multi-source charts; up to 5 per the validateExtraData cap). Primary is
 * read/written via the original cacheChartRows/getChartRows/refreshChartRows
 * API — those signatures are unchanged. Extras add three sibling helpers
 * (cacheChartExtra / getChartExtras / refreshChartExtra) that share the
 * same entry. evictChartRows drops everything for a chartId.
 *
 * Deliberately separate from src/lib/query-results.ts:
 *  - query-results.ts has a 3-entry LRU for the AI's `read_query_results`
 *    paging tool — polluting it with chart rows would evict pagination data.
 *  - Charts can stick around for the whole conversation; LRU eviction is
 *    explicit via evictChartRows() when a block is unmounted permanently.
 *
 * No persistence: rows live in memory for the session only. If conversation
 * persistence is added, persist {sql, spec, title, extraSources} and
 * rehydrate via refreshChartRows / refreshChartExtra — never serialize the
 * rows themselves.
 */
import { readRows } from "./duckdb-query";

export interface ChartDataset {
  rows: Record<string, any>[];
  columns: string[];
  fetchedAt: number;
}

interface ChartCacheEntry {
  primary: ChartDataset;
  /** Map of extra-dataset name → dataset. Empty for single-source charts. */
  extras: Map<string, ChartDataset>;
}

const cache = new Map<string, ChartCacheEntry>();

/** Store rows for a chartId's PRIMARY dataset. Called by the tool dispatcher
 *  right after the initial SELECT, and again on every refresh. */
export function cacheChartRows(chartId: string, rows: Record<string, any>[], columns: string[]): void {
  const existing = cache.get(chartId);
  const primary: ChartDataset = { rows, columns, fetchedAt: Date.now() };
  if (existing) {
    existing.primary = primary;
  } else {
    cache.set(chartId, { primary, extras: new Map() });
  }
}

/** Store rows for one of a chart's extra named datasets. Idempotent — calling
 *  again with the same name replaces the entry. Caller must call
 *  cacheChartRows first (so the primary entry exists). */
export function cacheChartExtra(chartId: string, name: string, rows: Record<string, any>[], columns: string[]): void {
  const entry = cache.get(chartId);
  if (!entry) {
    // No primary yet — create a placeholder so the extras don't get lost.
    // In practice the dispatcher always caches primary first; this is
    // defense in depth.
    cache.set(chartId, {
      primary: { rows: [], columns: [], fetchedAt: 0 },
      extras: new Map([[name, { rows, columns, fetchedAt: Date.now() }]]),
    });
    return;
  }
  entry.extras.set(name, { rows, columns, fetchedAt: Date.now() });
}

/** Read the most recent PRIMARY rows for a chartId, or null if never cached.
 *  Shape matches the v1 API. */
export function getChartRows(chartId: string): ChartDataset | null {
  return cache.get(chartId)?.primary ?? null;
}

/** Read the chart's extra datasets as a name → dataset map. Returns an empty
 *  Map for single-source charts (not null), so callers can iterate without a
 *  guard. */
export function getChartExtras(chartId: string): Map<string, ChartDataset> {
  return cache.get(chartId)?.extras ?? new Map();
}

/** Re-run the PRIMARY SQL via the canonical readRows helper and refresh the
 *  cache. Returns {rows, columns} on success or {error} on failure — the
 *  caller (the chart block) decides whether to swap the chart or surface the
 *  error banner. The previous cache entry is preserved on error so the chart
 *  stays visible. */
export async function refreshChartRows(
  chartId: string,
  sql: string,
): Promise<{ rows: Record<string, any>[]; columns: string[] } | { error: string }> {
  try {
    const rows = await readRows(sql);
    if (rows === null) return { error: "Query failed or DuckDB not ready" };
    const columns = rows.length ? Object.keys(rows[0]) : [];
    cacheChartRows(chartId, rows, columns);
    return { rows, columns };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Re-run an EXTRA dataset's SQL and refresh its cache entry. Same return
 *  shape as refreshChartRows. */
export async function refreshChartExtra(
  chartId: string,
  name: string,
  sql: string,
): Promise<{ rows: Record<string, any>[]; columns: string[] } | { error: string }> {
  try {
    const rows = await readRows(sql);
    if (rows === null) return { error: `Query failed or DuckDB not ready (dataset "${name}")` };
    const columns = rows.length ? Object.keys(rows[0]) : [];
    cacheChartExtra(chartId, name, rows, columns);
    return { rows, columns };
  } catch (e) {
    return { error: e instanceof Error ? e.message : `${String(e)} (dataset "${name}")` };
  }
}

/** Drop a chart's cached rows AND all its extras. Called when a chart block
 *  is permanently removed (not just unmounted by re-render). Today there's
 *  no UI to remove chart blocks; this is here for the forward path and for
 *  the pending-block-replaced flow in AskAIChat. */
export function evictChartRows(chartId: string): void {
  cache.delete(chartId);
}
