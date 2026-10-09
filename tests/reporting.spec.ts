import { test as base, expect, type Page } from '@playwright/test';
import { startReportingWorker } from './reporting/worker';
import { report } from './reporting/fixtures';
import { encodeReport } from '../src/lib/reporting/body';
import { replaceEditorText } from './helpers';

const test = base.extend<{}, { reporting: Awaited<ReturnType<typeof startReportingWorker>> }>({
  reporting: [async ({}, use) => { const worker = await startReportingWorker(); try { await use(worker); } finally { await worker.stop(); } }, { scope: 'worker' }],
});
test.use({ viewport: { width: 1600, height: 1150 } });
test.setTimeout(180_000);
const path = (url: string, id?: string, token: string | null = 'test-alice') => `reports?service=${encodeURIComponent(url)}&report_service=${encodeURIComponent(url)}${id ? `&report_id=${id}` : ''}${token ? `#token=${token}` : ''}`;
async function edit(page: Page) { await page.getByRole('button', { name: 'Edit report', exact: true }).click(); }
async function saved(page: Page) { await expect(page.getByRole('status', { name: 'Save status', exact: true })).toHaveText('Saved to worker', { timeout: 15_000 }); }
async function seed(reporting: Awaited<ReturnType<typeof startReportingWorker>>, title: string) {
  const { envelope, body } = encodeReport(report(title), { description: '', tags: [] });
  return reporting.client().call('create_report', { request_id: crypto.randomUUID(), envelope, body });
}

