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
import { coerceArrowValue } from "@/lib/duckdb-query";

/** Name of the data source we inject into every chart spec. Used both at
 *  embed time (so vega-lite has rows to render) and at refresh time (so
 *  view.change(NAME, changeset) can target the same dataset). Underscore-
 *  prefixed + project-specific to avoid colliding with anything the LLM
 *  might emit (the bare "source_0" default collides with Vega-Lite's own
 *  internal naming for inline datasets — observed as "Duplicate data set
 *  name" compile errors). */
export const CUPOLA_DATA_NAME = "__cupola_data";

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

let _vegaLiteCompile: ((spec: any, opts?: any) => any) | null = null;
async function getVegaLiteCompile(): Promise<(spec: any, opts?: any) => any> {
  if (_vegaLiteCompile) return _vegaLiteCompile;
  // Lazy: only loaded when we validate a chart spec, not on app boot.
  // We accept the duplicate compile (this one for warnings, then again
  // inside vega-embed for rendering) — compile is millisecond-scale.
  const m = await import("vega-lite");
  _vegaLiteCompile = m.compile;
  return _vegaLiteCompile;
}

export interface ChartCompileResult {
  /** Vega-Lite warnings emitted at compile time. Examples:
   *  - "shape dropped as it is incompatible with 'circle'"
   *  - "Log scale domain includes zero: [0, 584]"
   *  Surface these in the tool_result so the agent can self-correct. */
  warnings: string[];
  /** Set when compile threw (the spec is malformed beyond fixup). */
  error?: string;
}

/** Default width for the headless agent-feedback PNG render. ~800px is
 *  small enough to keep image input tokens reasonable (~1568 tokens via
 *  Claude's image tokenizer) while still being readable enough that the
 *  model can spot overlapping labels, bad scale choices, etc. */
const AGENT_FEEDBACK_PNG_WIDTH = 800;
/** Default height for the agent-feedback PNG. Square-ish aspect ratio
 *  works for most chart types; the spec's own height usually overrides
 *  this for tall faceted plots. */
const AGENT_FEEDBACK_PNG_HEIGHT = 500;

/**
 * Render a Vega-Lite spec to a base64 PNG, headless (no DOM mount).
 *
 * Used to ship the rendered chart back to the agent inside the tool_result
 * so it can SEE what it produced — Claude is multimodal and reading the
 * image catches problems (label overlap, bad color choice, empty plot,
 * wrong scale) that the spec alone doesn't reveal.
 *
 * This runs in PARALLEL with the inline VegaChartBlock's normal embed —
 * we don't try to share the view because the inline render is in React's
 * lifecycle and resolves later. The duplicate compile + render cost is
 * acceptable (~50-200ms for typical charts, paid only on initial
 * render_chart, NOT on user refresh).
 */
