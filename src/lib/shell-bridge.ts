/**
 * Typed bridges for cross-component communication.
 *
 * This was one ~35-slot mutable object named `bridge`, mixing three unrelated
 * concerns: the DuckDB engine, the xterm terminal, and React-owned app-shell
 * callbacks. Every consumer imported the whole thing, so `format.ts` and the
 * sidebar had the same surface as the worker boot, and nothing in the type
 * system said which module was allowed to write which slot.
 *
 * It is now three objects grouped by owner:
 *
 *   engine   — set by duckdb-worker-boot; the query function, cancellation,
 *              boot progress, and the ATTACH barrier.
 *   terminal — set by shell-init; the xterm instance and its input surface.
 *   ui       — set by React (CatalogApp / DuckDBShell / SqlEditorView); the
 *              callbacks that let non-React code drive the app shell.
 *
 * The nullable slots and their `?.()` call guards remain deliberate: these are
 * genuinely late-bound (the worker boots asynchronously, React components mount
 * and unmount), and a null slot is the honest representation of "not ready
 * yet". `engine.attached` is the barrier for anything that needs the VGI
 * catalog rather than just a live connection.
 */
import type { Selection } from "./tree";
import type { CatalogData } from "./service";

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
  ui.addQueryHistoryEntry?.({
    id: Date.now(),
    timestamp: Date.now(),
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// engine — DuckDB execution and boot lifecycle (owner: duckdb-worker-boot)
// ---------------------------------------------------------------------------

export const engine = {
  /** Run SQL. Becomes callable at worker boot — well BEFORE the VGI catalog is
   *  attached, so anything needing the catalog must await `attached` too. */
  query: null as ((sql: string) => Promise<QueryResult>) | null,
  querySync: null as ((sql: string) => Promise<QueryResult>) | null,
  cancelQuery: null as (() => void) | null,
  progress: null as ((pct: number) => void) | null,
  catalogName: null as string | null,
  worker: null as Worker | null,

  /** Main-thread performance.now() when `new Worker(...)` was called, so
   *  ready-time logging is accurate whether the worker booted eagerly at
   *  CatalogApp mount or lazily at DuckDBShell mount. */
  workerCreateStart: 0 as number,
  workerReadyData: null as { wasmVersion: string; totalMs: number; timings: Array<{ phase: string; ms: number }> } | null,
  cancelInt32: null as Int32Array | null,

  /** Live boot state for the animated loading screen. `bootPhase` is the
   *  current human-readable step; `bootProgress` is 0-100 for the WASM
   *  instantiate phase only (other phases are indeterminate). */
  bootPhase: null as string | null,
  bootProgress: null as number | null,

  /** Sentry identity for the shell worker. Held here so duckdb-worker-boot can
   *  replay it on worker creation — the worker may boot before CatalogApp's
   *  setUser effect fires, or vice-versa. */
  sentryUser: null as { id?: string; email?: string; username?: string } | null,

  /** Resolves once the shell has run ATTACH + USE for the active VGI catalog.
   *  Consumers that depend on the catalog (column stats, data preview) must
   *  `await engine.attached` before issuing queries. Re-initialized by
   *  `resetAttached()` on a shell reconnect / catalog switch. */
  attached: null as Promise<void> | null,
  markAttached: null as (() => void) | null,
  resetAttached: null as (() => void) | null,
};

// ---------------------------------------------------------------------------
// terminal — the xterm surface (owner: shell-init)
// ---------------------------------------------------------------------------

export const terminal = {
  term: null as any,
  fitAddon: null as any,
  readline: null as any,
  /** Type SQL into the terminal and submit it. */
  runQuery: null as ((sql: string) => void) | null,
  /** Insert text at the terminal's cursor without submitting. */
  insertText: null as ((text: string) => void) | null,
  inAiMode: false,
  /** Bring the shell tab to the front. */
  activate: null as (() => void) | null,
};

// ---------------------------------------------------------------------------
// ui — app-shell callbacks React installs for non-React code (owner: React)
// ---------------------------------------------------------------------------

export const ui = {
  /** Open the SQL editor with the given SQL in a NEW tab, brought to the front.
   *  `autoRun` (default true) decides whether it also executes — shared query
   *  links stage the SQL without running it. */
  openInEditor: null as ((sql: string, opts?: { autoRun?: boolean }) => void) | null,
  /** Insert text at the cursor of the active editor tab. Set by SqlEditorView
   *  while the editor is mounted; used by the sidebar's click-to-insert. */
  insertIntoEditor: null as ((text: string) => void) | null,

  memoryCatalog: null as CatalogData | null,
  refreshMemoryTables: null as (() => Promise<void>) | null,
  onAttachedCatalogsChanged: null as (() => Promise<void>) | null,
  navigateToSelection: null as ((sel: Selection) => void) | null,

  showPerspective: null as ((arrowBuf: ArrayBuffer) => void) | null,
  /** Open the last shell result (Arrow IPC) in the Data Viewer tab. Invoked by
   *  the `.preview` dot-command. */
  showPreview: null as ((arrowBuf: ArrayBuffer) => void) | null,
  addQueryHistoryEntry: null as ((entry: QueryHistoryEntry) => void) | null,
};

// Initialize the attached Promise + control functions. Called at module load
// and whenever the shell needs to start a new attach cycle.
function initAttached() {
  engine.attached = new Promise<void>((resolve) => {
    engine.markAttached = () => resolve();
  });
}
engine.resetAttached = () => initAttached();
initAttached();

/** Update the worker's Sentry user identity. Caches the value on the engine
 *  bridge so a later worker boot can pick it up, and forwards it to the worker
 *  now if one is already running. Pass null to clear (e.g. after sign-out). */
export function setShellWorkerSentryUser(
  user: { id?: string; email?: string; username?: string } | null,
): void {
  engine.sentryUser = user;
  if (engine.worker) {
    engine.worker.postMessage({ type: "set-sentry-user", user });
  }
}

/** Subscribe to `engine.query` availability changes. Fires when it is set or cleared. */
const queryListeners = new Set<() => void>();
export function onQueryChange(cb: () => void): () => void {
  queryListeners.add(cb);
  return () => { queryListeners.delete(cb); };
}
export function notifyQueryChange(): void {
  for (const cb of queryListeners) cb();
}

/** Subscribe to boot phase/progress changes. The loading screen uses this to
 *  re-render as duckdb-worker-boot and DuckDBShell announce new phases.
 *  Callers pull the current values off `engine` after each fire. */
const bootListeners = new Set<() => void>();
export function onBootChange(cb: () => void): () => void {
  bootListeners.add(cb);
  return () => { bootListeners.delete(cb); };
}
export function setBootPhase(phase: string | null, progress: number | null = null): void {
  engine.bootPhase = phase;
  engine.bootProgress = progress;
  for (const cb of bootListeners) cb();
}

// ---------------------------------------------------------------------------
// window.__bridge — test handle only
// ---------------------------------------------------------------------------

// Exposed for Playwright: the e2e specs drive the app through this (running
// SQL, seeding query history, checking the terminal survived a tab switch).
//
// Deliberately kept FLAT even though the module API is now grouped. It is a
// test API, not the internal one, and nine spec files address it by the old
// names — so the shape is pinned here rather than spread across those files.
// Getters delegate, so the handle always reflects live state.
if (typeof window !== "undefined") {
  (window as any).__bridge = {
    get query() { return engine.query; },
    get querySync() { return engine.querySync; },
    get cancelQuery() { return engine.cancelQuery; },
    get catalogName() { return engine.catalogName; },
    get worker() { return engine.worker; },
    get bootPhase() { return engine.bootPhase; },
    get attached() { return engine.attached; },
    get shellTerm() { return terminal.term; },
    get shellFitAddon() { return terminal.fitAddon; },
    get runQuery() { return terminal.runQuery; },
    get insertText() { return terminal.insertText; },
    get memoryCatalog() { return ui.memoryCatalog; },
    get refreshMemoryTables() { return ui.refreshMemoryTables; },
    get showPerspective() { return ui.showPerspective; },
    get showPreview() { return ui.showPreview; },
    get addQueryHistoryEntry() { return ui.addQueryHistoryEntry; },
  };
}
