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
 */
export async function embedChart(
  el: HTMLElement,
  spec: Record<string, any>,
  rows: Record<string, any>[],
): Promise<VegaView> {
  const [vega, embed, loader] = await Promise.all([getVega(), getEmbed(), getLockedLoader()]);
  const finalSpec: TopLevelSpec = {
    ...spec,
    data: { values: rows, name: "source_0" },
    // Force transparent background regardless of what the LLM put in
    // spec.config — the chat surface owns its own background. Spread the
    // model's config first, then override.
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
