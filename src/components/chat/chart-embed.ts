/**
 * Vega-embed wrapper with the security model baked in.
 *
 * Lives in its own module so:
 *  - The dynamic import barrier for `vega`/`vega-lite`/`vega-embed` is here,
 *    not scattered across every chart consumer.
 *  - The locked loader (no network, no file) is constructed exactly once
 *    and reused for every embed call.
 *
 * The loader is the PRIMARY security control. Even if validateChartSpec
 * misses an external-resource surface, no fetch will fire.
 */
import type { TopLevelSpec } from "vega-lite";

export interface VegaView {
  change(name: string, changeset: any): VegaView;
  runAsync(): Promise<VegaView>;
  toImageURL(format: "png", scaleFactor?: number): Promise<string>;
  toSVG(scaleFactor?: number): Promise<string>;
  finalize(): void;
  /** Reference to the vega module so callers can build changesets without
   *  another dynamic import. Set by embedChart. */
  __vega?: any;
}

let _lockedLoader: any = null;
let _vegaModule: any = null;
let _embedModule: any = null;

/** Build (or reuse) a Vega loader whose http/file/sanitize all reject. */
async function getLockedLoader(): Promise<any> {
  if (_lockedLoader) return _lockedLoader;
  const vega = await getVega();
  const loader = vega.loader({});
  loader.http = async () => { throw new Error("network disabled in chat charts"); };
  loader.file = async () => { throw new Error("file access disabled in chat charts"); };
  // Sanitize returns the resolved URL Vega would have fetched — make it
  // empty so anything that slips through becomes a no-op rather than a fetch.
  loader.sanitize = async () => ({ href: "" });
  _lockedLoader = loader;
  return loader;
}

async function getVega(): Promise<any> {
  if (_vegaModule) return _vegaModule;
  _vegaModule = await import("vega");
  return _vegaModule;
}

async function getEmbed(): Promise<any> {
  if (_embedModule) return _embedModule;
  const m = await import("vega-embed");
  _embedModule = m.default;
  return _embedModule;
}

/**
 * Embed a Vega-Lite spec into a container DOM element, injecting `rows` as
 * the data and forcing transparent background (so Cupola's theme tokens
 * carry contrast). Returns the Vega `view` for refresh/export.
 *
 * Sizing: we measure the container's clientWidth at embed time and pass
 * it as a numeric `width`. The LLM's spec width is INTENTIONALLY ignored —
 * Vega-Lite's `width: "container"` proved unreliable in nested flex/grid
 * layouts, and letting the LLM win (it tends to emit `width: 500-600`)
 * produces tiny charts in our wide chat / maximize-dialog containers.
 * Height is left to the spec / Vega's default — vertical sizing rarely
 * causes complaints.
 *
 * Caller is responsible for triggering re-embed on container resize via
 * ResizeObserver. See VegaChartBlock / MaximizedChartDialog.
 */
export interface EmbedOptions {
  /** When set, overrides the spec's height (and Vega's default). Used by
   *  the maximize dialog where we want the chart to fill the available
   *  vertical space instead of staying at the LLM's typical ~250px. */
  forceHeight?: number;
}

export async function embedChart(
  el: HTMLElement,
  spec: Record<string, any>,
  rows: Record<string, any>[],
  options: EmbedOptions = {},
): Promise<VegaView> {
  const [vega, embed, loader] = await Promise.all([getVega(), getEmbed(), getLockedLoader()]);
  const safeRows = sanitizeRowsForVega(rows);
  // Account for the parent's horizontal padding so the chart doesn't bleed
  // out and trigger horizontal scroll. clientWidth excludes our own
  // padding-box, but the LLM's spec also adds axis labels / legends to the
  // right of the plot — subtracting another small buffer keeps wide legend
  // entries (e.g. "Magnitude Class") from spilling off-screen.
  const finalSpec: TopLevelSpec = {
    ...spec,
    // Override AFTER the spread so the LLM's hardcoded width never wins.
    // The chat surface owns sizing; the model should worry about marks,
    // encoding, and color — not how big the canvas is.
    //
    // width: "container" makes Vega-Lite size the chart to the parent's
    // clientWidth. Combined with autosize:"fit" + contains:"padding",
    // the TOTAL chart (plot + axes + legend) fits within the container —
    // the right-hand legend is included in that budget. A numeric width
    // here would make `width` refer to the plot area only, and the legend
    // would overflow.
    width: "container",
    ...(options.forceHeight ? { height: options.forceHeight } : {}),
    autosize: { type: "fit", contains: "padding", resize: true },
    data: { values: safeRows, name: "source_0" },
    // Force transparent background regardless of what the LLM put in
    // spec.config — the chat surface owns its own background.
    config: { ...(spec.config ?? {}), background: "transparent" },
  } as TopLevelSpec;

  const result = await embed(el, finalSpec, {
    renderer: "svg",
    actions: false,
    loader,
  });
  const view = result.view as VegaView;
  view.__vega = vega;
  return view;
}

/**
 * Convert each row's values so Vega can consume them.
 *
 * Two transforms:
 *  - BigInt → Number (DuckDB BIGINT/INT64 columns arrive as JS BigInt via
 *    Arrow). Vega's expression engine does Math.abs / arithmetic that
 *    throws on BigInt. We accept the precision loss above 2^53 — flagging
 *    the rare overflow as a string keeps the row readable rather than
 *    silently truncating to Infinity.
 *  - Arrow Vector children (struct/list) → null. Vega can't render
 *    nested values; we drop them so the rest of the row still works.
 *
 * The conversion is shallow-by-row but recursive into nested plain objects
 * so encoded computed columns survive.
 */
export function sanitizeRowsForVega(rows: Record<string, any>[]): Record<string, any>[] {
  return rows.map((row) => {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(row)) {
      out[k] = coerceForVega(v);
    }
    return out;
  });
}

function coerceForVega(v: any): any {
  if (v === null || v === undefined) return v;
  if (typeof v === "bigint") {
    const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
    const MIN_SAFE = -MAX_SAFE;
    if (v > MAX_SAFE || v < MIN_SAFE) return v.toString();
    return Number(v);
  }
  if (v instanceof Date) return v.getTime();
  // Plain objects / arrays may carry nested BigInts; recurse so encoded
  // sub-fields remain usable. Don't touch typed arrays.
  if (Array.isArray(v)) return v.map(coerceForVega);
  if (typeof v === "object" && v.constructor === Object) {
    const out: Record<string, any> = {};
    for (const [k, val] of Object.entries(v)) out[k] = coerceForVega(val);
    return out;
  }
  return v;
}

/** Download the chart as a PNG at 2x scale (retina-friendly). */
export async function downloadPNG(view: VegaView, title: string): Promise<void> {
  const url = await view.toImageURL("png", 2);
  const response = await fetch(url);
  const blob = await response.blob();
  triggerDownload(blob, `${safeFileName(title)}.png`);
}

/** Download the chart as an SVG. */
export async function downloadSVG(view: VegaView, title: string): Promise<void> {
  const svg = await view.toSVG();
  triggerDownload(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }), `${safeFileName(title)}.svg`);
}

function triggerDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

function safeFileName(s: string): string {
  return s.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "chart";
}
