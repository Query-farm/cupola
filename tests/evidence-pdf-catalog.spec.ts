import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { catalogReports, DEMO_SETUP_SQL } from './fixtures/evidence-catalog-reports';

// Every component Evidence registers, rendered from its own documented examples
// (tests/fixtures/evidence-catalog.json) and exported to PDF. The checks are
// invariants, not pixels: whatever the screen shows must reach the PDF, as
// content, an error, or a named omission — never silently vanish.

test.use({ viewport: { width: 1500, height: 1100 }, acceptDownloads: true });
test.describe.configure({ mode: 'parallel' });

interface Debug { main: string; files: Record<string, string | Uint8Array>; coverage: { render: string; handling: string; outcome: string }[] }

/** Wait until the report stops loading: no refresh in progress and a stable chart count. */
async function settle(page: Page) {
  await expect(page.getByTestId('evidence-document')).toBeVisible({ timeout: 90_000 });
  const status = page.getByRole('status', { name: 'Report refresh status' });
  let last = -1, stable = 0;
  for (let i = 0; i < 90 && stable < 3; i++) {
    await page.waitForTimeout(1000);
    const charts = await page.evaluate(() => document.querySelector('[data-testid=evidence-preview]')?.shadowRoot?.querySelectorAll('[data-echarts-ready="true"]').length ?? 0);
    const busy = /Refreshing/.test(await status.textContent() ?? '');
    stable = charts === last && !busy ? stable + 1 : 0;
    last = charts;
  }
}

for (const report of catalogReports()) {
  test(`exports every ${report.title.replace('Evidence catalog: ', '').toLowerCase()} component`, async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(([saved]) => {
      // Init scripts also run inside Evidence's sandboxed iframes, which have no storage.
      try { localStorage.setItem(`cupola.evidence.report.v2:${encodeURIComponent(saved.serviceUrl)}:${saved.id}`, JSON.stringify(saved)); } catch { return; }
      (window as { __cupolaPdfDebug?: unknown }).__cupolaPdfDebug = true;
    }, [{ version: 1, id: report.id, title: report.title, serviceUrl: 'https://vgi-open-meteo.rusty-bb6.workers.dev', setupSql: DEMO_SETUP_SQL, createdAt: 1, updatedAt: 1, parameters: [], values: {}, source: report.source }]);
    await page.goto(`evidence?evidence_report=${report.id}`);
    await settle(page);

    const onScreen = await page.evaluate(() => {
      const root = document.querySelector('[data-testid=evidence-preview]')!.shadowRoot!;
      const visible = (selector: string) => [...root.querySelectorAll(selector)].filter(el => el.checkVisibility());
      return {
        renders: [...new Set(visible('[data-render]').map(el => el.getAttribute('data-render')!))],
        // A failed component still mounts its empty chart beside the error box; the
        // PDF prints the error instead, so only charts of working components count.
        charts: visible('[_echarts_instance_]').filter(chart => !chart.closest('[data-render]')?.querySelector('.text-destructive.font-mono')?.checkVisibility()).length,
        errors: visible('.text-destructive.font-mono').length,
      };
    });

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 120_000 }),
      page.getByTestId('evidence-panel').getByRole('button', { name: 'Export PDF', exact: true }).click(),
    ]);
    const path = testInfo.outputPath(`${report.id}.pdf`);
    await download.saveAs(path);
    await testInfo.attach(`${report.id}.pdf`, { path, contentType: 'application/pdf' });
    const pdf = readFileSync(path).toString('latin1');
    expect(pdf.startsWith('%PDF-')).toBe(true);

    const debug = await page.evaluate(() => (window as unknown as { __cupolaPdfDebug: Debug }).__cupolaPdfDebug);
    // Every component the exporter met is classified in components.ts…
    expect(debug.coverage.filter(entry => entry.handling === 'unclassified').map(entry => entry.render)).toEqual([]);
    // …and every component on screen was met.
    const covered = new Set(debug.coverage.map(entry => entry.render));
    expect(onScreen.renders.filter(render => !covered.has(render))).toEqual([]);
    // Every chart on screen is an SVG in the PDF (charts inside snapshots are part of their image).
    const svgs = Object.entries(debug.files).filter(([name]) => name.endsWith('.svg') && !name.startsWith('/cupola')).length;
    expect(svgs).toBeGreaterThanOrEqual(onScreen.charts - (debug.main.match(/cupola-image\(/g)?.length ?? 0));
    // Every error on screen prints as an error rather than an empty frame.
    expect(debug.main.match(/cupola-error\(/g)?.length ?? 0).toBeGreaterThanOrEqual(onScreen.errors > 0 ? 1 : 0);
    expect(errors.filter(message => !/sandboxed and lacks the 'allow-same-origin'/.test(message))).toEqual([]);
  });
}
