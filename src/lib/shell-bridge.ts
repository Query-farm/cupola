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

  // Set by the eager worker boot (duckdb-worker-boot.ts). workerCreateStart is
  // the main-thread performance.now() at the moment `new Worker(...)` was called,
  // so ready-time logging stays accurate whether the worker was booted eagerly
  // at CatalogApp mount or lazily at DuckDBShell mount. workerReadyData holds
  // the payload of the 'ready' message; DuckDBShell checks this at mount and
  // runs its post-ready flow directly if the worker already finished init.
  workerCreateStart: 0 as number,
  workerReadyData: null as { wasmVersion: string; totalMs: number; timings: Array<{ phase: string; ms: number }> } | null,
  cancelInt32: null as Int32Array | null,

  // Live boot state for the animated loading screen. `bootPhase` is the
  // current human-readable step (e.g. "Downloading DuckDB", "Loading vgi
  // extension"); `bootProgress` is 0-100 for the WASM instantiate phase
  // only (other phases are indeterminate). Updated by duckdb-worker-boot
  // and DuckDBShell as they progress; subscribed by the loading panel.
  bootPhase: null as string | null,
  bootProgress: null as number | null,

  // Shell/terminal (set by DuckDBShell)
  shellTerm: null as any,
  shellFitAddon: null as any,
  shellReadline: null as any,
  runQuery: null as ((sql: string) => void) | null,
  insertText: null as ((text: string) => void) | null,
  inAiMode: false,
  activateShell: null as (() => void) | null,

  // Open the SQL editor surface with the given SQL in a new tab (and run it).
  // Set by CatalogApp; invoked by ExampleQueries and the shell's Query History
  // "Open in editor" action. Always opens a new tab and brings it to the front;
  // `autoRun` (default true) decides whether it also executes. Shared query
  // links stage the SQL without running it.
  openInEditor: null as ((sql: string, opts?: { autoRun?: boolean }) => void) | null,
  // Insert text at the cursor of the active editor tab. Set by SqlEditorView
  // while the editor surface is mounted; used by the sidebar's click-to-insert.
  insertIntoEditor: null as ((text: string) => void) | null,

  // Navigation/catalog (set by CatalogApp)
  memoryCatalog: null as any,
  refreshMemoryTables: null as (() => Promise<void>) | null,
  onAttachedCatalogsChanged: null as (() => Promise<void>) | null,
  navigateToSelection: null as ((sel: Selection) => void) | null,

  // UI tabs (set by DuckDBShell)
  showPerspective: null as ((arrowBuf: ArrayBuffer) => void) | null,
  // Open the last shell query result (Arrow IPC buffer) in the Data Preview
  // tab. Set by DuckDBShell, invoked by the `.preview` dot-command.
  showPreview: null as ((arrowBuf: Uint8Array) => void) | null,
  addQueryHistoryEntry: null as ((entry: QueryHistoryEntry) => void) | null,

  // Sentry identity for the shell worker. Stored here so duckdb-worker-boot
  // can replay it on worker creation (worker may boot before CatalogApp's
  // setUser effect fires, or vice-versa).
  sentryUser: null as { id?: string; email?: string; username?: string } | null,

  // Resolves once the shell has run ATTACH + USE for the active VGI catalog.
  // Consumers that depend on the VGI catalog being attached (column stats,
  // data preview) must `await bridge.attached` before issuing queries — the
  // raw `bridge.query` becomes callable at worker boot, well before ATTACH.
  // Re-initialized by resetAttached() on a shell reconnect / catalog switch.
  attached: null as Promise<void> | null,
  markAttached: null as (() => void) | null,
  resetAttached: null as (() => void) | null,
};

// Initialize the attached Promise + control functions. Called at module load
// and whenever the shell needs to start a new attach cycle.
function initAttached() {
  bridge.attached = new Promise<void>((resolve) => {
    bridge.markAttached = () => resolve();
  });
}
bridge.resetAttached = () => initAttached();
initAttached();

/** Update the worker's Sentry user identity. Caches the value on the bridge
 *  so a later worker boot can pick it up, and forwards it to the worker now
 *  if one is already running. Pass null to clear (e.g. after sign-out). */
export function setShellWorkerSentryUser(
  user: { id?: string; email?: string; username?: string } | null,
): void {
  bridge.sentryUser = user;
  if (bridge.worker) {
    bridge.worker.postMessage({ type: "set-sentry-user", user });
  }
}

/** Subscribe to bridge.query availability changes. Fires when query is set or cleared. */
const queryListeners = new Set<() => void>();
export function onQueryChange(cb: () => void): () => void {
  queryListeners.add(cb);
  return () => { queryListeners.delete(cb); };
}
export function notifyQueryChange(): void {
  for (const cb of queryListeners) cb();
}

/** Subscribe to boot phase/progress changes. The loading screen uses this
 *  to re-render when duckdb-worker-boot and DuckDBShell announce new
 *  phases. Callers should pull the current values off `bridge` directly
 *  after each fire. */
const bootListeners = new Set<() => void>();
export function onBootChange(cb: () => void): () => void {
  bootListeners.add(cb);
  return () => { bootListeners.delete(cb); };
}
export function setBootPhase(phase: string | null, progress: number | null = null): void {
  bridge.bootPhase = phase;
  bridge.bootProgress = progress;
  for (const cb of bootListeners) cb();
}

// Expose on window for Playwright/test access (survives HMR module replacement)
if (typeof window !== "undefined") (window as any).__bridge = bridge;
