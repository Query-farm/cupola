import { withExtensions } from './extensions';
import { test as base, expect, chromium, webkit } from '@playwright/test';
import { startReportingWorker } from './reporting/worker';
import { waitForShellBridge } from './helpers';
const test = base.extend<{}, { reporting: Awaited<ReturnType<typeof startReportingWorker>> }>({
  reporting: [async ({}, use) => { const worker = await startReportingWorker(); try { await use(worker); } finally { await worker.stop(); } }, { scope: 'worker' }],
});
test.use({ viewport: { width: 1600, height: 1150 } });
test.setTimeout(150_000);

test('sidebar query deletion confirms, retries a lost reply, and retains the open draft', async ({ page, reporting }) => {
  const c = reporting.client();
  const saved = await c.call('create_report', { request_id: crypto.randomUUID(), envelope: { title: 'Delete sidebar query', description: '', tags: [], body_format: 'cupola.query/1', data_sources: [], parameters: [] }, body: new TextEncoder().encode('{"query":"SELECT 1"}') });
  await page.goto(`reports?service=${encodeURIComponent(reporting.url)}&report_service=${encodeURIComponent(reporting.url)}&report_id=${saved.report_id}#token=test-alice`);
  await expect(page.locator('.cm-content:visible')).toContainText('SELECT 1', { timeout: 40_000 });
  await page.locator('.cm-content:visible').fill('SELECT 87654 AS preserved_draft');
  const sidebar = page.getByTestId('catalog-sidebar'), row = sidebar.getByRole('link', { name: 'Delete sidebar query', exact: true });
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete query?', exact: true });
  await expect(dialog).toContainText('Finance report library');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await c.call('get_report', { report_id: saved.report_id })).report_id).toBe(saved.report_id);
  await row.click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Delete…', exact: true }).click();
  let drop = true;
  await page.route('**/delete_object', async route => { const response = await route.fetch(); if (drop) { drop = false; await route.abort('failed'); } else await route.fulfill({ response }); });
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(dialog).toContainText('Deletion is not confirmed');
  await dialog.getByRole('button', { name: 'Retry delete', exact: true }).click();
  await expect(dialog).not.toBeVisible(); await expect(row).toHaveCount(0);
  expect((await c.call('list_reports', {})).some(record => record.report_id === saved.report_id)).toBe(false);
  await page.getByTestId('tab-editor').click();
  await expect(page.locator('.cm-content:visible')).toContainText('87654');
  await expect(page.getByRole('status').filter({ hasText: 'Deleted from library' })).toBeVisible();
  expect(new URL(page.url()).searchParams.has('report_id')).toBe(false);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Save destination' })).toContainText('Save a copy');
});

