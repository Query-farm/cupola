import { evidencePath, EVIDENCE_SERVICE_URL } from './helpers';
import { test, expect, type Page } from '@playwright/test';
import { catalogComponentReports, DEMO_SETUP_SQL } from './fixtures/evidence-catalog-reports';

// Maps get their own spec because they fail silently: a MapLibre worker/main-thread
// version mismatch (Evidence pins the CDN worker to one maplibre-gl version; a newer
// npm copy drifts the protocol) renders every basemap as a flat gray panel, with
// the point layers and legend still drawn on top. The catalog invariants cannot see
// that; this spec measures the pixels.

test.use({ viewport: { width: 1500, height: 1100 }, acceptDownloads: true });

/** Distinct colors in a downsampled image: a flat panel has a handful, a basemap hundreds. */
async function colorVariety(page: Page, source: 'screen' | 'pdf'): Promise<number[]> {
  return page.evaluate(async source => {
    const count = (image: CanvasImageSource, width: number, height: number) => {
      const canvas = Object.assign(document.createElement('canvas'), { width: 160, height: Math.max(1, Math.round(160 * height / width)) });
      const context = canvas.getContext('2d', { willReadFrequently: true })!;
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const colors = new Set<number>();
      // Full precision: the basemap is many near-identical light grays, and a flat
      // panel is one color plus the antialiased edges of whatever is drawn on it.
      for (let i = 0; i < data.length; i += 4) colors.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
      return colors.size;
    };
    if (source === 'screen') {
      const root = document.querySelector('[data-testid=evidence-preview]')!.shadowRoot!;
      return [...root.querySelectorAll<HTMLCanvasElement>('[data-render="map"] canvas.maplibregl-canvas')].map(canvas => count(canvas, canvas.width, canvas.height));
    }
    const { files, main } = (window as unknown as { __cupolaPdfDebug: { files: Record<string, Uint8Array | string>; main: string } }).__cupolaPdfDebug;
    const shots = [...main.matchAll(/cupola-image\([^\n]*?file: "([^"]+\.png)"/g)].map(match => files[match[1]] as Uint8Array);
    return Promise.all(shots.map(async bytes => {
      const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/png' }));
      return count(bitmap, bitmap.width, bitmap.height);
    }));
  }, source);
}

/** Distinct colors a map needs to count as having a basemap (see the negative control below). */
const BASEMAP_MIN_COLORS = 40;

test('maps draw their basemap on screen and in the PDF', async ({ page }) => {
  test.setTimeout(120_000);
  const report = catalogComponentReports().find(r => r.render === 'map')!;
  const mapErrors: string[] = [];
  page.on('console', message => { if (message.type() === 'error' && /maplibre/i.test(message.location().url)) mapErrors.push(message.text()); });
  await page.addInitScript(([saved]) => {
    try { localStorage.setItem(`cupola.evidence.report.v2:${encodeURIComponent(saved.serviceUrl)}:${saved.id}`, JSON.stringify(saved)); } catch { return; }
    (window as { __cupolaPdfDebug?: unknown }).__cupolaPdfDebug = true;
  }, [{ version: 1, id: 'map-check', title: 'Map check', serviceUrl: EVIDENCE_SERVICE_URL, setupSql: DEMO_SETUP_SQL, createdAt: 1, updatedAt: 1, parameters: [], values: {}, source: report.source }]);
  await page.goto(evidencePath('evidence?evidence_report=map-check'));
  const panel = page.getByTestId('evidence-panel');
  await expect(panel.getByTestId('evidence-document')).toBeVisible({ timeout: 90_000 });

  // Every map example renders, and each canvas fills in with basemap detail as tiles arrive.
  await expect(async () => {
    const variety = await colorVariety(page, 'screen');
    expect(variety.length).toBe(report.examples);
    for (const colors of variety) expect(colors).toBeGreaterThan(BASEMAP_MIN_COLORS);
  }).toPass({ timeout: 60_000 });
  expect(mapErrors).toEqual([]);

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    panel.getByRole('button', { name: 'Export PDF', exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('map-check.pdf');
  // One captured image per map, each still carrying the basemap.
  const printed = await colorVariety(page, 'pdf');
  expect(printed.length).toBe(report.examples);
  for (const colors of printed) expect(colors).toBeGreaterThan(BASEMAP_MIN_COLORS);
});

test('the basemap check fails when tiles never load', async ({ page }) => {
  // Negative control: with the tile server blocked each map is a flat panel plus its
  // layers, and must score below the threshold the test above requires.
  test.setTimeout(120_000);
  const report = catalogComponentReports().find(r => r.render === 'map')!;
  await page.route(/tiles\.openfreemap\.org/, route => route.abort());
  await page.addInitScript(([saved]) => {
    try { localStorage.setItem(`cupola.evidence.report.v2:${encodeURIComponent(saved.serviceUrl)}:${saved.id}`, JSON.stringify(saved)); } catch { return; }
  }, [{ version: 1, id: 'map-blocked', title: 'Map blocked', serviceUrl: EVIDENCE_SERVICE_URL, setupSql: DEMO_SETUP_SQL, createdAt: 1, updatedAt: 1, parameters: [], values: {}, source: report.source }]);
  await page.goto(evidencePath('evidence?evidence_report=map-blocked'));
  await expect(page.getByTestId('evidence-panel').getByTestId('evidence-document')).toBeVisible({ timeout: 90_000 });
  await expect(async () => expect((await colorVariety(page, 'screen')).length).toBe(report.examples)).toPass({ timeout: 60_000 });
  await page.waitForTimeout(3000);
  const variety = await colorVariety(page, 'screen');
  for (const colors of variety) expect(colors).toBeLessThanOrEqual(BASEMAP_MIN_COLORS);
});
