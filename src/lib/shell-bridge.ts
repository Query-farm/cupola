/**
 * Typed bridge for cross-component communication.
 * Replaces window.__* globals with a typed singleton.
 */
import type { Selection } from "./tree";

export interface QueryResult {
  ok: boolean;
  arrowBuffers?: ArrayBuffer[];
  error?: string;
}

export interface QueryHistoryEntry {
  id: number;
  timestamp: number;
  sql: string;
  executionTimeMs: number;
  success: boolean;
  rowCount?: number;
  error?: string;
  userQuestion?: string;
  conversationId?: string;
  conversationName?: string;
}

/** Create and record a query history entry. */
export function recordQuery(opts: {
  sql: string;
  executionTimeMs: number;
  success: boolean;
  rowCount?: number;
  error?: string;
  userQuestion?: string;
  conversationId?: string;
  conversationName?: string;
}): void {
  bridge.addQueryHistoryEntry?.({
    id: Date.now(),
    timestamp: Date.now(),
    ...opts,
  });
}

export const bridge = {
  // DuckDB query engine (set by DuckDBShell)
  query: null as ((sql: string) => Promise<QueryResult>) | null,
  querySync: null as ((sql: string) => Promise<QueryResult>) | null,
  cancelQuery: null as (() => void) | null,
  progress: null as ((pct: number) => void) | null,
  catalogName: null as string | null,
  worker: null as Worker | null,

  // Shell/terminal (set by DuckDBShell)
  shellTerm: null as any,
  shellFitAddon: null as any,
  shellReadline: null as any,
  runQuery: null as ((sql: string) => void) | null,
  insertText: null as ((text: string) => void) | null,
  inAiMode: false,
  activateShell: null as (() => void) | null,

  // Navigation/catalog (set by CatalogApp)
  memoryCatalog: null as any,
  refreshMemoryTables: null as (() => Promise<void>) | null,
  navigateToSelection: null as ((sel: Selection) => void) | null,

  // UI tabs (set by DuckDBShell)
  showPerspective: null as ((arrowBuf: ArrayBuffer) => void) | null,
  showKepler: null as (() => void) | null,
  addQueryHistoryEntry: null as ((entry: QueryHistoryEntry) => void) | null,
};

// Expose on window for Playwright/test access (survives HMR module replacement)
if (typeof window !== "undefined") (window as any).__bridge = bridge;
