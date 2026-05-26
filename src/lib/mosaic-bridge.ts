/* ── Mosaic ↔ haybarn-wasm bridge ──
 *
 * Per-render Mosaic Coordinator + Connector wired to our existing
 * DuckDB-WASM worker via `bridge.query`. Each `renderChartSpec` call
 * creates a fresh Coordinator + connector + API context, isolated from
 * every other render. Two charts in the chat have ZERO shared state.
 *
 * Why per-render and not a singleton:
 *   - Mosaic's Coordinator caches MosaicClient query results by SQL
 *     signature. A singleton shared between charts means chart 2 hits
 *     chart 1's cached SELECT — wrong data renders.
 *   - `coordinator.clear({ clients: true })` (the previous workaround)
 *     disconnects ALL mounted clients from the singleton, including
 *     clients of charts still visible in the chat. After 3-5 charts the
 *     accumulated zombie state breaks every new render.
 *   - With one Coordinator per render: each chart is fully isolated.
 *     Disconnecting one chart's clients on unmount doesn't touch any
 *     other. The cache is naturally per-chart (so no cross-chart
 *     contamination), and live cross-filtering between marks WITHIN a
 *     single spec still works (they share that render's Coordinator).
 *
 * Lazy by design: the Mosaic + Plot + D3 modules dynamic-import on first
 * call to `renderChartSpec` / `parseChartSpec`. Until then they stay out
 * of the main bundle.
 */
import type { Connector, ConnectorQueryRequest } from "@uwdata/mosaic-core";
import { tableFromIPC } from "@uwdata/flechette";
import { bridge } from "./shell-bridge";

interface RenderSession {
  pending: number;
  errors: Error[];
  /** Wall-clock of last activity (query start/end). Used by the
   *  quiet-period settle algorithm. */
  lastActivityAt: number;
}

function newSession(): RenderSession {
  return { pending: 0, errors: [], lastActivityAt: performance.now() };
}

function touchSession(s: RenderSession) { s.lastActivityAt = performance.now(); }

/**
 * Adapter from Mosaic's Connector interface to our shell bridge.
 *
 * Each instance owns its own session bag — there are no module-level
 * globals to race on. Concurrent renders each have their own connector,
 * so query lifecycle / error capture / settle waits never cross-talk.
 */
class HaybarnConnector implements Connector {
  readonly session: RenderSession;

  constructor() {
    this.session = newSession();
  }

  async query(req: ConnectorQueryRequest): Promise<any> {
    if (!bridge.query) {
      throw new Error("DuckDB shell not initialized — open the SQL Shell tab first");
    }
    this.session.pending++;
    touchSession(this.session);
    try {
      const r = await bridge.query(req.sql);
      if (!r.ok) {
        const err = new Error(r.error || "Query failed");
        this.session.errors.push(err);
        throw err;
      }
      if (req.type === "exec") return undefined;

      const buf = r.arrowBuffers?.[0];
      if (!buf) return req.type === "json" ? [] : null;
      const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
      const table = tableFromIPC(bytes, { useDate: true });
      return req.type === "json" ? table.toArray() : table;
    } catch (e: any) {
      if (!this.session.errors.includes(e)) {
        this.session.errors.push(e instanceof Error ? e : new Error(String(e)));
      }
      throw e;
    } finally {
      this.session.pending--;
      touchSession(this.session);
    }
  }
}

interface MosaicModules {
  Coordinator: any;
  createAPIContext: any;
  parseSpec: any;
  astToDOM: any;
}

let _modules: MosaicModules | null = null;
let _loadPromise: Promise<MosaicModules> | null = null;

/**
 * Lazy-load the Mosaic ecosystem (mosaic-core, vgplot, mosaic-spec).
 * Resolves to the constructors and free functions we need. Cached after
 * the first call — the ~500KB chunk only downloads once per page-load.
 */
async function getMosaicModules(): Promise<MosaicModules> {
  if (_modules) return _modules;
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    const [core, vg, spec] = await Promise.all([
      import("@uwdata/mosaic-core"),
      import("@uwdata/vgplot"),
      import("@uwdata/mosaic-spec"),
    ]);
    _modules = {
      Coordinator: (core as any).Coordinator,
      createAPIContext: (vg as any).createAPIContext,
      parseSpec: (spec as any).parseSpec,
      astToDOM: (spec as any).astToDOM,
    };
    return _modules;
  })();
  return _loadPromise;
}

/**
 * Coerce all `data` entries in a Mosaic spec into a writable form. Three
 * input forms collapse to the table/json branches:
 *
 *   1. Bare string                  → { type: "table", query: <sql>, temp+replace }
 *   2. Bare array                   → { type: "json", data: [...], temp+replace }
 *   3. Object with file/query/url   → ...spread + temp+replace
 *   4. Object with data: [...]      → { type: "json", ...spread, temp+replace }
 *
 * `temp+replace` are injected because our DuckDB session's default catalog
 * is often the read-only attached VGI catalog — without temp the CREATE
 * fails with CatalogReadOnlyError; without replace, a second render of the
 * same data name fails ("already exists"). User-set values win.
 */
