import { fitChartGeometry } from './chart-geometry';
import { normalizeSvgColors } from './css-color';
import type { ChartRenderer } from './extract';

/** Evidence's chart theme names Geist, which Cupola never loads (the screen falls
 * back to a system sans); print in the report's own sans instead. */
const CHART_FONT = 'Commissioner';

/** Re-render live ECharts instances as vector SVG at print size.
 *
 * The live chart is a canvas sized for the screen; scaling a bitmap of it would
 * blur and shrink its labels. Instead its resolved option is replayed into a
 * server-side-rendering instance at the printed width, under the same theme
 * Evidence registered (`light`; report themes make both variants identical). */
/** Every `fontFamily` in the option set to the print font, plus the global default. */
function withFont<T>(option: T): T {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== 'object' || value instanceof Date || ArrayBuffer.isView(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, key === 'fontFamily' ? CHART_FONT : walk(inner)]));
  };
  const out = walk(option) as Record<string, unknown>;
  out.textStyle = { ...(out.textStyle as object | undefined), fontFamily: CHART_FONT };
  return out as T;
}

export async function loadChartRenderer(): Promise<ChartRenderer> {
  const echarts = await import('echarts');
  return (el, width, height) => {
    const live = echarts.getInstanceByDom(el);
    if (!live || !width || !height) return null;
    const chart = echarts.init(null, 'light', { renderer: 'svg', ssr: true, width, height });
    try {
      const liveOption = live.getOption() as Record<string, unknown>;
      const option = fitChartGeometry(liveOption, { width: live.getWidth(), height: live.getHeight() }, { width, height }) as { series?: object[] };
      // `window.__cupolaPdfChartOptions = []` collects each replayed option for inspection.
      (window as { __cupolaPdfChartOptions?: unknown[] }).__cupolaPdfChartOptions?.push({ width, height, liveWidth: live.getWidth(), option });
      // Series carry their own animation settings; any left on renders the SSR
      // frame mid-intro (a line series' clip path at zero width draws nothing).
      // The font goes into the option before rendering, so ECharts measures and fits
      // labels in the face that prints; swapping it in afterwards clipped end labels.
      chart.setOption(withFont({ ...option, animation: false, series: option.series?.map(series => ({ ...series, animation: false })) }));
      return normalizeSvgColors(chart.renderToSVGString())
        .replace(/font-family:[^;"]*/g, `font-family:'${CHART_FONT}'`)
        .replace(/font-family="[^"]*"/g, `font-family="${CHART_FONT}"`);
    } finally {
      chart.dispose();
    }
  };
}