export async function renderChartToPng(
  spec: Record<string, any>,
  rows: Record<string, any>[],
): Promise<{ data: string; mediaType: "image/png" } | { error: string }> {
  try {
    const [vega, compile] = await Promise.all([getVega(), getVegaLiteCompile()]);
    const safeRows = sanitizeRowsForVega(rows);
    // Compose the same spec the inline embed will use, but with fixed
    // dimensions so the PNG sent to the model is reproducible regardless
    // of the user's viewport. Override the LLM's spec width/height too —
    // the goal is a model-readable thumbnail, not pixel-matching the
    // inline view.
    const finalSpec = {
      ...spec,
      width: AGENT_FEEDBACK_PNG_WIDTH,
      height: spec.height ?? AGENT_FEEDBACK_PNG_HEIGHT,
      autosize: { type: "fit", contains: "padding" },
      data: { values: safeRows, name: CUPOLA_DATA_NAME },
      config: { ...(spec.config ?? {}), background: "white" },
    };

    // Compile vl → vega. Errors here are caller's problem (compileChartSpec
    // should have caught them already), but be defensive.
    const compileResult = compile(finalSpec);
    const runtime = vega.parse(compileResult.spec);
    // renderer: "none" means no automatic DOM render; we still get a
    // working view that can produce a canvas via toCanvas/toImageURL.
    const view = new vega.View(runtime, { renderer: "none" });
    try {
      await view.runAsync();
      const dataUrl: string = await view.toImageURL("png", 1);
      view.finalize();
      // dataUrl is "data:image/png;base64,iVBOR..." — strip the prefix
      // so we hand Anthropic just the base64 payload.
      const comma = dataUrl.indexOf(",");
      if (comma < 0) return { error: "Vega returned a non-data-URL image" };
      return { data: dataUrl.slice(comma + 1), mediaType: "image/png" };
    } catch (renderErr) {
      try { view.finalize(); } catch { /* already finalized */ }
      throw renderErr;
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Compile a Vega-Lite spec in isolation, capturing warnings and errors
 * synchronously. The actual render still goes through vega-embed (which
 * compiles again internally) — this is a pre-flight check whose output
 * we hand back to the LLM as a tool_result side-channel.
 *
 * Without this, vega-lite warnings go to console.warn where the agent
 * never sees them, so it keeps producing the same broken charts.
 */
export async function compileChartSpec(spec: Record<string, any>): Promise<ChartCompileResult> {
  const warnings: string[] = [];
  // Vega's logger interface: { level, warn, info, debug, error } where
  // each returns the logger (chainable). We capture only warnings —
  // errors throw out of compile() directly.
  const captureLogger = {
    _level: 2, // vega.Warn
    level(n?: number) {
      if (typeof n === "number") this._level = n;
      return this._level;
    },
    warn(...args: any[]) {
      warnings.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      return this;
    },
    info() { return this; },
    debug() { return this; },
    error(...args: any[]) {
      // compile() usually throws on real errors before reaching the logger;
      // capture defensively in case some path logs an error instead.
      warnings.push("ERROR: " + args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      return this;
    },
  };
  try {
    const compile = await getVegaLiteCompile();
    compile(spec, { logger: captureLogger });
    return { warnings };
  } catch (e) {
    return { warnings, error: e instanceof Error ? e.message : String(e) };
  }
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
  // Pick autosize mode based on whether the caller is force-sizing
  // height. The inline chat view doesn't constrain height — we want the
  // chart to be as tall as it needs (axis titles, dense facets, etc.).
  // `fit-x` fits only the width and lets height grow to fit content; that
  // prevents the "Longitude" axis-title clipping we saw with `fit` +
  // numeric LLM height. The maximize dialog DOES constrain height (it
  // forces a target via forceHeight), so it uses `fit` to shrink to the
  // dialog's vertical budget.
  const autosize: { type: "fit" | "fit-x"; contains: "padding"; resize: true } = options.forceHeight
    ? { type: "fit", contains: "padding", resize: true }
    : { type: "fit-x", contains: "padding", resize: true };
  const finalSpec: TopLevelSpec = {
    ...spec,
    // Override AFTER the spread so the LLM's hardcoded width never wins.
    // The chat surface owns sizing; the model should worry about marks,
    // encoding, and color — not how big the canvas is.
    //
    // width: "container" makes Vega-Lite size the chart to the parent's
    // clientWidth. Combined with autosize fit-x + contains:"padding",
    // the TOTAL chart width (plot + axes + legend) fits within the
    // container — the right-hand legend is included in that budget.
    width: "container",
    ...(options.forceHeight ? { height: options.forceHeight } : {}),
    autosize,
    data: { values: safeRows, name: CUPOLA_DATA_NAME },
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
 * Convert each row's values to a Vega-/JSON-safe shape.
 *
 * Delegates to `coerceArrowValue` from duckdb-query.ts (BigInt → Number/
 * String, Date → epoch ms, recursive into nested plain objects). Kept
 * as an exported helper for the rare caller that has rows from a non-
 * readRows source (e.g. inline values built from a foreign API).
 *
 * readRows() itself already applies the same coercion, so most callers
 * can hand its output straight to embedChart with no extra step.
 */
export function sanitizeRowsForVega(rows: Record<string, any>[]): Record<string, any>[] {
  return rows.map((row) => {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(row)) {
      out[k] = coerceArrowValue(v);
    }
    return out;
  });
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