function injectTempData(spec: any): any {
  if (!spec || typeof spec !== "object") return spec;
  const out: any = { ...spec };
  if (!out.data || typeof out.data !== "object") return out;
  const data: Record<string, any> = {};
  for (const [key, value] of Object.entries(out.data)) {
    if (typeof value === "string") {
      data[key] = { type: "table", query: value, temp: true, replace: true };
    } else if (Array.isArray(value)) {
      data[key] = { type: "json", data: value, temp: true, replace: true };
    } else if (value && typeof value === "object") {
      const v = value as Record<string, any>;
      const isInlineLiteral = Array.isArray(v.data) && !v.query && !v.file && !v.url;
      if (isInlineLiteral) {
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
 * Strip Mosaic-parser-incompatible top-level keys. `$schema` is
 * documented but parseSpec rejects it (it leaks into `...root` and fails
 * attribute validation).
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
  const { parseSpec } = await getMosaicModules();
  return parseSpec(normalizeSpec(spec));
}

export interface RenderResult {
  element: HTMLElement;
  /** Errors that fired during query execution while rendering. Empty array on success. */
  errors: Error[];
}

/**
 * Parse + render a spec into a live DOM element wired to a *fresh*
 * per-render Coordinator. Waits for all connector queries (initial
 * data-loads + plot-widget chart SELECTs that fire async after astToDOM)
 * to settle. Returns `{ element, errors[] }`.
 *
 * Each call is fully isolated: a new Coordinator + new HaybarnConnector
 * + new session bag. Two simultaneous renders never cross-talk; charts
 * already mounted in the chat are never disturbed.
 */
export async function renderChartSpec(
  spec: any,
  options: { quietMs?: number; maxMs?: number } = {},
): Promise<RenderResult> {
  const { quietMs = 250, maxMs = 3000 } = options;
  const { Coordinator, createAPIContext, parseSpec, astToDOM } = await getMosaicModules();

  // Per-render Coordinator + Connector. The HaybarnConnector instance
  // carries the session bag — no module-level state to race on.
  //
  // preagg.enabled=false: Mosaic's PreAggregator builds materialized views
  // in a schema named "mosaic" for fast cross-filtering. Its default code
  // path is `CREATE SCHEMA "mosaic"; CREATE TABLE "mosaic"."preagg_<hash>" …`
  // followed by SELECTs against that table. In our session the default
  // catalog after `ATTACH '…' AS X (TYPE VGI); USE X.schema;` is the
  // VGI-attached read-only catalog, so the CREATE SCHEMA fails. The
  // PreAggregator just `.catch()`-logs and moves on — but then the SELECT
  // surfaces "schema mosaic does not exist" to the user. Disabling preagg
  // takes the materialized-view fast path off the table; cross-filtering
  // still works (Mosaic falls back to running the client's own SELECT on
  // every filter change), which is fine for typical exploration sizes.
  const connector = new HaybarnConnector();
  const coordinator = new Coordinator(connector, { preagg: { enabled: false } });
  const api = createAPIContext({ coordinator });

  // Capture unhandled promise rejections that fire during THIS render.
  // We can't tag them by render, so we capture any unhandledrejection
  // while the listener is installed. Risk: an unrelated rejection from
  // outside Mosaic gets attributed to this render. Acceptable trade-off
  // — these are real errors the user wants to see, and Mosaic's plot
  // mounts are the most common source of async throws during chart loads.
  const onRej = (e: PromiseRejectionEvent) => {
    const reason = e.reason;
    connector.session.errors.push(reason instanceof Error ? reason : new Error(String(reason)));
    e.preventDefault();
  };
  window.addEventListener("unhandledrejection", onRej);

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
    // and fire their chart-data queries. Detach after settling — caller
    // mounts the element wherever they want.
    const hidden = document.createElement("div");
    hidden.style.position = "absolute";
    hidden.style.left = "-99999px";
    hidden.style.top = "0";
    hidden.style.width = "640px";
    hidden.style.height = "480px";
    document.body.appendChild(hidden);
    hidden.appendChild(element);

    try {
      await waitForSessionSettle(connector.session, quietMs, maxMs);
    } finally {
      hidden.removeChild(element);
      hidden.remove();
    }

    return { element, errors: [...connector.session.errors] };
  } finally {
    window.removeEventListener("unhandledrejection", onRej);
  }
}

/**
 * Wait for the connector's session to quiesce: pending=0 AND no new
 * query has fired for `quietMs`. Capped at `maxMs` so we never hang.
 *
 * MosaicClients fire their chart-data queries asynchronously *after*
 * astToDOM resolves (during client registration / widget mount), so a
 * naive "wait until pending=0 once" returns too early. The quiet-period
 * algorithm catches those late queries by waiting for an activity gap.
 */
async function waitForSessionSettle(
  session: RenderSession,
  quietMs: number,
  maxMs: number,
): Promise<void> {
  const deadline = performance.now() + maxMs;
  touchSession(session);  // give widgets at least `quietMs` to register
  while (true) {
    const now = performance.now();
    if (now >= deadline) return;
    const sinceActivity = now - session.lastActivityAt;
    if (session.pending === 0 && sinceActivity >= quietMs) return;
    const wait = Math.min(50, Math.max(10, quietMs - sinceActivity));
    await new Promise((r) => setTimeout(r, wait));
  }
}