test('sidebar deletion respects concurrent changes and worker permissions', async ({ page, reporting }) => {
  const c = reporting.client();
  let saved = await c.call('create_report', { request_id: crypto.randomUUID(), envelope: { title: 'Protected sidebar query', description: '', tags: [], body_format: 'cupola.query/1', data_sources: [], parameters: [] }, body: new TextEncoder().encode('{"query":"SELECT 1"}') });
  await page.goto(`reports?service=${encodeURIComponent(reporting.url)}&report_service=${encodeURIComponent(reporting.url)}&report_id=${saved.report_id}#token=test-alice`);
  const sidebar = page.getByTestId('catalog-sidebar');
  await sidebar.getByRole('link', { name: 'Protected sidebar query', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete…', exact: true }).click();
  saved = await c.call('commit_revision', { request_id: crypto.randomUUID(), report_id: saved.report_id, expected_revision_id: saved.head_revision_id, envelope: saved.envelope!, body: new TextEncoder().encode('{"query":"SELECT 2"}') });
  const dialog = page.getByRole('dialog', { name: 'Delete query?', exact: true });
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('changed on the worker');
  expect((await c.call('get_report', { report_id: saved.report_id })).head_revision_id).toBe(saved.head_revision_id);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await c.call('publish', { request_id: crypto.randomUUID(), report_id: saved.report_id, revision_id: saved.head_revision_id, expected_published_revision_id: null });
  await page.evaluate(url => sessionStorage.removeItem('vgi.oauth.tokens.' + url), reporting.url);
  await page.goto(`reports?service=${encodeURIComponent(reporting.url)}&report_service=${encodeURIComponent(reporting.url)}&report_id=${saved.report_id}`);
  await sidebar.getByRole('link', { name: 'Protected sidebar query', exact: true }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Delete…', exact: true })).toHaveCount(0);
});

test('saved object tags are visible and filterable, including through the sidebar', async ({ page, reporting }) => {
  const c = reporting.client();
  for (const [title, tags] of [['Quarterly revenue', ['board-review']], ['Unrelated query', ['operations']]] as const) {
    await c.call('create_report', { request_id: crypto.randomUUID(), envelope: { title, description: title === 'Quarterly revenue' ? 'Forecast for directors' : '', tags: [...tags], body_format: 'cupola.query/1', data_sources: [], parameters: [] }, body: new TextEncoder().encode('{"query":"SELECT 1"}') });
  }
  await page.goto(`reports?service=${encodeURIComponent(reporting.url)}#token=test-alice`);
  await expect(page.getByRole('tab', { name: 'Reports', exact: true })).toBeVisible();
  const overview = page.getByRole('region', { name: 'Report browser', exact: true });
  await expect(overview.getByRole('list', { name: 'Tags for Quarterly revenue' })).toContainText('board-review');
  await overview.getByRole('button', { name: 'Filter by tag: board-review', exact: true }).click();
  await expect(overview.getByLabel('Filter by tag', { exact: true })).toHaveValue('board-review');
  await expect(overview.getByRole('button', { name: 'Unrelated query', exact: true })).toHaveCount(0);
  const sidebar = page.getByTestId('catalog-sidebar'), filter = sidebar.getByRole('textbox', { name: 'Filter catalog' });
  await filter.fill('board-review');
  await expect(sidebar.getByRole('link', { name: 'Quarterly revenue', exact: true })).toBeVisible();
  await expect(sidebar.getByRole('link', { name: 'Unrelated query', exact: true })).toHaveCount(0);
  await filter.fill('directors');
  await expect(sidebar.getByRole('link', { name: 'Quarterly revenue', exact: true })).toBeVisible();
  await filter.fill('');
  await sidebar.getByRole('link', { name: 'Finance report library', exact: true }).click();
  const library = page.getByRole('region', { name: 'Worker report library', exact: true });
  await expect(library.getByRole('list', { name: 'Tags for Quarterly revenue' })).toContainText('board-review');
  await library.getByRole('button', { name: 'Filter by tag: board-review', exact: true }).click();
  await expect(library.getByRole('button', { name: 'Unrelated query', exact: true })).toHaveCount(0);
});

for (const browserName of ['chromium', 'webkit'] as const) test(`query history preserves the app, draft, results and SQL session in ${browserName}`, async ({ reporting, baseURL }) => {
  const browser = await ({ chromium, webkit })[browserName].launch();
  const context = await browser.newContext({ baseURL, viewport: { width: 1400, height: 1000 }, storageState: withExtensions() });
  const page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.addInitScript(({ url }) => sessionStorage.setItem('vgi.oauth.tokens.' + url, JSON.stringify({ access_token: 'test-alice', expires_at: Math.floor(Date.now() / 1000) + 3600, use_id_token: false })), { url: reporting.url });
    await page.goto(`?service=${encodeURIComponent(reporting.url)}`);
    await waitForShellBridge(page, 40_000);
    await page.getByTestId('tab-editor').click();
    await page.evaluate(() => { (window as any).__historyTest = 'same app'; });
    const editor = page.locator('.cm-content:visible'), run = page.getByRole('button', { name: 'Run', exact: true });
    await editor.fill('CREATE TEMP TABLE history_session AS SELECT 314159 AS retained');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const picker = page.getByRole('region', { name: 'Save destination' });
    await picker.getByLabel('Name', { exact: true }).fill(`History round trip ${browserName}`);
    await picker.getByRole('treeitem', { name: 'Finance report library', exact: true }).click();
    await picker.getByRole('button', { name: 'Save here' }).click();
    await expect(picker).not.toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
    await run.click();
    await expect(page.getByTestId('editor-running')).not.toBeVisible();
    await editor.fill('SELECT * FROM history_session'); await run.click();
    await expect(page.getByRole('table')).toContainText('314159');
    await editor.fill('SELECT retained + 1 AS edited FROM history_session');
    // First open exercises the lazy Library mount; subsequent opens use its listener.
    const hash = new URL(page.url()).hash;
    for (const mounted of [false, true]) {
      await page.getByRole('button', { name: 'Save options', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Version history', exact: true }).click();
      const history = page.getByRole('region', { name: 'Version history' });
      await expect(history).toContainText('Revision 1');
      await expect(history).toContainText('Changes are pending');
      expect(await page.evaluate(() => (window as any).__historyTest)).toBe('same app');
      expect(new URL(page.url()).hash).toBe(hash);
      if (mounted) await page.goBack();
      else await history.getByRole('button', { name: 'Back to document', exact: true }).click();
      await expect(page.getByTestId('tab-editor')).toHaveAttribute('aria-selected', 'true');
      await expect(editor).toContainText('retained + 1');
      await expect(page.getByRole('table')).toContainText('314159');
      await expect(page.getByTestId('editor-tabs').getByTestId('editor-tab')).toHaveCount(1);
      if (mounted) {
        await page.goForward(); await expect(history).toContainText('Revision 1');
        await page.goBack(); await expect(editor).toContainText('retained + 1');
      }
    }
    await run.click(); await expect(page.getByRole('table')).toContainText('314160');
    expect(await page.evaluate(() => (window as any).__historyTest)).toBe('same app');
    expect(errors).toEqual([]);
  } finally { await browser.close(); }
});

test('query name conflicts stay in the save form and a corrected name can be saved', async ({ page, reporting }) => {
  const client = reporting.client();
  const existing = await client.call('create_report', { request_id: crypto.randomUUID(), envelope: { title: 'Taken query name', description: '', tags: [], body_format: 'cupola.query/1', data_sources: [], parameters: [] }, body: new TextEncoder().encode('{"query":"SELECT 1"}') });
  await page.goto(`?service=${encodeURIComponent(reporting.url)}#token=test-alice`);
  await waitForShellBridge(page, 40_000);
  await page.getByTestId('tab-editor').click();
  await page.locator('.cm-content:visible').fill('SELECT 987 AS draft');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const picker = page.getByRole('region', { name: 'Save destination' });
  await picker.getByLabel('Name', { exact: true }).fill('  Taken query name  ');
  await picker.getByRole('treeitem', { name: 'Finance report library', exact: true }).click();
  await picker.getByRole('button', { name: 'Save here' }).click();
  await expect(picker.getByRole('alert')).toHaveText('A query with this name already exists in this folder. Choose a different name.');
  await expect(page.locator('.cm-content:visible')).toContainText('987');
  await picker.getByLabel('Name', { exact: true }).fill('  Corrected query name  ');
  await picker.getByRole('button', { name: 'Save here' }).click();
  await expect(picker).not.toBeVisible();
  const tabs = page.getByTestId('editor-tabs');
  await expect(tabs.getByRole('button', { name: 'Corrected query name', exact: true })).toBeVisible();
  await tabs.getByRole('button', { name: 'Corrected query name', exact: true }).dblclick();
  const name = tabs.getByRole('textbox', { name: 'Rename Corrected query name' });
  await name.fill('Taken query name'); await name.press('Enter');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(picker).not.toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'A query with this name already exists' })).toBeVisible();
  expect((await client.call('get_report', { report_id: existing.report_id })).revision_number).toBe(1n);
  expect((await client.call('list_reports', {})).filter(row => row.envelope?.title === 'Taken query name')).toHaveLength(1);
});

for (const kind of ['query', 'notebook'] as const) test(`${kind} opens without executing, saves unknown metadata, recovers a lost reply, and copies locally`, async ({ page, reporting }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const original = kind === 'query' ? { query: 'SELECT 424242 AS answer', context: {}, vendor: { keep: 7 } } : { version: 1, cells: [{ id: 'cell', type: 'sql', title: 'Query', source: 'SELECT 424242 AS answer', collapsed: false, charts: [], vendor: { keep: 9 } }], context: {}, vendor: { keep: 7 } };
  const record = await reporting.client().call('create_report', { request_id: crypto.randomUUID(), envelope: { title: `Portable ${kind}`, description: 'Reviewable', tags: ['shared'], body_format: `cupola.${kind}/1`, data_sources: [], parameters: [] }, body: new TextEncoder().encode(JSON.stringify(original)) });
  await page.addInitScript(({ url }) => sessionStorage.setItem('vgi.oauth.tokens.' + url, JSON.stringify({ access_token: 'test-alice', expires_at: Math.floor(Date.now() / 1000) + 3600, use_id_token: false })), { url: reporting.url });
  await page.goto(`reports?service=${encodeURIComponent(reporting.url)}&report_service=${encodeURIComponent(reporting.url)}&report_id=${record.report_id}#token=test-alice`);
  await waitForShellBridge(page, 40_000);
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await expect(save).toBeVisible({ timeout: 40_000 });
  await expect(page.locator('.cm-content').first()).toContainText('424242');
  expect(await page.getByText('Query completed', { exact: true }).count()).toBe(0);
  let drop = true;
  await page.route('**/commit_revision', async route => { const response = await route.fetch(); if (drop) { drop = false; await route.abort('failed'); } else await route.fulfill({ response }); });
  await page.locator('.cm-content').first().fill('SELECT 424243 AS answer');
  await save.click();
  await expect(page.getByRole('status').filter({ hasText: 'Save unconfirmed' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry pending save' })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Save status', exact: true }).click();
  await page.getByRole('button', { name: 'Retry pending save' }).click();
  await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
  const saved = await reporting.client().call('get_report', { report_id: record.report_id });
  expect(JSON.parse(new TextDecoder().decode(saved.body!)).vendor.keep).toBe(7);
  expect(await reporting.client().call('list_revisions', { report_id: record.report_id })).toHaveLength(2);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Save options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Version history', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Version history' })).toContainText('Revision 2');
  await page.getByRole('button', { name: 'Back to document', exact: true }).click();
  await page.getByRole('button', { name: 'Save options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Save a copy…', exact: true }).click();
  const destination = page.getByRole('region', { name: 'Save destination' });
  await destination.getByRole('treeitem', { name: 'Local', exact: true }).click();
  await destination.getByRole('button', { name: 'Save here' }).click();
  await expect(destination).not.toBeVisible();
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
  await page.getByRole('button', { name: 'Save options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Share', exact: true }).click();
  const link = page.getByRole('textbox', { name: 'Document link', exact: true });
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
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const picker = page.getByRole('region', { name: 'Save destination' });
  await picker.getByLabel('Name', { exact: true }).fill(`New shared ${kind}`);
  await picker.getByRole('treeitem', { name: 'Finance report library', exact: true }).click();
  await picker.getByRole('button', { name: 'Save here' }).click();
  await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
  const saved = (await reporting.client().call('list_reports', {})).find(r => r.envelope?.title === `New shared ${kind}`)!;
  expect(saved).toBeDefined();
  const result = await reporting.client().call('get_report', { report_id: saved.report_id });
  expect(result.envelope?.data_sources.some(s => s.catalog_name === 'yfinance')).toBe(true);
  await page.goto(`reports?service=${encodeURIComponent(reporting.url)}&report_service=${encodeURIComponent(reporting.url)}&report_id=${saved.report_id}`);
  await expect(page.locator('.cm-content').first()).toContainText('1717');
});

