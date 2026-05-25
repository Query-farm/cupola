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
  /** Resolves once `pending` hits zero AND no further query starts within
   *  the settle window. */
  settled: Promise<void>;
  resolveSettled: () => void;
}

let activeSession: RenderSession | null = null;

function startSession(): RenderSession {
  let resolveSettled: () => void = () => {};
  const settled = new Promise<void>((r) => { resolveSettled = r; });
  const s: RenderSession = { pending: 0, errors: [], settled, resolveSettled };
  activeSession = s;
  return s;
}

function endSession(s: RenderSession): void {
  if (activeSession === s) activeSession = null;
}

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
    if (session) session.pending++;
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
      // Capture errors that didn't come through r.ok (e.g. fetch failure).
      if (session && !session.errors.includes(e)) {
        session.errors.push(e instanceof Error ? e : new Error(String(e)));
      }
      throw e;
    } finally {
      if (session) {
        session.pending--;
        if (session.pending <= 0) {
          // Defer resolution one microtask so chained queries (a query that
          // queues another in its `then` handler) still hold the session open.
          queueMicrotask(() => {
            if (session.pending <= 0) session.resolveSettled();
          });
        }
      }
    }
  }
}

interface MosaicAPI {
  api: any;
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
    // temp + replace are both injected. The docs claim these default to true
    // but CreateQuery's JS defaults are both false, so a second render with
    // the same data name fails ("table already exists") or silently reuses
    // stale rows. User-provided values take precedence.
    if (typeof value === "string") {
      data[key] = { type: "table", query: value, temp: true, replace: true };
    } else if (Array.isArray(value)) {
      data[key] = value;
    } else if (value && typeof value === "object") {
      data[key] = { temp: true, replace: true, ...(value as object) };
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
  settleMs: number = 500,
): Promise<RenderResult> {
  const { api, parseSpec, astToDOM } = await getMosaicAPI();
  const session = startSession();
  try {
    const ast = parseSpec(normalizeSpec(spec));
    let element: HTMLElement;
    try {
      const out = await astToDOM(ast, { api });
      element = out.element;
    } catch (e: any) {
      // astToDOM's await covers data-load queries; if that throws, it's a
      // hard fail — there's no element to return.
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
      await waitForSessionSettle(session, settleMs);
    } finally {
      // Detach but leave the element intact so the caller can mount it.
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
 * Wait for the session to settle: pending hits zero AND no new queries
 * fire during the settle window. Resolves either way after settleMs even
 * if queries are still pending (so we don't hang on a runaway widget).
 */
async function waitForSessionSettle(session: RenderSession, settleMs: number): Promise<void> {
  // Race the session-settled signal against a fixed deadline. We also
  // need to handle the case where queries haven't even started yet — give
  // them a chance to register before the deadline.
  await new Promise<void>((resolve) => {
    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      resolve();
    };
    const timeout = setTimeout(done, settleMs);
    session.settled.then(() => {
      clearTimeout(timeout);
      // Short additional wait — a settled session can re-fire if a widget
      // schedules a follow-up query in a microtask. Give that one chance.
      setTimeout(done, 50);
    });
  });
}
