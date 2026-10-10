import { chooseReportAction } from './helpers';
import { test, expect } from '@playwright/test';
import { evidencePath, EVIDENCE_SERVICE_URL } from './helpers';

test.use({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true });

// Evidence's sandboxed components (html, custom_map, JS-mode custom_echart) run author code in an
// opaque-origin iframe that loads a runtime bundle Cupola serves. They used to 404 it ("sandbox
// runtime responded HTTP 404 … Run its `build:sandbox` step"): nothing built the runtimes, and
// the core asks for them at the origin root while Cupola serves each release under its own base.
// In the PDF they printed blank, because html-to-image cannot read inside the iframe. And a
// sampled custom_echart vanished from the page: its sampling tooltip needs a Tooltip.Provider.

// Evidence's own `html` example, which reads its data through the iframe's query bridge.
const HTML_BLOCK = "```sql daily_orders\nselect 'Mon' as day, 120 as orders union all\nselect 'Tue', 180 union all\nselect 'Wed', 90\n```\n\n{% html %}\n<div id=\"bars\" style=\"display:flex; gap:8px; align-items:flex-end; height:120px;\"></div>\n<script>\n\tasync function render() {\n\t\tconst rows = await evidence.query(\"daily_orders\");\n\t\tconst max = Math.max(...rows.map((r) => r.orders));\n\t\tdocument.getElementById(\"bars\").innerHTML = rows\n\t\t\t.map((r) => `<div class=\"bar\" style=\"flex:1; background:${evidence.theme.palette[0]}; height:${(r.orders / max) * 100}%\"></div>`)\n\t\t\t.join(\"\");\n\t}\n\tevidence.subscribe(render);\n\tawait render();\n\tevidence.ready();\n</script>\n{% /html %}";

// A function in the option body routes custom_echart to its sandbox (JavaScript mode).
const JS_ECHART = "{% custom_echart data=\"demo.daily_orders\" %}\n{\n  xAxis: { type: 'category' },\n  yAxis: { axisLabel: { formatter: (value) => fmt(value, 'usd0m') } },\n  series: [{ type: 'bar', encode: { x: 'category', y: 'total_sales' }, itemStyle: { color: theme.colorPalettes.default[0] } }]\n}\n{% /custom_echart %}";

// Evidence's basic custom_map example, with the style its docs give for MapLibre: without a
// Mapbox token the runtime uses MapLibre, which (unlike Mapbox GL) has no default style.
const CUSTOM_MAP = "{% custom_map height=300 %}\nconst map = new mapgl.Map({ container, style: 'https://tiles.openfreemap.org/styles/positron', center: [-71.06, 42.36], zoom: 9 });\nmap.on('idle', () => evidence.ready());\n{% /custom_map %}";

/** Distinct colors a captured map needs to count as a basemap rather than an empty frame. */
const BASEMAP_MIN_COLORS = 40;

test('sandboxed blocks load their runtime from this release, render, and print', async ({ page }) => {
  test.setTimeout(180_000);
  const source = `# Sandbox\n\n${HTML_BLOCK}\n\n${JS_ECHART}\n\n${CUSTOM_MAP}\n`;
  const report = { version: 1, id: 'sandbox', title: 'Sandbox', serviceUrl: EVIDENCE_SERVICE_URL, setupSql: '', createdAt: 1, updatedAt: 1, parameters: [], values: {}, source };
  await page.addInitScript(([saved]) => {
    (window as { __cupolaPdfDebug?: unknown }).__cupolaPdfDebug = true;
    try { localStorage.setItem(`cupola.evidence.report.v2:${encodeURIComponent(saved.serviceUrl)}:${saved.id}`, JSON.stringify(saved)); } catch { /* sandboxed frame */ }
  }, [report]);
  const errors: string[] = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const runtimes: { url: string; status: number }[] = [];
  page.on('response', response => { if (/\/sandbox\/[\w-]+-runtime\.js/.test(response.url())) runtimes.push({ url: response.url(), status: response.status() }); });

  await page.goto(evidencePath('evidence?evidence_report=sandbox'));
  const panel = page.getByTestId('evidence-panel');
  const rendered = panel.getByTestId('evidence-document');
  await expect(rendered.locator('[data-render="html"] iframe').contentFrame().locator('#bars > .bar')).toHaveCount(3, { timeout: 90_000 });
  await expect(rendered.locator('[data-render="custom_echart"] iframe').contentFrame().locator('canvas').first()).toBeAttached({ timeout: 30_000 });
  await expect(rendered.locator('[data-render="custom_map"] iframe').contentFrame().locator('canvas.maplibregl-canvas')).toBeAttached({ timeout: 30_000 });

  // Served from the release's own base, not the origin root another release would answer for.
  const base = new URL(page.url()).pathname.replace(/evidence.*$/, '');
  expect([...new Set(runtimes.map(runtime => new URL(runtime.url).pathname.replace(/^.*\/sandbox\//, '')))].sort()).toEqual(['custom-map-runtime.js', 'echart-runtime.js', 'html-runtime.js']);
  for (const runtime of runtimes) {
    expect(runtime.status, runtime.url).toBe(200);
    expect(new URL(runtime.url).pathname.startsWith(`${base}sandbox/`), runtime.url).toBe(true);
  }

  // In the PDF, each block is a picture of what it drew (bars, a basemap), not an empty frame.
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 120_000 }),
    chooseReportAction(page, 'Export PDF'),
  ]);
  expect(await download.failure()).toBeNull();
  const printed = await page.evaluate(async () => {
    const { files, main, coverage } = (window as unknown as { __cupolaPdfDebug: { files: Record<string, Uint8Array | string>; main: string; coverage: { render: string; handling: string; outcome?: string }[] } }).__cupolaPdfDebug;
    const shots = [...main.matchAll(/cupola-image\([^\n]*?file: "([^"]+\.png)"/g)].map(match => files[match[1]] as Uint8Array);
    const images = await Promise.all(shots.map(async bytes => {
      const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/png' }));
      const canvas = Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height });
      const context = canvas.getContext('2d', { willReadFrequently: true })!;
      context.drawImage(bitmap, 0, 0);
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let ink = 0;
      const colors = new Set<number>();
      for (let i = 0; i < data.length; i += 4) {
        colors.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
        // Ink against the light page: a blank capture has none, drawn bars a good share.
        if (data[i + 3] > 128 && 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] < 160) ink++;
      }
      return { ink: ink / (data.length / 4), colors: colors.size };
    }));
    return { images, renders: coverage.map(entry => entry.render) };
  });
  expect(printed.renders).toEqual(expect.arrayContaining(['html', 'custom_echart', 'custom_map']));
  // In document order: the html bars, the chart, the map.
  expect(printed.images).toHaveLength(3);
  const [bars, chart, map] = printed.images;
  expect(bars.ink).toBeGreaterThan(0.05);
  expect(chart.ink).toBeGreaterThan(0.05);
  expect(map.colors).toBeGreaterThan(BASEMAP_MIN_COLORS);
  expect(errors.filter(message => /sandbox/i.test(message))).toEqual([]);
});
