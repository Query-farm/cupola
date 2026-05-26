/* ── Mosaic ↔ haybarn-wasm bridge ──
 *
 * Singleton Mosaic Coordinator + Connector that delegates query execution
 * to our existing DuckDB-WASM worker via `bridge.query`. Every Mosaic plot
 * shares this Coordinator, so specs running in the same conversation see
 * a consistent database state.
 *
 * Lazy by design: `renderChartSpec()` and `parseChartSpec()` are the entry
 * points and dynamically import @uwdata/mosaic-{core,spec} + @uwdata/vgplot
 * on first call. Until then, Mosaic + Observable Plot + D3 stay out of the
 * main bundle.
 *
 * Error capture: `astToDOM` only awaits the initial data-load queries
 * (CREATE TEMP TABLE for each `data` definition). The actual chart SELECTs
 * fire asynchronously after the plot widget mounts and its MosaicClients
 * register. To surface those as render failures the AI / editor can act
 * on, we route every connector query through a per-render "session" that
 * tracks pending queries + collected errors, and `renderChartSpec` waits
 * for the session to settle before resolving.
 */
import type { Connector, ConnectorQueryRequest } from "@uwdata/mosaic-core";
import { tableFromIPC } from "@uwdata/flechette";
import { bridge } from "./shell-bridge";

interface RenderSession {
  pending: number;
  errors: Error[];
  /** Wall-clock time of the most recent query completion (or session start).
   *  Used by the quiet-period settle algorithm: we consider the render
   *  "settled" when no query has fired for `quietMs`. */
  lastActivityAt: number;
}

let activeSession: RenderSession | null = null;
let unhandledRejectionHandler: ((e: PromiseRejectionEvent) => void) | null = null;

function startSession(): RenderSession {
  const s: RenderSession = {
    pending: 0,
    errors: [],
    lastActivityAt: performance.now(),
  };
  activeSession = s;
  // Capture unhandled promise rejections during this render — Mosaic and
  // Observable Plot can throw inside async chart-render code paths that
  // aren't connected to any await we control. Hook the global event so
  // those errors flow into the session bag too.
  unhandledRejectionHandler = (e: PromiseRejectionEvent) => {
    const reason = e.reason;
    const err = reason instanceof Error ? reason : new Error(String(reason));
    // Don't swallow — but suppress the console noise by preventing default.
    s.errors.push(err);
    e.preventDefault();
  };
  window.addEventListener("unhandledrejection", unhandledRejectionHandler);
  return s;
}

function endSession(s: RenderSession): void {
  if (activeSession === s) activeSession = null;
  if (unhandledRejectionHandler) {
    window.removeEventListener("unhandledrejection", unhandledRejectionHandler);
    unhandledRejectionHandler = null;
  }
}

function touchSession(s: RenderSession) { s.lastActivityAt = performance.now(); }

/**
 * Adapter from Mosaic's Connector interface to our shell bridge.
 *
 * Reports query lifecycle to the active render session so the renderer
 * can wait for all queries (including async ones from MosaicClients
 * after astToDOM returns) and surface any errors that fire during them.
 */
class HaybarnConnector implements Connector {
  async query(req: ConnectorQueryRequest): Promise<any> {
    if (!bridge.query) {
      throw new Error("DuckDB shell not initialized — open the SQL Shell tab first");
    }
    const session = activeSession;
    if (session) { session.pending++; touchSession(session); }
    try {
      const r = await bridge.query(req.sql);
      if (!r.ok) {
        const err = new Error(r.error || "Query failed");
        if (session) session.errors.push(err);
        throw err;
      }
      if (req.type === "exec") return undefined;

      const buf = r.arrowBuffers?.[0];
      if (!buf) {
        return req.type === "json" ? [] : null;
      }
      const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
      const table = tableFromIPC(bytes, { useDate: true });
      return req.type === "json" ? table.toArray() : table;
    } catch (e: any) {
      if (session && !session.errors.includes(e)) {
        session.errors.push(e instanceof Error ? e : new Error(String(e)));
      }
      throw e;
    } finally {
      if (session) { session.pending--; touchSession(session); }
    }
  }
}

interface MosaicAPI {
  api: any;
  coordinator: any;
  parseSpec: (spec: any) => any;
  astToDOM: (ast: any, opts: any) => Promise<{ element: HTMLElement; coordinator: any }>;
}

let _api: MosaicAPI | null = null;
let _loadPromise: Promise<MosaicAPI> | null = null;

