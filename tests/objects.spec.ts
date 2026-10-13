import { test as base, expect } from '@playwright/test';
import { startReportingWorker } from './reporting/worker';
import { chooseReportAction, waitForShellBridge } from './helpers';
const test = base.extend<{}, { reporting: Awaited<ReturnType<typeof startReportingWorker>> }>({
  reporting: [async ({}, use) => { const worker = await startReportingWorker(); try { await use(worker); } finally { await worker.stop(); } }, { scope: 'worker' }],
});
test.use({ viewport: { width: 1600, height: 1150 } });
test.setTimeout(150_000);
for (const kind of ['query', 'notebook'] as const) test(`${kind} opens without executing, saves unknown metadata, recovers a lost reply, and copies locally`, async ({ page, reporting }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const original = kind === 'query' ? { query: 'SELECT 424242 AS answer', context: {}, vendor: { keep: 7 } } : { version: 1, cells: [{ id: 'cell', type: 'sql', title: 'Query', source: 'SELECT 424242 AS answer', collapsed: false, charts: [], vendor: { keep: 9 } }], context: {}, vendor: { keep: 7 } };
  const record = await reporting.client().call('create_report', { request_id: crypto.randomUUID(), envelope: { title: `Portable ${kind}`, description: 'Reviewable', tags: ['shared'], body_format: `cupola.${kind}/1`, data_sources: [], parameters: [] }, body: new TextEncoder().encode(JSON.stringify(original)) });
  await page.addInitScript(({ url }) => sessionStorage.setItem('vgi.oauth.tokens.' + url, JSON.stringify({ access_token: 'test-alice', expires_at: Math.floor(Date.now() / 1000) + 3600, use_id_token: false })), { url: reporting.url });
  await page.goto(`reports?service=${encodeURIComponent(reporting.url)}&report_service=${encodeURIComponent(reporting.url)}&report_id=${record.report_id}#token=test-alice`);
  await waitForShellBridge(page, 40_000);
  const save = page.getByRole('button', { name: 'Save to library', exact: true });
  await expect(save).toBeVisible({ timeout: 40_000 });
  await expect(page.locator('.cm-content').first()).toContainText('424242');
  expect(await page.getByText('Query completed', { exact: true }).count()).toBe(0);
  let drop = true;
  await page.route('**/commit_revision', async route => { const response = await route.fetch(); if (drop) { drop = false; await route.abort('failed'); } else await route.fulfill({ response }); });
  await save.click();
  await expect(page.getByRole('button', { name: 'Retry pending save' })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Retry pending save' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved to library' })).toBeVisible();
  const saved = await reporting.client().call('get_report', { report_id: record.report_id });
  expect(JSON.parse(new TextDecoder().decode(saved.body!)).vendor.keep).toBe(7);
  expect(await reporting.client().call('list_revisions', { report_id: record.report_id })).toHaveLength(2);
  await chooseReportAction(page, 'Version history');
  await expect(page.getByRole('region', { name: 'Report history' })).toContainText('Revision 2');
  await page.getByRole('button', { name: 'Back to report', exact: true }).click();
  await page.getByRole('button', { name: 'Save a copy…', exact: true }).click();
  const destination = page.getByRole('region', { name: 'Save destination' });
  await destination.getByRole('treeitem', { name: 'Local', exact: true }).click();
  await destination.getByRole('button', { name: 'Save here' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved on this device' })).toBeVisible();
  await expect(page.getByTestId('catalog-sidebar').getByRole('link', { name: `Portable ${kind} (copy)`, exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('a fresh browser opens a portable query with its declared catalog and schema', async ({ page, browser, reporting }) => {
  const client = reporting.client();
  const saved = await client.call('create_report', { request_id: crypto.randomUUID(), envelope: {
    title: 'Portable context', description: '', tags: [], body_format: 'cupola.query/1', parameters: [],
    data_sources: [{ alias: 'finance_shared', attachment_id: 'finance', location: reporting.url, catalog_name: 'yfinance', required: true, label: 'Finance' }],
  }, body: new TextEncoder().encode(JSON.stringify({ query: 'SELECT current_database() AS chosen_catalog, current_schema() AS chosen_schema', context: { default_source_alias: 'finance_shared', default_schema: 'main' } })) });
  await client.call('publish', { request_id: crypto.randomUUID(), report_id: saved.report_id, revision_id: saved.head_revision_id, expected_published_revision_id: null });
  await page.goto(`reports?service=${encodeURIComponent(reporting.url)}&report_service=${encodeURIComponent(reporting.url)}&report_id=${saved.report_id}#token=test-alice`);
  await page.getByLabel('Report toolbar').getByRole('button', { name: 'Share', exact: true }).click();
  const link = page.getByRole('textbox', { name: 'Report link', exact: true });
  await expect(link).toHaveValue(/#ws=/);
  const context = await browser.newContext();
  try {
    const reader = await context.newPage(); await reader.goto(await link.inputValue());
    await reader.getByTestId('workspace-consent').getByRole('button', { name: 'Attach catalog', exact: true }).click();
    await waitForShellBridge(reader, 40_000);
    await expect(reader.getByRole('button', { name: 'Run', exact: true })).toBeEnabled({ timeout: 40_000 });
    await reader.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(reader.getByRole('table')).toContainText('finance_shared');
    await expect(reader.getByRole('table')).toContainText('main');
  } finally { await context.close(); }
});

for (const kind of ['query', 'notebook'] as const) test(`a new ${kind} saves from its ordinary editor and reopens from the library`, async ({ page, reporting }) => {
  await page.addInitScript(({ url }) => sessionStorage.setItem('vgi.oauth.tokens.' + url, JSON.stringify({ access_token: 'test-alice', expires_at: Math.floor(Date.now() / 1000) + 3600, use_id_token: false })), { url: reporting.url });
  await page.goto(`${kind === 'notebook' ? 'notebooks' : ''}?service=${encodeURIComponent(reporting.url)}#token=test-alice`);
  await waitForShellBridge(page, 40_000);
  if (kind === 'query') await page.getByTestId('tab-editor').click();
  if (kind === 'notebook') await page.getByTestId('notebook-library').getByRole('button', { name: 'New notebook', exact: true }).click();
  await page.locator('.cm-content').first().fill('SELECT 1717 AS saved_value');
  await page.getByRole('button', { name: 'Save to library…', exact: true }).click();
  const picker = page.getByRole('region', { name: 'Save destination' });
  await picker.getByLabel('Name', { exact: true }).fill(`New shared ${kind}`);
  await picker.getByRole('treeitem', { name: 'Finance report library', exact: true }).click();
  await picker.getByRole('button', { name: 'Save here' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved to library' })).toBeVisible();
  const saved = (await reporting.client().call('list_reports', {})).find(r => r.envelope?.title === `New shared ${kind}`)!;
  expect(saved).toBeDefined();
  const result = await reporting.client().call('get_report', { report_id: saved.report_id });
  expect(result.envelope?.data_sources.some(s => s.catalog_name === 'yfinance')).toBe(true);
  await page.goto(`reports?service=${encodeURIComponent(reporting.url)}&report_service=${encodeURIComponent(reporting.url)}&report_id=${saved.report_id}`);
  await expect(page.locator('.cm-content').first()).toContainText('1717');
});
