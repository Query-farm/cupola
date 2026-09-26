import { readFileSync } from 'node:fs';
import { evidencePath, EVIDENCE_SERVICE_URL } from './helpers';
import { test, expect } from '@playwright/test';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

// A paged table prints every row, not the page on screen, with its header row
// repeated on each PDF page it spans. Past MAX_TABLE_ROWS (2,000, Evidence's own
// line between tables it loads whole and tables it pages by query) it prints the
// first 2,000 and says so.

test.use({ viewport: { width: 1500, height: 1100 }, acceptDownloads: true });

async function pageTexts(path: string): Promise<string[]> {
  const pdf = await getDocument({ data: new Uint8Array(readFileSync(path)) }).promise;
  const pages: string[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    pages.push((await (await pdf.getPage(n)).getTextContent()).items.map(item => ('str' in item ? item.str : '')).join('\n'));
  }
  return pages;
}

test('paged tables print every row, with the header on every page', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.addInitScript((serviceUrl) => {
    const report = {
      version: 1, id: 'pdf-tables', title: 'Long tables', serviceUrl,
      setupSql: '', createdAt: 1, updatedAt: 1, parameters: [], values: {},
      source: '# Long tables\n\n'
        + '```sql regions\nSELECT range AS n, \'Region \' || range AS region, range * 10 AS revenue FROM range(1, 451)\n```\n\n'
        + '```sql items\nSELECT range AS item_number, \'Item \' || range AS item FROM range(1, 2501)\n```\n\n'
        + '{% table data="regions" title="Every region" page_size=10 %}\n{% dimension value="region" title="Region name" /%}\n{% measure value="sum(revenue)" title="Revenue total" /%}\n{% /table %}\n\n'
        + '{% table data="items" title="Every item" page_size=200 /%}\n',
    };
    try { localStorage.setItem(`cupola.evidence.report.v2:${encodeURIComponent(report.serviceUrl)}:${report.id}`, JSON.stringify(report)); } catch { /* sandboxed frame */ }
  }, EVIDENCE_SERVICE_URL);
  await page.goto(evidencePath('evidence?evidence_report=pdf-tables'));
  const panel = page.getByTestId('evidence-panel');
  const regions = panel.locator('[data-render="table"]').filter({ hasText: 'Every region' });
  await expect(regions.getByText('1 - 10 of 450 rows')).toBeVisible({ timeout: 90_000 });
  await expect(panel.locator('[data-render="table"]').filter({ hasText: 'Every item' }).getByText(/of 2,500 rows/)).toBeVisible({ timeout: 60_000 });

  // Leave the reader on page 3: the export must page through and put it back.
  await regions.getByRole('button', { name: 'Next page' }).click();
  await regions.getByRole('button', { name: 'Next page' }).click();
  await expect(regions.getByText('3 of 45', { exact: true })).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 120_000 }),
    panel.getByRole('button', { name: 'Export PDF', exact: true }).click(),
  ]);
  const path = testInfo.outputPath('long-tables.pdf');
  await download.saveAs(path);
  await testInfo.attach('long-tables.pdf', { path, contentType: 'application/pdf' });
  await expect(regions.getByText('3 of 45', { exact: true })).toBeVisible();

  const pages = await pageTexts(path);
  const all = pages.join('\n');
  // Every region row, exactly once, and the pager itself is not printed.
  const regionRows = [...all.matchAll(/^Region (\d+)$/gm)].map(match => Number(match[1])).sort((a, b) => a - b);
  expect(regionRows).toEqual(Array.from({ length: 450 }, (_, i) => i + 1));
  expect(all).not.toMatch(/of 450 rows|of 45\b/);
  // Evidence repeats the total row on each page; it prints once.
  expect(all.match(/^Total$/gm)).toHaveLength(1);
  // The header row repeats on every page the region table spans.
  for (const text of pages.filter(text => /^Region \d+$/m.test(text))) {
    expect(text).toContain('Region name');
    expect(text).toContain('Revenue total');
  }
  expect(pages.filter(text => /^Region \d+$/m.test(text)).length).toBeGreaterThan(2);

  // Past the cap: the first 2,000 rows, and a note saying so.
  expect([...all.matchAll(/^Item (\d+)$/gm)]).toHaveLength(2000);
  expect(all).toContain('Showing the first 2,000 of 2,500 rows.');
});