/**
 * Lazy-load Mosaic + return its API surface (created once).
 */
export async function getMosaicAPI(): Promise<MosaicAPI> {
  if (_api) return _api;
  if (_loadPromise) return _loadPromise;

  _loadPromise = (async () => {
    const [{ Coordinator }, vg, spec] = await Promise.all([
      import("@uwdata/mosaic-core"),
      import("@uwdata/vgplot"),
      import("@uwdata/mosaic-spec"),
    ]);
    const coordinator = new (Coordinator as any)();
    coordinator.databaseConnector(new HaybarnConnector());
    const api = (vg as any).createAPIContext({ coordinator });
    _api = {
      api,
      coordinator,
      parseSpec: (spec as any).parseSpec,
      astToDOM: (spec as any).astToDOM,
    };
    return _api;
  })();

  return _loadPromise;
}

/**
 * Coerce all `data` entries in a Mosaic spec into the object form with
 * `temp: true` injected. Required because our DuckDB session's default
 * catalog is often the read-only attached VGI catalog. Forcing TEMP
 * routes CREATE TABLEs into DuckDB's writable session-local `temp.main`.
 * User-set `temp` takes precedence.
 */
function injectTempData(spec: any): any {
  if (!spec || typeof spec !== "object") return spec;
  const out: any = { ...spec };
  if (!out.data || typeof out.data !== "object") return out;
  const data: Record<string, any> = {};
  for (const [key, value] of Object.entries(out.data)) {
    // Three input forms we handle:
    //   1. Bare string                       → table from query (inject temp+replace)
    //   2. Bare array                        → JSON inline literal (leave alone)
    //   3. Object with file/query/url        → table-y forms (inject temp+replace)
    //   4. Object with data: [...]           → JSON inline literal (leave alone,
    //                                          but ensure type:"json" so the
    //                                          parser doesn't guess "table")
    //   5. Anything else                     → pass through unchanged
    //
    // (3) is where temp+replace matter: without them, a second render with
    // the same data name fails ("already exists") or silently reuses stale
    // rows. User-provided temp/replace win.
    // All these forms call CREATE TABLE under the hood (string → table from
    // query; array → JSON literal; object with file/url/data → file/JSON
    // loader). We inject temp+replace into every one so the table lands in
    // the writable temp schema and survives re-renders. The bare-array form
    // is special: the parser converts it to { type:"json", data:[...] } in
    // resolveDataSpec, but only AFTER it sees an array. We pre-convert to
    // give it the option-bag form so our temp/replace flags stick.
    if (typeof value === "string") {
      data[key] = { type: "table", query: value, temp: true, replace: true };
    } else if (Array.isArray(value)) {
      data[key] = { type: "json", data: value, temp: true, replace: true };
    } else if (value && typeof value === "object") {
      const v = value as Record<string, any>;
      const isInlineLiteral = Array.isArray(v.data) && !v.query && !v.file && !v.url;
      if (isInlineLiteral) {
        // Wrapped inline JSON literal — ensure type:"json" so the parser
        // doesn't default to "table" (which would silently no-op).
        data[key] = { temp: true, replace: true, type: "json", ...v };
      } else if (v.query || v.file || v.url) {
        data[key] = { temp: true, replace: true, ...v };
      } else {
        data[key] = v;
      }
    } else {
      data[key] = value;
    }
  }
  out.data = data;
  return out;
}

/**
 * Strip Mosaic-parser-incompatible top-level keys. `$schema` is documented
 * but not actually accepted by parseSpec (it leaks into `...root` and
 * fails attribute validation).
 */
function stripUnsupportedKeys(spec: any): any {
  if (!spec || typeof spec !== "object") return spec;
  const out: any = { ...spec };
  delete out["$schema"];
  return out;
}

function normalizeSpec(spec: any): any {
  return injectTempData(stripUnsupportedKeys(spec));
}

/**
 * Parse a JSON spec into an AST. Sync after Mosaic is loaded. Catches
 * spec-shape errors (unknown marks, bad attribute names, missing required
 * fields) but NOT runtime data errors — for those, use renderChartSpec.
 */
export async function parseChartSpec(spec: any): Promise<any> {
  const { parseSpec } = await getMosaicAPI();
  return parseSpec(normalizeSpec(spec));
}

export interface RenderResult {
  element: HTMLElement;
  /** Errors that fired during query execution while rendering. Empty array on success. */
  errors: Error[];
}

