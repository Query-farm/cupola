/**
 * Session-scoped row cache for the AI chart tool.
 *
 * Keyed by chartId (a per-block uuid issued when render_chart runs). The
 * VegaChartBlock component reads rows from here on mount; the refresh button
 * re-runs the chart's SQL and replaces the entry.
 *
 * Deliberately separate from src/lib/query-results.ts:
 *  - query-results.ts has a 3-entry LRU for the AI's `read_query_results`
 *    paging tool — polluting it with chart rows would evict pagination data.
 *  - Charts can stick around for the whole conversation; LRU eviction is
 *    explicit via evictChartRows() when a block is unmounted permanently.
 *
 * No persistence: rows live in memory for the session only. If conversation
 * persistence is added, persist {sql, spec, title} and rehydrate via
 * refreshChartRows() — never serialize the rows themselves.
 */
import { readRows } from "./duckdb-query";

interface ChartCacheEntry {
  rows: Record<string, any>[];
  columns: string[];
  fetchedAt: number;
}

const cache = new Map<string, ChartCacheEntry>();

/** Store rows for a chartId. Called by the tool dispatcher right after the
 *  initial SELECT, and again on every refresh. */
export function cacheChartRows(chartId: string, rows: Record<string, any>[], columns: string[]): void {
  cache.set(chartId, { rows, columns, fetchedAt: Date.now() });
}

/** Read the most recent rows for a chartId, or null if never cached. */
export function getChartRows(chartId: string): ChartCacheEntry | null {
  return cache.get(chartId) ?? null;
}

/** Re-run the chart's SQL via the canonical readRows helper and refresh the
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

/** Drop a chart's cached rows. Called when a chart block is permanently
 *  removed (not just unmounted by re-render). Today there's no UI to remove
 *  chart blocks; this is here for the forward path. */
export function evictChartRows(chartId: string): void {
  cache.delete(chartId);
}
