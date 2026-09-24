import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { APP_ORIGIN, BASE, T_SHELL_BOOT } from './helpers';

async function openGuide(page: import('@playwright/test').Page) {
  await page.goto(`${APP_ORIGIN}${BASE}report-guide/`);
  await expect(page.getByTestId('report-block-showcase-kpi')).toBeVisible({ timeout: T_SHELL_BOOT });
  await expect(page.getByTestId('reports-run')).toHaveText(/Run report/, { timeout: T_SHELL_BOOT });
}
async function blank(page: import('@playwright/test').Page) {
  await openGuide(page);
  await page.getByRole('button', { name: 'Reports', exact: true }).click();
  await page.getByRole('button', { name: 'New report', exact: true }).click();
}

test('undo, redo, unpublished preview, and draft recovery survive a reload', async ({ page }) => {
  await blank(page);
  await page.getByRole('button', { name: /Executive summary Headline/ }).click();
  await expect(page.getByTestId('report-block-revenue')).toContainText('776', { timeout: T_SHELL_BOOT });
  await page.getByTestId('report-block-revenue').hover();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Delete Total revenue', exact: true }).click();
  await expect(page.getByTestId('report-block-revenue')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo report change' }).click();
  await expect(page.getByTestId('report-block-revenue')).toBeVisible();
  await page.getByRole('button', { name: 'Redo report change' }).click();
  await expect(page.getByTestId('report-block-revenue')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo report change' }).click();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByText('Draft preview', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit report', exact: true }).click();
  await expect(page.getByLabel('Report title')).toHaveValue('Executive summary');
  await page.reload();
  await expect(page.getByTestId('report-block-showcase-kpi')).toBeVisible({ timeout: T_SHELL_BOOT });
  await page.getByRole('button', { name: 'Reports', exact: true }).click();
  const recovery = page.getByRole('region', { name: 'Recoverable drafts' });
  await recovery.getByRole('button', { name: 'Executive summary', exact: true }).click();
  await expect(page.getByTestId('report-block-revenue')).toBeVisible();
  await expect(page.getByLabel('Report title')).toHaveValue('Executive summary');
  await page.getByRole('button', { name: 'Save report draft' }).click();
  await expect(page.getByTestId('report-save-status')).toHaveText('Draft · Saved');
  await page.getByRole('button', { name: 'Reports', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Recoverable drafts' })).toHaveCount(0);
});

test('offline sharing captures data and rendered charts without external dependencies', async ({ page }) => {
  await blank(page);
  await page.getByRole('button', { name: /Trends and comparisons Compare/ }).click();
  await expect(page.getByTestId('report-block-detail')).toContainText('North', { timeout: T_SHELL_BOOT });
  await expect(page.getByTestId('report-block-trend').locator('canvas, svg').first()).toBeVisible();
  await page.getByRole('button', { name: 'More report actions' }).click();
  await page.getByTestId('report-copy-draft-link').click();
  await expect(page.getByRole('dialog')).toContainText('later edits', { ignoreCase: true });
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download offline snapshot' }).click();
  const download = await downloading;
  const html = await readFile((await download.path())!, 'utf8');
  expect(html).toContain('Frozen snapshot');
  expect(html).toContain('data:image/png;base64,');
  expect(html).toContain('North');
  expect(html).not.toContain('<script');
  expect(html).toContain('6 of 6 loaded rows');
});

test('date shortcuts stage values and reset filters reapplies defaults', async ({ page }) => {
  await openGuide(page);
  await page.getByRole('button', { name: 'Reports', exact: true }).click();
  const now = Date.now();
  const report = { schemaVersion: 1, id: 'date-shortcuts', title: 'Dates', revision: 1, createdAt: now, updatedAt: now, requiredSources: [], parameters: [{ id: 'period', key: 'period', label: 'Period', type: 'date_range', defaultValue: { start: '2026-01-01', end: '2026-01-31' } }], datasets: [], blocks: [{ id: 'summary', type: 'markdown', markdown: '$period_start to $period_end', layout: { x: 0, y: 0, w: 12, h: 2 } }] };
  await page.locator('input[type="file"]').setInputFiles({ name: 'dates.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(report)) });
  await page.getByTestId('report-parameters-toggle').click();
  await page.getByLabel('Period date preset').selectOption('7');
  await expect(page.getByTestId('report-parameters-toggle')).toContainText('Unapplied changes');
  await expect(page.getByTestId('report-block-summary')).toContainText('2026-01-01');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByTestId('report-block-summary')).not.toContainText('2026-01-01');
  await page.getByRole('button', { name: 'Reset filters' }).click();
  await expect(page.getByTestId('report-block-summary')).toContainText('2026-01-01 to 2026-01-31');
});

test('chart selection updates related data and failed refreshes identify older blocks', async ({ page }) => {
  await openGuide(page);
  await page.getByRole('button', { name: 'Reports', exact: true }).click();
  const now = Date.now();
  const report = { schemaVersion: 1, id: 'click-filter', title: 'Regional report', revision: 1, createdAt: now, updatedAt: now, requiredSources: [], parameters: [{ id: 'region', key: 'region', label: 'Region', type: 'text', defaultValue: 'All' }], datasets: [{ id: 'category-data', name: 'Category totals', sql: "SELECT * FROM (VALUES ('North', 20), ('South', 20)) AS t(region, amount)" }, { id: 'detail-data', name: 'Regional detail', sql: 'SELECT $region AS selected_region' }], blocks: [{ id: 'categories', type: 'chart', title: 'Regions', datasetId: 'category-data', filter: { parameterKey: 'region', column: 'region' }, spec: { mark: 'bar', encoding: { x: { field: 'region', type: 'nominal' }, y: { field: 'amount', type: 'quantitative' } } }, layout: { x: 0, y: 0, w: 8, h: 7 } }, { id: 'detail', type: 'table', title: 'Selected region', datasetId: 'detail-data', layout: { x: 8, y: 0, w: 4, h: 7 } }] };
  await page.locator('input[type="file"]').setInputFiles({ name: 'filter.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(report)) });
  await page.getByTestId('reports-run').click();
  await expect(page.getByTestId('report-block-detail')).toContainText('All', { timeout: T_SHELL_BOOT });
  const northBar = page.getByTestId('report-block-categories').locator('.mark-rect.role-mark path').first();
  await expect(northBar).toBeVisible();
  await northBar.click();
  await expect(page.getByTestId('report-block-detail')).toContainText('North');
  await expect(page.getByTestId('report-parameters-toggle')).toContainText('North');
  await page.getByRole('button', { name: 'Reset filters' }).click();
  await expect(page.getByTestId('report-block-detail')).toContainText('All');
  await page.evaluate(() => {
    const bridge = (window as any).__bridge;
    const original = bridge.queryPrepared.bind(bridge);
    bridge.queryPrepared = (sql: string, ...args: unknown[]) => sql.includes('selected_region') ? Promise.reject(new Error('Deliberate test failure')) : original(sql, ...args);
  });
  await page.getByTestId('reports-run').click();
  await expect(page.getByTestId('report-partial-refresh')).toContainText('Regional detail');
  await expect(page.getByTestId('report-block-detail')).toContainText('All');
  await expect(page.getByTestId('report-block-detail')).toContainText('Earlier data');
  await expect(page.getByTestId('report-as-of')).toHaveText('Partially refreshed');
});

test('recovery preserves an unapplied block edit and an unapplied SQL edit', async ({ page }) => {
  await blank(page);
  await page.getByRole('button', { name: /Detailed analysis An overview/ }).click();
  await expect(page.getByTestId('report-block-detail')).toContainText('North', { timeout: T_SHELL_BOOT });
  await page.getByTestId('report-block-detail').hover();
  await page.getByRole('button', { name: 'Edit Supporting detail', exact: true }).click();
  await page.getByTestId('report-block-editor').getByLabel('Title', { exact: true }).fill('Unapplied title');
  await page.reload();
  await expect(page.getByTestId('report-block-showcase-kpi')).toBeVisible({ timeout: T_SHELL_BOOT });
  await page.getByRole('button', { name: 'Reports', exact: true }).click();
  await page.getByRole('region', { name: 'Recoverable drafts' }).getByRole('button', { name: 'Detailed analysis', exact: true }).click();
  await expect(page.getByTestId('report-block-editor').getByLabel('Title', { exact: true })).toHaveValue('Unapplied title');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Close block editor' }).click();
  await page.getByTestId('report-datasets-tab').click();
  await page.getByTestId('report-edit-dataset').click();
  await page.getByTestId('report-dataset-sql-editor').fill('SELECT 123 AS unfinished');
  await page.reload();
  await expect(page.getByTestId('report-block-showcase-kpi')).toBeVisible({ timeout: T_SHELL_BOOT });
  await page.getByRole('button', { name: 'Reports', exact: true }).click();
  await page.getByRole('region', { name: 'Recoverable drafts' }).getByRole('button', { name: 'Detailed analysis', exact: true }).click();
  await expect(page.getByTestId('report-dataset-sql-editor')).toHaveValue('SELECT 123 AS unfinished');
  await expect(page.getByTestId('report-apply-dataset')).toBeDisabled();
});

test('a blank title remains recoverable with all unsaved report content', async ({ page }) => {
  await blank(page);
  await page.getByRole('button', { name: /Executive summary Headline/ }).click();
  await expect(page.getByTestId('report-block-revenue')).toContainText('776', { timeout: T_SHELL_BOOT });
  await page.getByLabel('Report title').fill('');
  await expect(page.getByRole('button', { name: 'Save report draft' })).toBeDisabled();
  await page.reload();
  await expect(page.getByTestId('report-block-showcase-kpi')).toBeVisible({ timeout: T_SHELL_BOOT });
  await page.getByRole('button', { name: 'Reports', exact: true }).click();
  await page.getByRole('region', { name: 'Recoverable drafts' }).getByRole('button', { name: 'Untitled report', exact: true }).click();
  await expect(page.getByLabel('Report title')).toHaveValue('');
  await expect(page.getByTestId('report-block-revenue')).toBeVisible();
  await expect(page.getByTestId('report-block-target')).toBeVisible();
  await expect(page.getByTestId('report-block-detail')).toBeVisible();
  await page.getByLabel('Report title').fill('Recovered report');
  await page.getByTestId('reports-run').click();
  await expect(page.getByTestId('report-block-revenue')).toContainText('776', { timeout: T_SHELL_BOOT });
});

test('snapshot export waits for block edits to be applied and exports one consistent version', async ({ page }) => {
  await blank(page);
  await page.getByRole('button', { name: /Executive summary Headline/ }).click();
  await expect(page.getByTestId('report-block-revenue')).toContainText('776', { timeout: T_SHELL_BOOT });
  await page.getByTestId('report-block-revenue').hover();
  await page.getByRole('button', { name: 'Edit Total revenue', exact: true }).click();
  await page.getByTestId('report-block-editor').getByLabel('Title', { exact: true }).fill('Pending target');
  await page.getByLabel('Value', { exact: true }).selectOption('target');
  await expect(page.getByTestId('report-block-revenue')).toContainText('720');
  await page.getByRole('button', { name: 'More report actions' }).click();
  await page.getByTestId('report-copy-draft-link').click();
  await expect(page.getByRole('button', { name: 'Download offline snapshot' })).toBeDisabled();
  await expect(page.getByRole('dialog')).toContainText('Apply or discard your block and dataset edits');
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByTestId('report-block-apply').click();
  await expect(page.getByTestId('report-block-editor')).toHaveCount(0);
  await page.getByRole('button', { name: 'More report actions' }).click();
  await page.getByTestId('report-copy-draft-link').click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download offline snapshot' }).click();
  const html = await readFile((await (await downloading).path())!, 'utf8');
  expect(html).toMatch(/<h2>Pending target<\/h2>[\s\S]*?\$720\.00/);
  expect(html).not.toContain('<h2>Total revenue</h2>');
});

test('snapshot captions and sources resolve applied parameters and escape the result', async ({ page }) => {
  await openGuide(page);
  await page.getByRole('button', { name: 'Reports', exact: true }).click();
  const now = Date.now();
  const report = {
    schemaVersion: 1, id: 'snapshot-notes', title: 'Snapshot notes', revision: 1,
    createdAt: now, updatedAt: now, requiredSources: [], datasets: [],
    parameters: [
      { id: 'period', key: 'period', label: 'Period', type: 'date_range', defaultValue: { start: '2026-01-01', end: '2026-01-31' } },
      { id: 'source', key: 'source', label: 'Source', type: 'text', defaultValue: '<agency>' },
    ],
    blocks: [{ id: 'notes', type: 'markdown', markdown: 'Results', caption: 'Period: $period_start to $period_end', source: '$source', layout: { x: 0, y: 0, w: 12, h: 3 } }],
  };
  await page.locator('input[type="file"]').setInputFiles({ name: 'notes.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(report)) });
  await page.getByTestId('report-parameters-toggle').click();
  await page.getByLabel('Period start', { exact: true }).fill('2026-01-10');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByTestId('report-block-notes')).toContainText('Period: 2026-01-10 to 2026-01-31');
  await page.getByRole('button', { name: 'More report actions' }).click();
  await page.getByTestId('report-copy-draft-link').click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download offline snapshot' }).click();
  const html = await readFile((await (await downloading).path())!, 'utf8');
  expect(html).toContain('Period: 2026-01-10 to 2026-01-31');
  expect(html).toContain('Source: &lt;agency&gt;');
  expect(html).not.toContain('$period');
  expect(html).not.toContain('$source');
  expect(html).not.toContain('<agency>');
});