for (const kind of ['query', 'notebook'] as const) test(`${kind} adopts a clean newer revision and preserves a conflicting draft`, async ({ page, reporting }) => {
  const client = reporting.client();
  const body = (sql: string) => new TextEncoder().encode(JSON.stringify(kind === 'query' ? { query: sql, context: {} } : { version: 1, cells: [{ id: 'cell', type: 'sql', title: 'Query', source: sql, collapsed: false, charts: [] }], context: {} }));
  let record = await client.call('create_report', { request_id: crypto.randomUUID(), envelope: { title: `Reopen ${kind}`, description: '', tags: [], body_format: `cupola.${kind}/1`, data_sources: [], parameters: [] }, body: body('SELECT 111 AS answer') });
  await page.addInitScript(({ url }) => sessionStorage.setItem('vgi.oauth.tokens.' + url, JSON.stringify({ access_token: 'test-alice', expires_at: Math.floor(Date.now() / 1000) + 3600, use_id_token: false })), { url: reporting.url });
  await page.goto(`reports?service=${encodeURIComponent(reporting.url)}&report_service=${encodeURIComponent(reporting.url)}&report_id=${record.report_id}`);
  await expect(page.locator('.cm-content').first()).toContainText('111', { timeout: 40_000 });
  record = await client.call('commit_revision', { request_id: crypto.randomUUID(), report_id: record.report_id, expected_revision_id: record.head_revision_id, envelope: record.envelope!, body: body('SELECT 222 AS answer') });
  await page.reload();
  await expect(page.locator('.cm-content').first()).toContainText('222', { timeout: 40_000 });
  await page.locator('.cm-content').first().fill('SELECT 333 AS answer');
  await expect(page.getByRole('status').filter({ hasText: 'Changes to save' })).toBeVisible();
  if (kind === 'query') {
    await page.getByRole('button', { name: 'Save options', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Data sources…' }).click();
    const sources = page.getByRole('dialog', { name: 'Data sources' });
    await sources.getByRole('button', { name: 'Apply to draft' }).click();
  }
  record = await client.call('commit_revision', { request_id: crypto.randomUUID(), report_id: record.report_id, expected_revision_id: record.head_revision_id, envelope: record.envelope!, body: body('SELECT 444 AS answer') });
  await page.reload();
  await expect(page.locator('.cm-content').first()).toContainText('333', { timeout: 40_000 });
  const conflict = page.getByRole('region', { name: 'Newer version available' });
  await expect(conflict).toBeVisible();
  await conflict.getByRole('button', { name: 'Compare versions' }).click();
  await expect(conflict).toContainText('SELECT 444');
  await expect(conflict).toContainText('SELECT 333');
  page.once('dialog', dialog => dialog.accept());
  await conflict.getByRole('button', { name: 'Load latest version' }).click();
  await expect(page.locator('.cm-content').first()).toContainText('444', { timeout: 40_000 });
  await expect(conflict).not.toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
  await page.locator('.cm-content').first().fill('SELECT 555 AS answer');
  await page.locator('.cm-content').first().press('ControlOrMeta+s');
  await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
  const saved = await client.call('get_report', { report_id: record.report_id });
  expect(new TextDecoder().decode(saved.body!)).toContain('SELECT 555');
  await page.locator('.cm-content').first().fill('SELECT 666 AS answer');
  await expect(page.getByRole('status').filter({ hasText: 'Changes to save' })).toBeVisible();
});

test('saved queries keep temporary tables across runs and do not offer scheduling', async ({ page, reporting }) => {
  const record = await reporting.client().call('create_report', { request_id: crypto.randomUUID(), envelope: { title: 'Session query', description: '', tags: [], body_format: 'cupola.query/1', data_sources: [], parameters: [] }, body: new TextEncoder().encode(JSON.stringify({ query: 'CREATE TEMP TABLE retained AS SELECT 123456 AS value', context: {} })) });
  await page.goto(`reports?service=${encodeURIComponent(reporting.url)}&report_service=${encodeURIComponent(reporting.url)}&report_id=${record.report_id}#token=test-alice`);
  await waitForShellBridge(page, 40_000);
  const run = page.getByRole('button', { name: 'Run', exact: true });
  await expect(run).toBeEnabled({ timeout: 40_000 }); await run.click();
  await expect(page.getByTestId('editor-running')).not.toBeVisible();
  await page.locator('.cm-content').first().fill('SELECT * FROM retained');
  await run.click();
  await expect(page.getByRole('table')).toContainText('123456');
  await page.goto(`reports?service=${encodeURIComponent(reporting.url)}&report_service=${encodeURIComponent(reporting.url)}&report_id=${record.report_id}&report_view=schedules#token=test-alice`);
  await expect(page.getByRole('region', { name: 'Scheduling is for reports' })).toBeVisible();
});

test('new notebook keeps edits made while its first named save is in flight', async ({ page, reporting }) => {
  await page.addInitScript(({ url }) => sessionStorage.setItem('vgi.oauth.tokens.' + url, JSON.stringify({ access_token: 'test-alice', expires_at: Math.floor(Date.now() / 1000) + 3600, use_id_token: false })), { url: reporting.url });
  await page.goto(`notebooks?service=${encodeURIComponent(reporting.url)}`);
  await waitForShellBridge(page, 40_000);
  await page.getByTestId('notebook-library').getByRole('button', { name: 'New notebook', exact: true }).click();
  await page.locator('.cm-content').first().fill('SELECT 100');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const picker = page.getByRole('region', { name: 'Save destination' });
  await picker.getByLabel('Name', { exact: true }).fill('Slow first save');
  await picker.getByRole('treeitem', { name: 'Finance report library', exact: true }).click();
  let release!: () => void, started!: () => void;
  const hold = new Promise<void>(r => { release = r; }), entered = new Promise<void>(r => { started = r; });
  await page.route('**/create_object', async route => { started(); await hold; await route.continue(); });
  await picker.getByRole('button', { name: 'Save here' }).click();
  try { await entered; await page.locator('.cm-content').first().fill('SELECT 200'); } finally { release(); }
  await expect(picker).not.toBeVisible();
  await expect(page.locator('.cm-content').first()).toContainText('SELECT 200');
  await expect(page.getByRole('textbox', { name: 'Notebook title' })).toHaveValue('Slow first save');
  await expect(page.getByRole('status').filter({ hasText: 'Changes to save' })).toBeVisible();
  await page.locator('.cm-content').first().press('ControlOrMeta+s');
  await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
});

for (const browserName of ['chromium', 'webkit'] as const) test(`Library editor layout in ${browserName}: toolbar save and narrow keyboard picker`, async ({ reporting, baseURL }) => {
    const browser = await ({ chromium, webkit })[browserName].launch();
    const context = await browser.newContext({ baseURL, viewport: { width: 900, height: 900 }, storageState: withExtensions() });
    const page = await context.newPage();
    try {
    await page.goto(`?service=${encodeURIComponent(reporting.url)}#token=test-alice`);
    await waitForShellBridge(page, 40_000);
    await page.getByTestId('tab-editor').click();
    await page.locator('.cm-content').first().fill('SELECT 77');
    const save = page.getByRole('button', { name: 'Save', exact: true }), run = page.getByRole('button', { name: 'Run', exact: true });
    expect(Math.abs((await save.boundingBox())!.y - (await run.boundingBox())!.y)).toBeLessThan(4);
    const editorBefore = await page.locator('.cm-editor').first().boundingBox();
    await save.click();
    const picker = page.getByRole('region', { name: 'Save destination' });
    await expect(picker).toBeVisible();
    expect((await page.locator('.cm-editor').first().boundingBox())!.y).toBe(editorBefore!.y);
    await picker.getByLabel('Name', { exact: true }).fill(`Keyboard ${browserName}`);
    await picker.getByLabel('Name', { exact: true }).press('Enter');
    await expect(picker).not.toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
    await page.setViewportSize({ width: 414, height: 850 });
    await page.getByRole('button', { name: 'Save options', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Save a copy…', exact: true }).click();
    await expect(picker).toBeVisible();
    const bounds = (await picker.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(414);
    await page.screenshot({ path: `/tmp/cupola-library-${browserName}-414.png` });
    } finally { await browser.close(); }
});

for (const kind of ['query', 'notebook'] as const) test(`an unsaved ${kind} runs with its chosen draft sources`, async ({ page, reporting }) => {
  await page.addInitScript(({ url }) => sessionStorage.setItem('vgi.oauth.tokens.' + url, JSON.stringify({ access_token: 'test-alice', expires_at: Math.floor(Date.now() / 1000) + 3600, use_id_token: false })), { url: reporting.url });
  await page.goto(`${kind === 'notebook' ? 'notebooks' : ''}?service=${encodeURIComponent(reporting.url)}`);
  await waitForShellBridge(page, 40_000);
  if (kind === 'query') await page.getByTestId('tab-editor').click();
  else await page.getByTestId('notebook-library').getByRole('button', { name: 'New notebook', exact: true }).click();
  await page.locator('.cm-content').first().fill('SELECT current_database() AS chosen_catalog');
  await page.getByRole('button', { name: 'Save options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Data sources…' }).click();
  const sources = page.getByRole('dialog', { name: 'Data sources' });
  await sources.getByLabel('Default catalog', { exact: true }).selectOption('');
  await expect(sources.getByLabel('Default schema', { exact: true })).toBeDisabled();
  await sources.getByRole('button', { name: 'Apply to draft' }).click();
  await page.getByRole('button', { name: kind === 'query' ? 'Run' : 'Run all', exact: true }).click();
  await expect(page.getByRole('table')).toContainText('memory');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const picker = page.getByRole('region', { name: 'Save destination' });
  await picker.getByLabel('Name', { exact: true }).fill(`Memory ${kind}`);
  await picker.getByRole('treeitem', { name: 'Finance report library', exact: true }).click();
  await picker.getByRole('button', { name: 'Save here' }).click();
  await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
  const saved = (await reporting.client().call('list_reports', {})).find(r => r.envelope?.title === `Memory ${kind}`)!;
  const record = await reporting.client().call('get_report', { report_id: saved.report_id });
  expect(JSON.parse(new TextDecoder().decode(record.body!)).context).toEqual({ default_source_alias: null, default_schema: null });
});

test('Library New and sidebar New create all supported document types', async ({ page, reporting }) => {
  await page.addInitScript(({ url }) => sessionStorage.setItem('vgi.oauth.tokens.' + url, JSON.stringify({ access_token: 'test-alice', expires_at: Math.floor(Date.now() / 1000) + 3600, use_id_token: false })), { url: reporting.url });
  await page.goto(`reports?service=${encodeURIComponent(reporting.url)}&report_service=${encodeURIComponent(reporting.url)}`);
  for (const kind of ['query', 'notebook'] as const) {
    const library = page.getByRole('region', { name: 'Worker report library', exact: true });
    await library.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByRole('menuitem', { name: `New ${kind}`, exact: true }).click();
    await expect(page.getByTestId(kind === 'query' ? 'sql-editor-view' : 'notebook-workspace')).toBeVisible();
    await page.getByTestId('catalog-sidebar').getByRole('link', { name: 'Finance report library', exact: true }).click();
  }
  const rows = await reporting.client().call('list_reports', {});
  expect(rows.filter(r => ['cupola.query/1', 'cupola.notebook/1'].includes(r.envelope?.body_format ?? '')).length).toBeGreaterThanOrEqual(2);
  await page.getByRole('navigation', { name: 'Saved library' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('menuitem', { name: 'New query', exact: true }).click();
  await expect(page.getByTestId('sql-editor-view')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('report_service')).toBe('local');
});

for (const browserName of ['chromium', 'webkit'] as const) test(`saved queries use ordinary tabs and rename in ${browserName}`, async ({ reporting, baseURL }) => {
  const client = reporting.client();
  const query = await client.call('create_report', { request_id: crypto.randomUUID(), envelope: { title: `Tabbed ${browserName}`, description: 'Keep this description', tags: ['tabs'], body_format: 'cupola.query/1', data_sources: [], parameters: [] }, body: new TextEncoder().encode(JSON.stringify({ query: 'SELECT 246 AS saved_value', context: {}, vendor: { keep: true } })) });
  const browser = await ({ chromium, webkit })[browserName].launch();
  const context = await browser.newContext({ baseURL, viewport: { width: 1400, height: 1000 }, storageState: withExtensions() });
  const page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.addInitScript(({ url }) => sessionStorage.setItem('vgi.oauth.tokens.' + url, JSON.stringify({ access_token: 'test-alice', expires_at: Math.floor(Date.now() / 1000) + 3600, use_id_token: false })), { url: reporting.url });
    await page.goto(`?service=${encodeURIComponent(reporting.url)}`);
    await waitForShellBridge(page, 40_000);
    await page.getByTestId('tab-editor').click();
    await page.locator('.cm-content:visible').fill('SELECT 13579 AS scratch');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.getByRole('table')).toContainText('13579');
    const sidebar = page.getByTestId('catalog-sidebar');
    await sidebar.getByRole('button', { name: 'Expand Finance report library', exact: true }).click();
    await sidebar.getByRole('link', { name: `Tabbed ${browserName}`, exact: true }).click();
    await expect(page.getByTestId('tab-editor')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.cm-content:visible')).toContainText('246');
    const tabs = page.getByTestId('editor-tabs');
    await expect(tabs.getByTestId('editor-tab')).toHaveCount(2);
    await sidebar.getByRole('link', { name: `Tabbed ${browserName}`, exact: true }).click();
    await expect(page.getByTestId('tab-editor')).toHaveAttribute('aria-selected', 'true');
    await expect(tabs.getByTestId('editor-tab')).toHaveCount(2);
    await tabs.getByRole('button', { name: `Tabbed ${browserName}`, exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename…', exact: true }).click();
    const name = tabs.getByRole('textbox', { name: `Rename Tabbed ${browserName}` });
    await name.fill(`Renamed ${browserName}`); await name.press('Enter');
    await page.locator('.cm-content:visible').press('ControlOrMeta+s');
    await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
    const saved = await client.call('get_report', { report_id: query.report_id });
    expect(saved.envelope?.title).toBe(`Renamed ${browserName}`);
    expect(saved.envelope?.description).toBe('Keep this description');
    expect(JSON.parse(new TextDecoder().decode(saved.body!)).vendor.keep).toBe(true);
    await tabs.getByRole('button', { name: 'Query 1', exact: true }).click();
    await expect(page.locator('.cm-content:visible')).toContainText('13579');
    await expect(page.getByRole('table')).toContainText('13579');
    await tabs.getByRole('button', { name: `Renamed ${browserName}`, exact: true }).click();
    await page.locator('.cm-content:visible').fill('SELECT 9876 AS recovery');
    await tabs.getByRole('button', { name: `Close Renamed ${browserName}`, exact: true }).click();
    const close = page.getByTestId('editor-close-confirm');
    await expect(close).toContainText('does not delete the saved query');
    await close.getByRole('button', { name: 'Close tab', exact: true }).click();
    await expect(tabs.getByTestId('editor-tab')).toHaveCount(1);
    await sidebar.getByRole('link', { name: `Renamed ${browserName}`, exact: true }).click();
    await expect(page.locator('.cm-content:visible')).toContainText('9876');
    await expect(tabs.getByTestId('editor-tab')).toHaveCount(2);
    await page.getByTestId('tab-reports').click();
    await expect(page.getByTestId('tab-reports')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('status').filter({ hasText: 'Opening document…' })).not.toBeVisible();
    await page.getByTestId('tab-editor').click();
    await expect(page.locator('.cm-content:visible')).toContainText('9876');
    await page.reload();
    await expect(page.locator('.cm-content:visible')).toContainText('9876');
    await expect(page.getByTestId('editor-tabs').getByTestId('editor-tab')).toHaveCount(2);
    expect(errors).toEqual([]);
    await page.screenshot({ path: `/tmp/cupola-query-tabs-${browserName}.png` });
  } finally { await browser.close(); }
});

test('saved notebooks open in Notebooks with an editable title and normal navigation', async ({ page, reporting }) => {
  const client = reporting.client();
  const record = await client.call('create_report', { request_id: crypto.randomUUID(), envelope: { title: 'Ordinary saved notebook', description: '', tags: [], body_format: 'cupola.notebook/1', data_sources: [], parameters: [] }, body: new TextEncoder().encode(JSON.stringify({ version: 1, cells: [{ id: 'cell', type: 'sql', title: 'Query', source: 'SELECT 808', collapsed: false, charts: [] }], context: {} })) });
  await page.goto(`reports?service=${encodeURIComponent(reporting.url)}&report_service=${encodeURIComponent(reporting.url)}&report_id=${record.report_id}#token=test-alice`);
  await expect(page.getByTestId('tab-notebooks')).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('textbox', { name: 'Notebook title', exact: true }).fill('Renamed notebook');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
  expect((await client.call('get_report', { report_id: record.report_id })).envelope?.title).toBe('Renamed notebook');
  await page.getByRole('button', { name: 'Notebooks', exact: true }).click();
  await expect(page.getByTestId('notebook-library')).toBeVisible();
});
