/* ── Mosaic ↔ haybarn-wasm bridge ──
 *
 * Singleton Mosaic Coordinator + Connector that delegates query execution
 * to our existing DuckDB-WASM worker via `bridge.query`. Every Mosaic plot
 * (currently: the chat's MosaicChartBlock) shares this Coordinator, so
 * specs running in the same conversation see a consistent database state.
 *
 * Lazy by design: `renderChartSpec()` and `parseChartSpec()` are the entry
 * points and dynamically import @uwdata/mosaic-{core,spec} + @uwdata/vgplot
 * on first call. Until then, Mosaic + Observable Plot + D3 stay out of the
 * main bundle.
 */
import type { Connector, ConnectorQueryRequest } from "@uwdata/mosaic-core";
import { tableFromIPC } from "@uwdata/flechette";
import { bridge } from "./shell-bridge";

/**
 * Adapter from Mosaic's Connector interface to our shell bridge.
 * `bridge.query(sql)` returns Arrow IPC `ArrayBuffer`s — we decode with
 * flechette (Mosaic's Arrow flavor) and return the result shape the
 * Connector contract requires for each query type.
 */
class HaybarnConnector implements Connector {
  async query(req: ConnectorQueryRequest): Promise<any> {
    if (!bridge.query) {
      throw new Error("DuckDB shell not initialized — open the SQL Shell tab first");
    }
    const r = await bridge.query(req.sql);
    if (!r.ok) {
      throw new Error(r.error || "Query failed");
    }
    if (req.type === "exec") return undefined;

    const buf = r.arrowBuffers?.[0];
    if (!buf) {
      // No result body. Return empty shape matching the requested type.
      return req.type === "json" ? [] : null;
    }
    const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
    const table = tableFromIPC(bytes, { useDate: true });
    return req.type === "json" ? table.toArray() : table;
  }
}

interface MosaicAPI {
  api: any;                              // the vgplot APIContext (with coordinator wired)
  parseSpec: (spec: any) => any;          // mosaic-spec.parseSpec → AST
  astToDOM: (ast: any, opts: any) => Promise<{ element: HTMLElement; coordinator: any }>;
}

let _api: MosaicAPI | null = null;
let _loadPromise: Promise<MosaicAPI> | null = null;

/**
 * Lazy-load Mosaic + return its API surface (created once). The first call
 * pulls in @uwdata/mosaic-core, @uwdata/mosaic-spec, @uwdata/vgplot,
 * Observable Plot, and D3 — ~500KB-uncompressed chunk. Subsequent calls
 * return the cached context immediately.
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
 * `temp: true` injected. This is required because our DuckDB session's
 * default catalog is whatever the user navigated to in the sidebar — often
 * a read-only attached VGI catalog. Without `temp: true`, Mosaic emits
 * `CREATE TABLE counts AS ...` which fails with `CatalogReadOnlyError`.
 * Forcing TEMP routes the CREATE into DuckDB's session-local `temp.main`
 * which is always writable, and the bare table names still resolve from
 * subsequent SELECTs via DuckDB's standard name resolution.
 *
 * User-set `temp` takes precedence (so a future spec can override if it
 * really wants a persistent table somewhere writable).
 */
function injectTempData(spec: any): any {
  if (!spec || typeof spec !== "object" || !spec.data || typeof spec.data !== "object") {
    return spec;
  }
  const data: Record<string, any> = {};
  for (const [key, value] of Object.entries(spec.data)) {
    if (typeof value === "string") {
      data[key] = { type: "table", query: value, temp: true };
    } else if (Array.isArray(value)) {
      // Inline array stays as-is (handled by JSON literal data format).
      data[key] = value;
    } else if (value && typeof value === "object") {
      data[key] = { temp: true, ...(value as object) };  // user-set temp wins
    } else {
      data[key] = value;
    }
  }
  return { ...spec, data };
}

/**
 * Parse a JSON spec into an AST. Cheap and synchronous after Mosaic is
 * loaded; used by `generate_chart` for dry-validation so the AI gets fast
 * feedback before the chat block mounts.
 */
export async function parseChartSpec(spec: any): Promise<any> {
  const { parseSpec } = await getMosaicAPI();
  return parseSpec(injectTempData(spec));
}

/**
 * Parse and render a spec into a live DOM element wired to our Coordinator.
 * The returned element is ready to be appended to the chat block.
 */
export async function renderChartSpec(spec: any): Promise<HTMLElement> {
  const { api, parseSpec, astToDOM } = await getMosaicAPI();
  const ast = parseSpec(injectTempData(spec));
  const result = await astToDOM(ast, { api });
  return result.element;
}