/**
 * Parse + render a spec, waiting for all connector queries (both the
 * initial data-loads and the plot widgets' chart-data SELECTs) to settle.
 * The returned RenderResult always includes the rendered element AND any
 * errors collected during the render. Callers decide whether to surface
 * the element, the errors, or both.
 *
 * Errors during the initial data-load phase throw synchronously (parse +
 * coordinator.exec failures). Errors from async chart-data SELECTs are
 * captured in result.errors after the plot widget settles.
 *
 * @param spec The Mosaic spec object.
 * @param settleMs How long to wait for queries to fire after astToDOM
 *   resolves. Default 500ms — generous enough for the plot widget's
 *   initial SELECT batch to register, tight enough not to stall the AI loop.
 */
export async function renderChartSpec(
  spec: any,
  options: { quietMs?: number; maxMs?: number } = {},
): Promise<RenderResult> {
  const { quietMs = 250, maxMs = 3000 } = options;
  const { api, coordinator, parseSpec, astToDOM } = await getMosaicAPI();
  // Reset the Coordinator between renders. Without this, MosaicClient
  // query results get cached by SQL signature; two charts with the same
  // data name + same plot shape would have the second see the first's
  // cached data. `clear({ clients: true, cache: true })` disconnects all
  // prior clients and drops the cache so each render starts fresh.
  //
  // This replaces an earlier hack that suffixed data names with a random
  // UID — that broke SQL-string references like
  //   `{ sql: "FROM hierarchy h1" }`
  // because the walker couldn't see into SQL text to rewrite the name.
  try { coordinator.clear({ clients: true, cache: true }); } catch {}
  const session = startSession();
  try {
    const ast = parseSpec(normalizeSpec(spec));
    let element: HTMLElement;
    try {
      const out = await astToDOM(ast, { api });
      element = out.element;
    } catch (e: any) {
      throw e instanceof Error ? e : new Error(String(e));
    }

    // Attach to a hidden node so the plot widgets' MosaicClients register
    // and fire their chart-data queries. We detach after settling.
    const hidden = document.createElement("div");
    hidden.style.position = "absolute";
    hidden.style.left = "-99999px";
    hidden.style.top = "0";
    hidden.style.width = "640px";
    hidden.style.height = "480px";
    document.body.appendChild(hidden);
    hidden.appendChild(element);

    try {
      await waitForSessionSettle(session, quietMs, maxMs);
    } finally {
      hidden.removeChild(element);
      hidden.remove();
    }

    return { element, errors: [...session.errors] };
  } finally {
    endSession(session);
  }
}

/**
 * Convenience wrapper for callers that just want the rendered element and
 * are happy to ignore async query errors (e.g. the chat block, which
 * displays its own error state if anything goes wrong on remount).
 */
export async function renderChartSpecOrThrow(spec: any): Promise<HTMLElement> {
  const result = await renderChartSpec(spec);
  if (result.errors.length > 0) {
    // Surface only the first error for brevity; the message usually
    // contains enough signal for the AI to correct the spec.
    throw result.errors[0];
  }
  return result.element;
}

/**
 * Wait for the session to settle using a quiet-period algorithm. We
 * resolve only when:
 *   - `pending` has been zero for at least `quietMs`, AND
 *   - the last query completed at least `quietMs` ago.
 *
 * The plot widget's MosaicClients fire queries asynchronously *after*
 * astToDOM resolves (during widget mount / client registration), so a
 * naive "wait until pending hits zero once" returns too early. The
 * quiet-period algorithm catches these late queries by waiting for an
 * activity gap.
 *
 * Capped at `maxMs` so we never hang indefinitely on a runaway widget.
 */
async function waitForSessionSettle(
  session: RenderSession,
  quietMs: number = 250,
  maxMs: number = 3000,
): Promise<void> {
  const deadline = performance.now() + maxMs;
  // Always wait at least `quietMs` from the time we entered the wait —
  // this gives chart widgets a moment to register their MosaicClients
  // and fire their first query, in case astToDOM completed before any
  // client query started.
  touchSession(session);
  while (true) {
    const now = performance.now();
    if (now >= deadline) return;
    const sinceActivity = now - session.lastActivityAt;
    if (session.pending === 0 && sinceActivity >= quietMs) return;
    // Sleep a small slice and re-check.
    const wait = Math.min(50, Math.max(10, quietMs - sinceActivity));
    await new Promise((r) => setTimeout(r, wait));
  }
}
