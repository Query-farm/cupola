/** Fit an ECharts option's pixel geometry to the print size.
 *
 * Evidence resolves some layout to pixels at runtime from the container it measured
 * (a styled funnel stores `left: 115.8, width: 970.2` for a 1086px chart). Replayed
 * into a 672px print chart that width overflows: bars stretch and clip, and bar
 * length stops encoding value. Pixel margins (`left`, `right`, `top`, `bottom`) hold
 * labels, which keep their size in print, so they stay; the size a component lost
 * comes out of its pixel `width` or `height`. Percentages and keywords ("5%",
 * "center") already follow the container and are left alone. */
type Json = Record<string, unknown>;
export interface Size { width: number; height: number }

/** Top-level components that are positioned in the chart's box. */
const POSITIONED = ['series', 'grid', 'legend', 'title', 'visualMap', 'dataZoom', 'polar', 'radar', 'singleAxis', 'calendar', 'graphic'];

export function fitChartGeometry<T extends Json>(option: T, from: Size, to: Size): T {
  const dw = to.width - from.width, dh = to.height - from.height;
  if (!from.width || !from.height || (dw === 0 && dh === 0)) return option;
  const sx = to.width / from.width, sy = to.height / from.height;
  const fit = (item: unknown): unknown => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const out: Json = { ...(item as Json) };
    if (typeof out.width === 'number') out.width = Math.max(0, out.width + dw);
    if (typeof out.height === 'number') out.height = Math.max(0, out.height + dh);
    // Pies, radars and polar charts: a pixel center or radius scales with the box.
    if (Array.isArray(out.center)) out.center = out.center.map((v, i) => typeof v === 'number' ? v * (i === 0 ? sx : sy) : v);
    const r = Math.min(sx, sy);
    if (typeof out.radius === 'number') out.radius *= r;
    else if (Array.isArray(out.radius)) out.radius = out.radius.map(v => typeof v === 'number' ? v * r : v);
    return out;
  };
  const next: Json = { ...option };
  for (const key of POSITIONED) {
    const value = next[key];
    next[key] = Array.isArray(value) ? value.map(fit) : fit(value);
  }
  return next as T;
}