test('folder hierarchy, editing, rendering, worker history and a portable published link', async ({ page, browser, reporting }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(path(reporting.url));
  const library = page.getByRole('region', { name: 'Worker report library', exact: true });
  await expect(library.getByRole('heading', { name: 'Finance report library' })).toBeVisible();
  await library.getByRole('button', { name: 'New folder', exact: true }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Investments');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await library.getByRole('button', { name: 'Investments', exact: true }).click();
  await library.getByRole('button', { name: 'New folder', exact: true }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Quarterly');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await library.getByRole('button', { name: 'Quarterly', exact: true }).click();
  const tree = library.getByRole('tree', { name: 'Report folders and locations' });
  const quarterly = tree.getByRole('treeitem', { name: 'Quarterly', exact: true });
  await expect(quarterly).toHaveAttribute('aria-selected', 'true');
  await quarterly.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(tree.getByRole('treeitem', { name: 'Investments', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(quarterly).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(quarterly).toBeFocused();
  await library.getByRole('button', { name: 'New report', exact: true }).click();
  await edit(page);
  await page.getByRole('textbox', { name: 'Report title', exact: true }).fill('Quarterly finance');
  await page.getByRole('tab', { name: 'Code', exact: true }).click();
  await replaceEditorText(page.getByRole('textbox', { name: 'Evidence source', exact: true }), report().source);
  await saved(page);
  const id = new URL(page.url()).searchParams.get('report_id')!;
  const c = reporting.client();
  expect((await c.call('get_report', { report_id: id })).envelope!.title).toBe('Quarterly finance');
  await expect(page.getByText('Refresh to render this report.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Update preview', exact: true }).click();
  await expect(page.getByTestId('evidence-document')).toContainText('42', { timeout: 120_000 });
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Revision 1');
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('region', { name: 'Worker report', exact: true }).getByRole('button', { name: 'Move', exact: true }).click();
  await page.getByRole('dialog').getByRole('treeitem', { name: 'Finance report library', exact: true }).click();
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.getByRole('button', { name: 'Publish revision', exact: true }).click();
  await expect.poll(async () => (await c.call('get_report', { report_id: id })).published_revision_id).not.toBeNull();
  await page.getByRole('button', { name: 'Share link', exact: true }).click();
  const link = await page.getByRole('textbox', { name: 'Report link', exact: true }).inputValue();
  expect(link).not.toContain('token'); expect(link).not.toContain('local_ws');
  const context = await browser.newContext();
  try {
    const reader = await context.newPage(); await reader.goto(link);
    await expect(reader.getByRole('button', { name: 'Edit report', exact: true })).toBeDisabled();
    await expect(reader.getByRole('status', { name: 'Save status', exact: true })).toHaveText('Read-only worker revision');
    await expect(reader.getByRole('button', { name: 'Publish revision', exact: true })).toHaveCount(0);
    expect((await reporting.client(null).call('get_report', { report_id: id })).envelope!.title).toBe('Quarterly finance');
  } finally { await context.close(); }
  expect(errors).toEqual([]);
});

test('an interrupted admitted save preserves newer edits and retries without duplicate revisions', async ({ page, reporting }) => {
  const initial = await seed(reporting, 'Interrupted browser save');
  await page.goto(path(reporting.url, initial.report_id)); await edit(page);
  let drop = true;
  await page.route('**/commit_revision', async route => {
    const response = await route.fetch();
    if (drop) { drop = false; await route.abort('failed'); } else await route.fulfill({ response });
  });
  await page.getByRole('textbox', { name: 'Report title', exact: true }).fill('First edit');
  await expect(page.getByRole('button', { name: 'Retry save', exact: true })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('textbox', { name: 'Report title', exact: true }).fill('Newer typing');
  await page.waitForTimeout(1700); // Let the autosave boundary queue this second edit.
  await page.getByRole('button', { name: 'Retry save', exact: true }).click();
  await saved(page);
  const c = reporting.client();
  expect((await c.call('get_report', { report_id: initial.report_id })).envelope!.title).toBe('Newer typing');
  expect(await c.call('list_revisions', { report_id: initial.report_id })).toHaveLength(3);
});

test('concurrent edits keep the losing draft and let the author save it as a new report', async ({ page, reporting }) => {
  const initial = await seed(reporting, 'Concurrent report'), c = reporting.client();
  await page.goto(path(reporting.url, initial.report_id)); await edit(page);
  await c.call('commit_revision', { request_id: crypto.randomUUID(), report_id: initial.report_id, expected_revision_id: initial.head_revision_id, envelope: { ...initial.envelope!, title: 'Other author won' }, body: initial.body! });
  await page.getByRole('textbox', { name: 'Report title', exact: true }).fill('My unsaved draft');
  await expect(page.getByRole('alert')).toContainText('changed on the worker', { timeout: 15_000 });
  await expect(page.getByRole('textbox', { name: 'Report title', exact: true })).toHaveValue('My unsaved draft');
  await page.getByRole('button', { name: 'Save draft as a copy', exact: true }).click();
  await saved(page);
  const copyId = new URL(page.url()).searchParams.get('report_id')!;
  expect(copyId).not.toBe(initial.report_id);
  expect((await c.call('get_report', { report_id: copyId })).envelope!.title).toBe('My unsaved draft (copy)');
  expect((await c.call('get_report', { report_id: initial.report_id })).envelope!.title).toBe('Other author won');
});

test('revoked access refuses saves without discarding the draft', async ({ page, reporting }) => {
  const initial = await seed(reporting, 'Permission change');
  await page.goto(path(reporting.url, initial.report_id)); await edit(page);
  await reporting.client('test-admin').call('set_ownership', { request_id: crypto.randomUUID(), report_id: initial.report_id, expected_version: initial.version, ownership: { owner_ref: { kind: 'principal', id: 'bob', display_name: '' }, parent_owner_ref: null } });
  await page.getByRole('textbox', { name: 'Report title', exact: true }).fill('Preserve after revoke');
  await expect(page.getByRole('alert')).toContainText('access has changed', { timeout: 15_000 });
  await expect(page.getByRole('textbox', { name: 'Report title', exact: true })).toHaveValue('Preserve after revoke');
  await expect(page.getByRole('button', { name: 'Export draft', exact: true })).toBeVisible();
  expect((await reporting.client('test-bob').call('get_report', { report_id: initial.report_id })).envelope!.title).toBe('Permission change');
  expect(await page.evaluate(() => Object.keys(localStorage).some(k => k.startsWith('cupola.reporting.draft.v1:') && localStorage.getItem(k)?.includes('Preserve after revoke')))).toBe(true);
});

test('restores immutable history, redacts an eligible revision, and transfers ownership', async ({ page, reporting }) => {
  const first = await seed(reporting, 'Original revision'), c = reporting.client();
  await c.call('commit_revision', { request_id: crypto.randomUUID(), report_id: first.report_id, expected_revision_id: first.head_revision_id, envelope: { ...first.envelope!, title: 'Later revision' }, body: first.body! });
  await page.goto(path(reporting.url, first.report_id));
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Restore revision 1', exact: true }).click();
  await saved(page);
  await expect.poll(async () => (await c.call('get_report', { report_id: first.report_id })).revision_number).toBe(3n);
  expect((await c.call('list_revisions', { report_id: first.report_id }))[0].kind).toBe('restore');
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Redact revision 2…', exact: true }).click();
  await page.getByRole('textbox', { name: 'Reason', exact: true }).fill('Remove superseded information');
  await page.getByRole('button', { name: 'Redact permanently', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Report history', exact: true })).toContainText('Redacted: Remove superseded information');
  await page.getByRole('dialog', { name: 'Report history', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Ownership', exact: true }).click();
  await page.getByRole('textbox', { name: 'Owner ID', exact: true }).fill('bob');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Worker report library', exact: true })).toBeVisible();
  const transferred = await reporting.client('test-bob').call('get_report', { report_id: first.report_id });
  expect(transferred.ownership.owner_ref.id).toBe('bob'); expect(transferred.created_by.id).toBe('alice');
});

test('a recovery draft survives a page reload and resumes its original pending request', async ({ page, reporting }) => {
  const first = await seed(reporting, 'Recovery across reload');
  // Simulate the existing per-service OAuth session store, so a reload retains authentication.
  await page.addInitScript(({ url }) => sessionStorage.setItem('vgi.oauth.tokens.' + url, JSON.stringify({ access_token: 'test-alice', expires_at: Math.floor(Date.now() / 1000) + 3600, use_id_token: false })), { url: reporting.url });
  await page.goto(path(reporting.url, first.report_id)); await edit(page);
  await page.route('**/commit_revision', route => route.abort('failed'));
  await page.getByRole('textbox', { name: 'Report title', exact: true }).fill('Durable browser draft');
  await expect(page.getByRole('button', { name: 'Retry save', exact: true })).toBeVisible({ timeout: 15_000 });
  await page.unroute('**/commit_revision');
  page.on('dialog', dialog => dialog.accept());
  await page.reload();
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  const recovered = page.getByRole('region', { name: 'Recovered worker drafts', exact: true });
  await expect(recovered).toContainText('Durable browser draft');
  await recovered.getByRole('button', { name: 'Review draft', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Recovered draft');
  await page.getByRole('button', { name: 'Retry save', exact: true }).click();
  await saved(page);
  expect((await reporting.client().call('get_report', { report_id: first.report_id })).envelope!.title).toBe('Durable browser draft');
  expect(await reporting.client().call('list_revisions', { report_id: first.report_id })).toHaveLength(2);
});

test('switching libraries flushes a local edit before its autosave timer fires', async ({ page, reporting }) => {
  await page.addInitScript(({ url, document }) => {
    const r = { ...document, serviceUrl: url };
    localStorage.setItem(`cupola.evidence.report.v2:${encodeURIComponent(url)}:${r.id}`, JSON.stringify(r));
  }, { url: reporting.url, document: report('Local report') });
  await page.goto(`reports?service=${encodeURIComponent(reporting.url)}&report_service=local&evidence_report=local-report#token=test-alice`);
  await edit(page);
  await expect(page.getByRole('tree', { name: 'Report folders and locations' })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Report title', exact: true }).fill('Keep this local edit');
  await page.getByRole('button', { name: 'Saved reports', exact: true }).click();
  await page.getByRole('tree', { name: 'Report folders and locations' }).getByRole('treeitem', { name: 'Finance report library', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Worker report library', exact: true })).toBeVisible();
  await page.getByRole('tree', { name: 'Report folders and locations' }).getByRole('treeitem', { name: 'On this device', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Report browser', exact: true }).getByRole('button', { name: 'Keep this local edit', exact: true })).toBeVisible();
});

test('report details wait for autosave and preserve the current definition', async ({ page, reporting }) => {
  const initial = await seed(reporting, 'Before details');
  await page.goto(path(reporting.url, initial.report_id)); await edit(page);
  const details = page.getByRole('button', { name: 'Report details', exact: true });
  await page.getByRole('textbox', { name: 'Report title', exact: true }).fill('Editor change');
  await expect(details).toBeDisabled();
  await saved(page);
  await details.click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Updated details');
  await page.getByRole('textbox', { name: 'Description', exact: true }).fill('Description from details');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await saved(page);
  const latest = await reporting.client().call('get_report', { report_id: initial.report_id });
  expect(latest.envelope!.title).toBe('Updated details');
  expect(latest.envelope!.description).toBe('Description from details');
  expect(JSON.parse(new TextDecoder().decode(latest.body!)).document.source).toBe(report().source);
  await page.getByRole('button', { name: 'View source', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Report source' })).toContainText('42');
});

test('read-only worker explains permissions and still allows local reports and folders', async ({ page, reporting }) => {
  await page.goto(path(reporting.url, undefined, null));
  const library = page.getByRole('region', { name: 'Worker report library', exact: true });
  await expect(library).toContainText('Read-only location');
  await expect(library.getByRole('button', { name: 'New folder', exact: true })).toBeDisabled();
  await library.getByRole('button', { name: 'New report', exact: true }).click();
  await page.getByRole('textbox', { name: 'Report title', exact: true }).fill('Local without worker permission');
  await expect(page.getByRole('status', { name: 'Save status' })).toHaveText('Saved in this browser', { timeout: 15000 });
  await page.getByRole('button', { name: 'Saved reports', exact: true }).click();
  const browser = page.getByRole('region', { name: 'Report browser' });
  await expect(browser.getByRole('button', { name: 'Local without worker permission', exact: true })).toBeVisible();
  await browser.getByRole('button', { name: 'New folder', exact: true }).click();
  await page.getByRole('dialog').getByRole('textbox', { name: 'Name', exact: true }).fill('Drafts');
  await page.getByRole('dialog').getByRole('button', { name: 'Create folder' }).click();
  await expect(browser.getByRole('button', { name: 'Drafts', exact: true })).toBeVisible();
  expect(await reporting.client().call('list_reports', { query: 'Local without worker permission' })).toHaveLength(0);
  await browser.getByRole('row').filter({ has: page.getByRole('button', { name: 'Local without worker permission', exact: true }) }).getByRole('button', { name: 'Move to…', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('treeitem', { name: 'Finance report library', exact: true }).click();
  await expect(dialog).toContainText('Read-only destination');
  await expect(dialog.getByRole('button', { name: 'Move report', exact: true })).toBeDisabled();
  await dialog.getByRole('treeitem', { name: 'On this device', exact: true }).click();
  await dialog.getByRole('button', { name: 'Expand On this device', exact: true }).click();
  await dialog.getByRole('treeitem', { name: 'Drafts', exact: true }).click();
  await dialog.getByRole('button', { name: 'Move report', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(browser.getByRole('navigation', { name: 'Local report folders' })).toContainText('Drafts');
  await expect(browser.getByRole('button', { name: 'Local without worker permission', exact: true })).toBeVisible();
});

test('move local to worker, then copy and move back without resurrecting the local original', async ({ page, reporting }) => {
  await page.goto(`reports?service=${encodeURIComponent(reporting.url)}#token=test-alice`);
  await page.getByRole('region', { name: 'Report browser' }).getByRole('button', { name: 'New report', exact: true }).click();
  await page.getByRole('textbox', { name: 'Report title', exact: true }).fill('Portable report');
  await page.getByRole('button', { name: 'Move to…', exact: true }).click(); // Flush even before autosave fires.
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('treeitem', { name: 'Finance report library', exact: true }).click();
  await dialog.getByRole('button', { name: 'Move report', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const workerReport = (await reporting.client().call('list_reports', { query: 'Portable report' }))[0];
  expect(workerReport.envelope?.title).toBe('Portable report');
  const locations = page.getByRole('tree', { name: 'Report folders and locations' });
  await locations.getByRole('treeitem', { name: 'On this device', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Report browser' }).getByRole('button', { name: 'Portable report', exact: true })).toHaveCount(0);
  await locations.getByRole('treeitem', { name: 'All reports', exact: true }).click();
  const row = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'Portable report', exact: true }) });
  await row.getByRole('button', { name: 'Copy to…', exact: true }).click();
  await dialog.getByRole('button', { name: 'Copy report', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Report browser' }).getByRole('button', { name: 'Portable report', exact: true })).toBeVisible();
  expect((await reporting.client().call('get_report', { report_id: workerReport.report_id })).envelope?.title).toBe('Portable report');
  await locations.getByRole('treeitem', { name: 'Finance report library', exact: true }).click();
  await page.getByRole('row').filter({ has: page.getByRole('button', { name: 'Portable report', exact: true }) }).getByRole('button', { name: 'Move to…', exact: true }).click();
  await dialog.getByRole('button', { name: 'Move report', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await reporting.client().call('list_reports', { query: 'Portable report' })).toHaveLength(0);
});

test('combines named workers, tolerates an unavailable location, and moves between workers', async ({ page, reporting }) => {
  const second = await startReportingWorker('Research reports');
  try {
    const source = await seed(reporting, 'Across workers');
    const other = await seed(second, 'Other worker report');
    await page.addInitScript(({ urls }) => {
      for (const url of urls) sessionStorage.setItem('vgi.oauth.tokens.' + url, JSON.stringify({ access_token: 'test-alice', expires_at: Date.now() / 1000 + 3600 }));
    }, { urls: [reporting.url, second.url] });
    await page.goto(`reports?service=${encodeURIComponent(reporting.url)}`);
    await page.getByTestId('workspace-picker').click();
    await page.getByTestId('attach-catalog-open').click();
    const form = page.getByTestId('attach-catalog-form');
    await form.getByTestId('attach-catalog-url').fill(second.url);
    await expect(form.getByTestId('attach-catalog-choices')).toBeVisible();
    await form.getByTestId('attach-catalog-submit').click();
    await expect(form).toBeHidden();
    await page.keyboard.press('Escape');
    const browser = page.getByRole('region', { name: 'Report browser' });
    await expect(browser.getByRole('button', { name: 'Across workers', exact: true })).toBeVisible();
    await expect(browser.getByRole('button', { name: 'Other worker report', exact: true })).toBeVisible();
    await expect(browser.getByRole('treeitem', { name: 'Research reports', exact: true })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Report locations' })).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'Report library', exact: true })).toHaveCount(0);
    await browser.getByRole('row').filter({ has: page.getByRole('button', { name: 'Across workers', exact: true }) }).getByRole('button', { name: 'Move to…', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('treeitem', { name: 'Research reports', exact: true }).click();
    await dialog.getByRole('button', { name: 'Move report', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(await reporting.client().call('list_reports', { query: 'Across workers' })).toHaveLength(0);
    const copied = (await second.client().call('list_reports', { query: 'Across workers' }))[0];
    expect(copied.report_id).not.toBe(source.report_id); expect(copied.published_revision_id).toBeNull();
    expect((await second.client().call('get_report', { report_id: other.report_id })).envelope?.title).toBe('Other worker report');
    await page.route(reporting.url + '/**', route => route.request().url().includes('vgi.reports.v1') ? route.abort() : route.continue());
    await page.getByRole('tree', { name: 'Report folders and locations' }).getByRole('treeitem', { name: 'All reports', exact: true }).click();
    await browser.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(browser.getByRole('button', { name: 'Other worker report', exact: true })).toBeVisible();
    await expect(browser.getByRole('alert').first()).toBeVisible();
    await expect(browser.getByRole('button', { name: 'New report', exact: true })).toBeEnabled();
  } finally { await second.stop(); }
});

test('interrupted transfer survives reload and retries the original copy once', async ({ page, reporting }) => {
  await page.addInitScript(({ url }) => {
    sessionStorage.setItem('vgi.oauth.tokens.' + url, JSON.stringify({ access_token: 'test-alice', expires_at: Date.now() / 1000 + 3600 }));
  }, { url: reporting.url });
  await page.goto(`reports?service=${encodeURIComponent(reporting.url)}`);
  await page.getByRole('region', { name: 'Report browser' }).getByRole('button', { name: 'New report', exact: true }).click();
  await page.getByRole('textbox', { name: 'Report title', exact: true }).fill('Retry transfer report');
  let lose = true;
  await page.route('**/create_report', async route => {
    const response = await route.fetch();
    if (lose) { lose = false; await route.abort(); } else await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Move to…', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('treeitem', { name: 'Finance report library', exact: true }).click();
  await dialog.getByRole('button', { name: 'Move report', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('saved for retry');
  await page.reload();
  const pending = page.getByRole('region', { name: 'Pending report transfers' });
  await pending.getByRole('button', { name: 'Retry transfer', exact: true }).click();
  await expect(pending).toHaveCount(0);
  expect(await reporting.client().call('list_reports', { query: 'Retry transfer report' })).toHaveLength(1);
  await page.getByRole('tree', { name: 'Report folders and locations' }).getByRole('treeitem', { name: 'On this device', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Report browser' }).getByRole('button', { name: 'Retry transfer report', exact: true })).toHaveCount(0);
});


test('unified report browser retains local report file import and export', async ({ page, reporting }) => {
  await page.goto(`reports?service=${encodeURIComponent(reporting.url)}`);
  const browser = page.getByRole('region', { name: 'Report browser' });
  await browser.getByLabel('Import local report files', { exact: true }).setInputFiles({ name: 'imported.cupola-reports.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(report('Imported file report'))) });
  const row = browser.getByRole('row').filter({ has: page.getByRole('button', { name: 'Imported file report', exact: true }) });
  await expect(row).toBeVisible();
  const downloaded = page.waitForEvent('download');
  await row.getByRole('button', { name: 'Export', exact: true }).click();
  expect((await downloaded).suggestedFilename()).toBe('imported-file-report.cupola-reports.json');
  await row.getByRole('button', { name: 'Imported file report', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit report', exact: true })).toBeVisible();
});
