import { evidencePath, EVIDENCE_SERVICE_URL } from './helpers';
import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 1500, height: 1100 } });

test('Evidence prints a paginated document with charts, applied parameters and no app chrome', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript((serviceUrl) => {
    const report = {
      version: 1, id: 'print-check', title: 'Printable sales report',
      serviceUrl,
      setupSql: '', createdAt: 1, updatedAt: 1,
      parameters: [{ id: 'region', key: 'region', label: 'Region', type: 'text', required: true, defaultValue: 'Applied region' }],
      values: {},
      source: '# Sales overview\n\n```sql sales\nSELECT range AS period, range * 10 AS revenue FROM range(1, 81)\n```\n\n' +
        '{% bar_chart data="sales" x="period" y="revenue" title="Sales chart" /%}\n\n' +
        '{% table data="sales" title="Sales details" page_size=100 /%}\n\n' +
        Array.from({ length: 25 }, (_, i) => `## Analysis section ${i + 1}\n\nReport narrative ${i + 1}. This paragraph must flow naturally onto the next printed page without being clipped by the app viewport.\n\n`).join('') +
        '## End of printable report\n\nFinal report marker.',
    };
    localStorage.setItem(`cupola.evidence.report.v2:${encodeURIComponent(report.serviceUrl)}:${report.id}`, JSON.stringify(report));
  }, EVIDENCE_SERVICE_URL);
  await page.goto(evidencePath('evidence?evidence_report=print-check'));
  const panel = page.getByTestId('evidence-panel');
  // There is no Print button (Export PDF replaced it); ⌘P and the browser's Print
  // menu still print through before/afterprint. The View/Edit switch, present in
  // every mode, stands in for the app chrome printing must hide.
  const toolbar = panel.getByRole('group', { name: 'Report mode', exact: true });
  const report = panel.getByTestId('evidence-document');
  await expect(report.locator('tbody tr')).toHaveCount(80, { timeout: 90_000 });
  await expect(report.locator('[data-echarts-ready="true"] canvas')).toBeVisible();
  await expect(toolbar).toBeVisible();
  const title = await page.title();
  // Draft parameters must not mislabel the data from the last applied run.
  await panel.getByLabel('Region', { exact: true }).fill('Unapplied region');
  await panel.getByRole('button', { name: 'Edit report', exact: true }).click();
  await panel.getByRole('button', { name: 'Full-screen editor', exact: true }).click();
  await expect(panel.getByRole('region', { name: 'Report preview', exact: true })).toBeHidden();

  // The native event ⌘P and the browser's Print menu fire.
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  await page.emulateMedia({ media: 'print' });
  await expect(panel.getByRole('complementary', { name: 'Report editor' })).toBeHidden();
  await expect(toolbar).toBeHidden();
  await expect(panel.locator('.evidence-print-heading')).toContainText('Applied region');
  await expect(panel.locator('.evidence-print-heading')).not.toContainText('Unapplied region');
  await expect(report.getByRole('heading', { name: 'End of printable report' })).toBeVisible();
  await expect(report.locator('[data-evidence-print-snapshot]')).toBeVisible();
  // A hidden chart can resize to zero: the snapshot must retain plotted bars
  // across its full width, not a tiny plot in an otherwise blank canvas.
  expect(await report.locator('[data-evidence-print-snapshot]').evaluate((element: HTMLCanvasElement) => {
    const width = Math.floor(element.width / 4);
    const pixels = element.getContext('2d')!.getImageData(element.width - width, 0, width, element.height).data;
    let drawn = 0;
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) drawn++;
    return drawn / (width * element.height);
  })).toBeGreaterThan(0.05);
  const layout = await panel.getByTestId('evidence-report-surface').evaluate(surface => {
    const scroll = surface.parentElement!;
    return { height: surface.getBoundingClientRect().height, overflow: getComputedStyle(scroll).overflow, scrollHeight: scroll.getBoundingClientRect().height };
  });
  expect(layout.height).toBeGreaterThan(3000);
  expect(layout.overflow).toBe('visible');
  expect(layout.scrollHeight).toBeGreaterThanOrEqual(layout.height);
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await page.emulateMedia({ media: 'screen' });

  // Chromium's actual PDF path fires before/afterprint, including from editor-only mode.
  await page.emulateMedia({ media: null });
  const pdf = await page.pdf({ path: testInfo.outputPath('evidence-report.pdf'), format: 'A4', printBackground: true });
  expect((pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length).toBeGreaterThanOrEqual(3);
  await expect(page.locator('[data-evidence-print-path]')).toHaveCount(0);
  await expect(report.locator('[data-evidence-print-snapshot]')).toHaveCount(0);
  expect(await page.title()).toBe(title);
  await expect(panel.getByRole('button', { name: 'Exit full-screen editor' })).toBeVisible();
  await expect(panel.getByRole('region', { name: 'Report preview', exact: true })).toBeHidden();
  await panel.getByRole('button', { name: 'Exit full-screen editor' }).click();
  await panel.getByRole('button', { name: 'View report', exact: true }).click();
  await expect(panel.getByLabel('Region', { exact: true })).toHaveValue('Unapplied region');
  await expect(report.locator('[data-echarts-ready="true"] canvas')).toBeVisible();
  const viewerPdf = await page.pdf({ path: testInfo.outputPath('evidence-viewer.pdf'), format: 'A4', printBackground: true });
  expect((viewerPdf.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length).toBeGreaterThanOrEqual(3);
  await expect(toolbar).toBeVisible();
  await page.getByTestId('tab-catalog').click();
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  await expect(page.locator('[data-evidence-print-path]')).toHaveCount(0);
  expect(errors).toEqual([]);
});
