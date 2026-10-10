import { test as base, expect, type Page } from '@playwright/test';
import { startReportingWorker } from './reporting/worker';
import { report } from './reporting/fixtures';
import { encodeReport } from '../src/lib/reporting/body';
import { replaceEditorText, chooseReportAction } from './helpers';

const test = base.extend<{}, { reporting: Awaited<ReturnType<typeof startReportingWorker>> }>({
  reporting: [async ({}, use) => { const worker = await startReportingWorker(); try { await use(worker); } finally { await worker.stop(); } }, { scope: 'worker' }],
});
test.use({ viewport: { width: 1600, height: 1150 } });
test.setTimeout(180_000);
const path = (url: string, id?: string, token: string | null = 'test-alice') => `reports?service=${encodeURIComponent(url)}&report_service=${encodeURIComponent(url)}${id ? `&report_id=${id}` : ''}${token ? `#token=${token}` : ''}`;
async function edit(page: Page) { await page.getByRole('button', { name: 'Edit report', exact: true }).click(); }
async function saved(page: Page) { await expect(page.getByRole('status', { name: 'Save status', exact: true })).toHaveText('Saved', { timeout: 15_000 }); }
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
  const tree = page.getByTestId('catalog-sidebar').getByRole('tree', { name: 'Reports', exact: true });
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
  await page.getByRole('button', { name: 'Update preview', exact: true }).click();
  await expect(page.getByTestId('evidence-document')).toContainText('42', { timeout: 120_000 });
  await chooseReportAction(page, 'Version history');
  await expect(page.getByRole('region', { name: 'Report history', exact: true })).toContainText('Revision 1');
  await page.getByRole('region', { name: 'Report history', exact: true }).getByRole('button', { name: 'Back to report', exact: true }).click();
  await chooseReportAction(page, 'Move…');
  await page.getByRole('dialog').getByRole('treeitem', { name: 'Finance report library', exact: true }).click();
  await page.getByRole('button', { name: 'Move report', exact: true }).click();
  await page.getByRole('region', { name: 'Worker report library' }).getByRole('button', { name: 'Quarterly finance', exact: true }).click();
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await page.getByRole('region', { name: 'Share report', exact: true }).getByRole('button', { name: 'Publish changes', exact: true }).click();
  await expect.poll(async () => (await c.call('get_report', { report_id: id })).published_revision_id).not.toBeNull();
  const link = await page.getByRole('textbox', { name: 'Report link', exact: true }).inputValue();
  expect(link).not.toContain('token'); expect(link).not.toContain('local_ws');
  const context = await browser.newContext();
  try {
    const reader = await context.newPage(); await reader.goto(link);
    await expect(reader.getByRole('button', { name: 'Edit report', exact: true })).toBeDisabled();
    await expect(reader.getByRole('status', { name: 'Save status', exact: true })).toHaveText('Read only');
    await expect(reader.getByTestId('evidence-document')).toContainText('42', { timeout: 120_000 });
    await expect(reader.getByRole('button', { name: 'Publish changes', exact: true })).toHaveCount(0);
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
  await chooseReportAction(page, 'Version history');
  await page.getByRole('region', { name: 'Report history', exact: true }).getByRole('button', { name: 'Restore revision 1', exact: true }).click();
  await saved(page);
  await expect.poll(async () => (await c.call('get_report', { report_id: first.report_id })).revision_number).toBe(3n);
  expect((await c.call('list_revisions', { report_id: first.report_id }))[0].kind).toBe('restore');
  await chooseReportAction(page, 'Version history');
  await page.getByRole('region', { name: 'Report history', exact: true }).getByRole('button', { name: 'Redact revision 2…', exact: true }).click();
  await page.getByRole('textbox', { name: 'Reason', exact: true }).fill('Remove superseded information');
  await page.getByRole('button', { name: 'Redact permanently', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Report history', exact: true })).toContainText('Redacted: Remove superseded information');
  await page.getByRole('region', { name: 'Report history', exact: true }).getByRole('button', { name: 'Back to report', exact: true }).click();
  await chooseReportAction(page, 'Details');
  await page.getByRole('button', { name: 'Transfer ownership…', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search owners', exact: true }).fill('bob@example.test');
  await page.getByRole('radio', { name: /Bob Finance/ }).check();
  await page.getByRole('button', { name: 'Transfer ownership', exact: true }).click();
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
  await page.getByRole('button', { name: 'Back to reports', exact: true }).click();
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
  await expect(page.getByTestId('catalog-sidebar').getByRole('tree', { name: 'Reports', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Report title', exact: true }).fill('Keep this local edit');
  await page.getByTestId('catalog-sidebar').getByRole('tree', { name: 'Reports', exact: true }).getByRole('treeitem', { name: 'Finance report library', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Worker report library', exact: true })).toBeVisible();
  await page.getByTestId('catalog-sidebar').getByRole('tree', { name: 'Reports', exact: true }).getByRole('treeitem', { name: 'Local', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Report browser', exact: true }).getByRole('button', { name: 'Keep this local edit', exact: true })).toBeVisible();
});

test('report details wait for autosave and preserve the current definition', async ({ page, reporting }) => {
  const initial = await seed(reporting, 'Before details');
  await page.goto(path(reporting.url, initial.report_id)); await edit(page);
  let releaseSave!: () => void;
  const saving = new Promise<void>(resolve => { releaseSave = resolve; });
  await page.route('**/commit_revision', async route => { await saving; await route.continue(); });
  await page.getByRole('textbox', { name: 'Report title', exact: true }).fill('Editor change');
  await chooseReportAction(page, 'Details');
  const details = page.getByRole('region', { name: 'Report details', exact: true });
  try { await expect(details.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled(); }
  finally { releaseSave(); }
  await expect(details.getByRole('button', { name: 'Save changes', exact: true })).toBeEnabled();
  await page.unroute('**/commit_revision');
  await expect(details.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Editor change');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Updated details');
  await page.getByRole('textbox', { name: 'Description', exact: true }).fill('Description from details');
  await details.getByRole('button', { name: 'Save changes', exact: true }).click();
  await saved(page);
  const latest = await reporting.client().call('get_report', { report_id: initial.report_id });
  expect(latest.envelope!.title).toBe('Updated details');
  expect(latest.envelope!.description).toBe('Description from details');
  expect(JSON.parse(new TextDecoder().decode(latest.body!)).document.source).toBe(report().source);
  await chooseReportAction(page, 'View source');
  await expect(page.getByRole('region', { name: 'Report source' })).toContainText('42');
});

test('read-only worker explains permissions and still allows local reports and folders', async ({ page, reporting }) => {
  await page.goto(path(reporting.url, undefined, null));
  const library = page.getByRole('region', { name: 'Worker report library', exact: true });
  await expect(library).toContainText('Read-only location');
  await expect(library.getByRole('button', { name: 'New folder', exact: true })).toBeDisabled();
  await library.getByRole('button', { name: 'New report', exact: true }).click();
  await page.getByRole('textbox', { name: 'Report title', exact: true }).fill('Local without worker permission');
  await expect(page.getByRole('status', { name: 'Save status' })).toHaveText('Saved', { timeout: 15000 });
  await page.getByRole('button', { name: 'Back to reports', exact: true }).click();
  const browser = page.getByRole('region', { name: 'Report browser' });
  await expect(browser.getByRole('button', { name: 'Local without worker permission', exact: true })).toBeVisible();
  await browser.getByRole('button', { name: 'New folder', exact: true }).click();
  await page.getByRole('dialog').getByRole('textbox', { name: 'Name', exact: true }).fill('Drafts');
  await page.getByRole('dialog').getByRole('button', { name: 'Create folder' }).click();
  await expect(browser.getByRole('button', { name: 'Drafts', exact: true })).toBeVisible();
  expect(await reporting.client().call('list_reports', { query: 'Local without worker permission' })).toHaveLength(0);
  await chooseReportAction(page, 'Move…', browser.getByRole('row').filter({ has: page.getByRole('button', { name: 'Local without worker permission', exact: true }) }));
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('treeitem', { name: 'Finance report library', exact: true }).click();
  await expect(dialog).toContainText('Read-only destination');
  await expect(dialog.getByRole('button', { name: 'Move report', exact: true })).toBeDisabled();
  await dialog.getByRole('treeitem', { name: 'Local', exact: true }).click();
  await dialog.getByRole('button', { name: 'Expand Local', exact: true }).click();
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
  await chooseReportAction(page, 'Move…'); // Flush even before autosave fires.
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('treeitem', { name: 'Finance report library', exact: true }).click();
  await dialog.getByRole('button', { name: 'Move report', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const workerReport = (await reporting.client().call('list_reports', { query: 'Portable report' }))[0];
  expect(workerReport.envelope?.title).toBe('Portable report');
  const locations = page.getByTestId('catalog-sidebar').getByRole('tree', { name: 'Reports', exact: true });
  await locations.getByRole('treeitem', { name: 'Local', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Report browser' }).getByRole('button', { name: 'Portable report', exact: true })).toHaveCount(0);
  await page.getByRole('navigation', { name: 'Saved reports' }).getByRole('link', { name: 'Reports', exact: true }).click();
  const row = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'Portable report', exact: true }) });
  await chooseReportAction(page, 'Save a copy…', row);
  await dialog.getByRole('treeitem', { name: 'Local', exact: true }).click();
  await dialog.getByRole('button', { name: 'Save copy', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Report browser' }).getByRole('button', { name: 'Portable report (copy)', exact: true })).toBeVisible();
  expect((await reporting.client().call('get_report', { report_id: workerReport.report_id })).envelope?.title).toBe('Portable report');
  await locations.getByRole('treeitem', { name: 'Finance report library', exact: true }).click();
  await chooseReportAction(page, 'Move…', page.getByRole('row').filter({ has: page.getByRole('button', { name: 'Portable report', exact: true }) }));
  await dialog.getByRole('treeitem', { name: 'Local', exact: true }).click();
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
    await expect(page.getByTestId('catalog-sidebar').getByRole('treeitem', { name: 'Research reports', exact: true })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Report locations' })).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'Report library', exact: true })).toHaveCount(0);
    await chooseReportAction(page, 'Move…', browser.getByRole('row').filter({ has: page.getByRole('button', { name: 'Across workers', exact: true }) }));
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('treeitem', { name: 'Research reports', exact: true }).click();
    await dialog.getByRole('button', { name: 'Move report', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(await reporting.client().call('list_reports', { query: 'Across workers' })).toHaveLength(0);
    const copied = (await second.client().call('list_reports', { query: 'Across workers' }))[0];
    expect(copied.report_id).not.toBe(source.report_id); expect(copied.published_revision_id).toBeNull();
    expect((await second.client().call('get_report', { report_id: other.report_id })).envelope?.title).toBe('Other worker report');
    await page.route(reporting.url + '/**', route => route.request().url().includes('vgi.reports.v1') ? route.abort() : route.continue());
    await page.getByRole('navigation', { name: 'Saved reports' }).getByRole('link', { name: 'Reports', exact: true }).click();
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
  await chooseReportAction(page, 'Move…');
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('treeitem', { name: 'Finance report library', exact: true }).click();
  await dialog.getByRole('button', { name: 'Move report', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('saved for retry');
  await page.reload();
  const pending = page.getByRole('region', { name: 'Pending report transfers' });
  await pending.getByRole('button', { name: 'Retry transfer', exact: true }).click();
  await expect(pending).toHaveCount(0);
  expect(await reporting.client().call('list_reports', { query: 'Retry transfer report' })).toHaveLength(1);
  await page.getByTestId('catalog-sidebar').getByRole('tree', { name: 'Reports', exact: true }).getByRole('treeitem', { name: 'Local', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Report browser' }).getByRole('button', { name: 'Retry transfer report', exact: true })).toHaveCount(0);
});


test('unified report browser retains local report file import and export', async ({ page, reporting }) => {
  await page.goto(`reports?service=${encodeURIComponent(reporting.url)}`);
  const browser = page.getByRole('region', { name: 'Report browser' });
  await browser.getByLabel('Import local report files', { exact: true }).setInputFiles({ name: 'imported.cupola-reports.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(report('Imported file report'))) });
  const row = browser.getByRole('row').filter({ has: page.getByRole('button', { name: 'Imported file report', exact: true }) });
  await expect(row).toBeVisible();
  const downloaded = page.waitForEvent('download');
  await chooseReportAction(page, 'Download report file', row);
  expect((await downloaded).suggestedFilename()).toBe('imported-file-report.cupola-reports.json');
  await row.getByRole('button', { name: 'Imported file report', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit report', exact: true })).toBeVisible();
});

test('views specific revisions and compares definitions with authorship without changing the report', async ({ page, reporting }) => {
  const first = await seed(reporting, 'Before history changes');
  const next = encodeReport({ ...report('After history changes'), source: '# New document\n\n```sql numbers\nSELECT 84 AS value\n```', setupSql: 'SELECT 7 AS setup_value;',
    parameters: [{ id: 'threshold', key: 'threshold', label: 'Threshold', type: 'number', required: false, defaultValue: 10 }] }, { description: 'Updated description', tags: ['reviewed'] });
  const second = await reporting.client('test-admin').call('commit_revision', { request_id: crypto.randomUUID(), report_id: first.report_id, expected_revision_id: first.head_revision_id, envelope: next.envelope, body: next.body, message: 'Updated definition' });
  await page.addInitScript(({ url }) => sessionStorage.setItem('vgi.oauth.tokens.' + url, JSON.stringify({ access_token: 'test-alice', expires_at: Date.now() / 1000 + 3600 })), { url: reporting.url });
  let writes = 0;
  page.on('request', request => { if (/\/(?:commit_revision|create_report)$/.test(request.url())) writes++; });
  await page.goto(path(reporting.url, first.report_id));
  await chooseReportAction(page, 'Version history');
  const history = page.getByRole('region', { name: 'Report history', exact: true });
  await expect(history.getByRole('article', { name: 'Revision 1', exact: true })).toContainText('alice');
  await expect(history.getByRole('article', { name: 'Revision 2', exact: true })).toContainText('operator');
  await history.getByRole('button', { name: 'Compare revision 2', exact: true }).click();
  const comparison = history.getByRole('region', { name: 'Revision comparison', exact: true });
  await expect(comparison.getByRole('region', { name: 'Title changes', exact: true })).toContainText('− Before history changes');
  await expect(comparison.getByRole('region', { name: 'Title changes', exact: true })).toContainText('+ After history changes');
  await expect(comparison.getByRole('region', { name: 'Document changes', exact: true })).toContainText('SELECT 84 AS value');
  await expect(comparison.getByRole('region', { name: 'Setup SQL changes', exact: true })).toContainText('SELECT 7 AS setup_value');
  await expect(comparison.getByRole('region', { name: 'Report parameters changes', exact: true })).toContainText('threshold');
  await expect(comparison.getByRole('region', { name: 'Description changes', exact: true })).toContainText('Updated description');
  await expect(comparison.getByRole('region', { name: 'Tags changes', exact: true })).toContainText('reviewed');
  await comparison.getByRole('combobox', { name: 'From revision', exact: true }).selectOption(second.head_revision_id);
  await expect(comparison).toContainText('No definition changes between these revisions.');
  await comparison.getByRole('button', { name: 'Back to history', exact: true }).click();
  await history.getByRole('button', { name: 'View revision 1', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('report_revision')).toBe(first.head_revision_id);
  await expect(page.getByRole('status', { name: 'Save status', exact: true })).toHaveText('Read only');
  await expect(page.getByRole('button', { name: 'Edit report', exact: true })).toBeDisabled();
  await expect(page.getByTestId('evidence-document')).toContainText('42', { timeout: 120_000 });
  await chooseReportAction(page, 'View source');
  await expect(page.getByRole('region', { name: 'Report source', exact: true })).toContainText('SELECT 42 AS value');
  await page.getByRole('region', { name: 'Report source', exact: true }).getByRole('button', { name: 'Back to report', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('status', { name: 'Save status', exact: true })).toHaveText('Read only');
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Report history', exact: true })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('button', { name: 'Open current report', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open current report', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit report', exact: true })).toBeEnabled();
  expect((await reporting.client().call('get_report', { report_id: first.report_id })).head_revision_id).toBe(second.head_revision_id);
  expect(writes).toBe(0);
});

test('revision viewing protects unsaved edits while comparisons remain available', async ({ page, reporting }) => {
  const first = await seed(reporting, 'Pending history draft');
  await reporting.client().call('commit_revision', { request_id: crypto.randomUUID(), report_id: first.report_id, expected_revision_id: first.head_revision_id, envelope: { ...first.envelope!, description: 'Saved description' }, body: first.body! });
  await page.goto(path(reporting.url, first.report_id)); await edit(page);
  await page.route('**/commit_revision', route => route.abort('failed'));
  await page.getByRole('textbox', { name: 'Report title', exact: true }).fill('Unsaved history edit');
  await expect(page.getByRole('button', { name: 'Retry save', exact: true })).toBeVisible();
  await chooseReportAction(page, 'Version history');
  const history = page.getByRole('region', { name: 'Report history', exact: true });
  await expect(history.getByRole('button', { name: 'View revision 1', exact: true })).toBeDisabled();
  await history.getByRole('button', { name: 'Compare revision 2', exact: true }).click();
  await expect(history.getByRole('region', { name: 'Description changes', exact: true })).toContainText('Saved description');
  await expect(history.getByRole('button', { name: 'View selected revision', exact: true })).toBeDisabled();
  await history.getByRole('button', { name: 'Back to report', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Report title', exact: true })).toHaveValue('Unsaved history edit');
  await page.unroute('**/commit_revision');
  await page.getByRole('button', { name: 'Retry save', exact: true }).click(); await saved(page);
  expect((await reporting.client().call('get_report', { report_id: first.report_id })).envelope!.title).toBe('Unsaved history edit');
});

test('comparison retries failures and does not retain old content after denied or redacted reads', async ({ page, reporting }) => {
  const first = await seed(reporting, 'Private original title'), client = reporting.client();
  const second = await client.call('commit_revision', { request_id: crypto.randomUUID(), report_id: first.report_id, expected_revision_id: first.head_revision_id, envelope: { ...first.envelope!, title: 'Current title' }, body: first.body! });
  await page.goto(path(reporting.url, first.report_id));
  await chooseReportAction(page, 'Version history');
  const history = page.getByRole('region', { name: 'Report history', exact: true });
  await history.getByRole('button', { name: 'Compare revision 2', exact: true }).click();
  const comparison = history.getByRole('region', { name: 'Revision comparison', exact: true });
  await expect(comparison.getByRole('region', { name: 'Title changes', exact: true })).toContainText('Private original title');
  await page.route('**/get_report', route => route.fulfill({ status: 403, body: 'Access denied' }));
  await comparison.getByRole('combobox', { name: 'From revision', exact: true }).selectOption(second.head_revision_id);
  await expect(comparison.getByRole('alert')).toContainText('Could not compare revisions');
  await expect(comparison.getByRole('region', { name: 'Title changes', exact: true })).toHaveCount(0);
  await page.unroute('**/get_report');
  await comparison.getByRole('button', { name: 'Retry comparison', exact: true }).click();
  await expect(comparison).toContainText('No definition changes between these revisions.');
  await client.call('redact_revision', { request_id: crypto.randomUUID(), report_id: first.report_id, revision_id: first.head_revision_id, expected_version: second.version, reason: 'Remove old content' });
  await comparison.getByRole('combobox', { name: 'From revision', exact: true }).selectOption(first.head_revision_id);
  await expect(comparison.getByRole('alert')).toContainText('redacted');
  await expect(comparison.getByRole('region', { name: 'Title changes', exact: true })).toHaveCount(0);
  await comparison.getByRole('button', { name: 'Back to history', exact: true }).click();
  const redacted = history.getByRole('article', { name: 'Revision 1', exact: true });
  await expect(redacted).toContainText('Redacted: Remove old content');
  await expect(redacted.getByRole('button', { name: 'View revision 1', exact: true })).toHaveCount(0);
});

test('shared report header keeps management in menus and publishing in Share', async ({ page, reporting }) => {
  const initial = await seed(reporting, 'A tidy report');
  await page.goto(path(reporting.url, initial.report_id));
  const header = page.locator('header[aria-label="Report toolbar"]');
  await expect(header).toHaveCount(1);
  await expect(header).toContainText('Finance report library');
  await expect(header.getByRole('button', { name: 'Share', exact: true })).toBeVisible();
  await expect(header.getByRole('button', { name: /^(History|Ownership|Move|Move to…|Copy to…|Publish changes|Report details)$/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Rename report', exact: true }).click();
  await page.getByRole('textbox', { name: 'Report name', exact: true }).fill('Renamed tidy report');
  await page.getByRole('button', { name: 'Save name', exact: true }).click(); await saved(page);
  await expect(header.getByRole('button', { name: 'Rename report', exact: true })).toHaveText('Renamed tidy report');
  await page.getByRole('button', { name: 'More report actions', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Move…', exact: true })).toHaveCount(1);
  await expect(page.getByRole('menuitem', { name: 'Save a copy…', exact: true })).toHaveCount(1);
  await page.getByRole('menuitem', { name: 'Details', exact: true }).click();
  const details = page.getByRole('region', { name: 'Report details', exact: true });
  await expect(details.getByRole('region', { name: 'Report ownership' })).toContainText('alice');
  await details.getByRole('button', { name: 'Close', exact: true }).first().click();
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const share = page.getByRole('region', { name: 'Share report', exact: true });
  await share.getByRole('combobox', { name: 'Link to', exact: true }).selectOption('version');
  const latest = await reporting.client().call('get_report', { report_id: initial.report_id });
  expect(new URL(await share.getByRole('textbox', { name: 'Report link', exact: true }).inputValue()).searchParams.get('report_revision')).toBe(latest.head_revision_id);
  await share.getByRole('button', { name: 'Publish changes', exact: true }).click();
  await expect(share).toContainText('This saved version is published.');
  await share.getByRole('button', { name: 'Back to report', exact: true }).click();
  await edit(page);
  await expect(header.getByRole('button', { name: 'Publish changes', exact: true })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Report title', exact: true }).fill('Unpublished edit'); await saved(page);
  await expect(header).toContainText('Unpublished changes');
  await header.getByRole('button', { name: 'Publish changes', exact: true }).click();
  await share.getByRole('button', { name: 'Unpublish…', exact: true }).click();
  await expect(share).toContainText('Remove the published version?');
  await share.getByRole('button', { name: 'Unpublish report', exact: true }).click();
  await expect(share).toContainText('This report has not been published.');
  expect((await reporting.client().call('list_revisions', { report_id: initial.report_id })).length).toBe(3);
  await share.getByRole('button', { name: 'Back to report', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => header.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
});

test('local Share saves a library copy and keeps local metadata and the original', async ({ page, reporting }) => {
  await page.goto(`reports?service=${encodeURIComponent(reporting.url)}#token=test-alice`);
  await page.getByRole('region', { name: 'Report browser' }).getByRole('button', { name: 'New report', exact: true }).click();
  await expect(page.locator('header[aria-label="Report toolbar"]')).toHaveCount(1);
  await page.getByRole('textbox', { name: 'Report title', exact: true }).fill('Shared local draft');
  await chooseReportAction(page, 'Details');
  const details = page.getByRole('region', { name: 'Report details', exact: true });
  await details.getByRole('textbox', { name: 'Description', exact: true }).fill('Local description');
  await details.getByRole('textbox', { name: 'Tags', exact: true }).fill('quarterly, finance');
  await details.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await page.getByRole('region', { name: 'Share report', exact: true }).getByRole('button', { name: 'Save to a report library…', exact: true }).click();
  const copy = page.getByRole('dialog', { name: 'Save a copy', exact: true });
  await expect(copy.getByRole('textbox', { name: 'Copy name', exact: true })).toHaveValue('Shared local draft (copy)');
  await copy.getByRole('treeitem', { name: 'Finance report library', exact: true }).click();
  await copy.getByRole('button', { name: 'Save copy', exact: true }).click();
  await expect(copy).toHaveCount(0);
  const stored = (await reporting.client().call('list_reports', { query: 'Shared local draft' }))[0];
  expect(stored.envelope).toMatchObject({ title: 'Shared local draft (copy)', description: 'Local description', tags: ['quarterly', 'finance'] });
  expect(stored.published_revision_id).toBeNull();
  const libraryRow = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'Shared local draft (copy)', exact: true }) });
  await expect(libraryRow.getByRole('button', { name: /^Actions for / })).toHaveCount(1);
  await expect(libraryRow.getByRole('button', { name: /Copy|Move/ })).toHaveCount(0);
  await page.getByTestId('catalog-sidebar').getByRole('tree', { name: 'Reports', exact: true }).getByRole('treeitem', { name: 'Local', exact: true }).click();
  await page.getByRole('region', { name: 'Report browser' }).getByRole('button', { name: 'Shared local draft', exact: true }).click();
  await chooseReportAction(page, 'Version history');
  await expect(page.getByRole('region', { name: 'Report history', exact: true })).toContainText('saved version');
});

test('main sidebar opens nested worker reports without reloading and follows saved changes', async ({ page, reporting }) => {
  const client = reporting.client();
  const parent = await client.call('create_folder', { request_id: crypto.randomUUID(), name: 'Team navigation', parent_folder_id: null });
  const child = await client.call('create_folder', { request_id: crypto.randomUUID(), name: 'Quarter navigation', parent_folder_id: parent.folder_id });
  const initial = await seed(reporting, 'Sidebar revenue');
  await client.call('move_report', { request_id: crypto.randomUUID(), report_id: initial.report_id, expected_version: initial.version, folder_id: child.folder_id });
  await page.goto(`?service=${encodeURIComponent(reporting.url)}#token=test-alice`);
  const sidebar = page.getByTestId('catalog-sidebar'), reports = sidebar.getByRole('navigation', { name: 'Saved reports' });
  await expect(reports).toBeVisible();
  await expect(sidebar.getByRole('region', { name: 'On this device', exact: true }).getByRole('navigation', { name: 'Saved reports' })).toHaveCount(0);
  await reports.getByRole('button', { name: 'Expand Finance report library', exact: true }).click();
  await reports.getByRole('button', { name: 'Expand Team navigation', exact: true }).click();
  await reports.getByRole('button', { name: 'Expand Quarter navigation', exact: true }).click();
  await expect(reports.getByRole('treeitem', { name: 'Sidebar revenue', exact: true })).toHaveAttribute('aria-level', '4');
  await page.evaluate(() => { (window as any).__sidebarDocument = 'original'; });
  await reports.getByRole('link', { name: 'Sidebar revenue', exact: true }).click();
  await expect(page.locator('header[aria-label="Report toolbar"]')).toContainText('Sidebar revenue');
  await expect(page.getByRole('complementary', { name: 'Report storage' })).toHaveCount(0);
  await expect(reports.getByRole('treeitem', { name: 'Sidebar revenue', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(sidebar.locator('[role="tree"]:not([aria-label="Reports"]) [aria-selected="true"]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__sidebarDocument)).toBe('original');
  await edit(page);
  await page.getByRole('textbox', { name: 'Report title', exact: true }).fill('Updated sidebar revenue');
  await saved(page);
  await expect(reports.getByRole('link', { name: 'Updated sidebar revenue', exact: true })).toBeVisible();
  await sidebar.getByRole('textbox', { name: 'Filter catalog' }).fill('Updated sidebar');
  await expect(reports.getByRole('link', { name: 'Quarter navigation', exact: true })).toBeVisible();
  await expect(reports.getByRole('link', { name: 'Local', exact: true })).toHaveCount(0);
  await sidebar.getByRole('textbox', { name: 'Filter catalog' }).fill('');
  await reports.getByRole('link', { name: 'Quarter navigation', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Worker report library' }).getByRole('button', { name: 'Updated sidebar revenue', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.locator('header[aria-label="Report toolbar"]')).toContainText('Updated sidebar revenue');
  await expect(reports.getByRole('treeitem', { name: 'Updated sidebar revenue', exact: true })).toHaveAttribute('aria-selected', 'true');
  // Fragment-injected fixture credentials are memory-only; supply them on the new document too.
  await page.addInitScript(() => history.replaceState({}, '', location.pathname + location.search + '#token=test-alice'));
  await page.reload();
  await expect(reports.getByRole('link', { name: 'Updated sidebar revenue', exact: true })).toBeVisible();
});

test('mobile report navigation uses the catalog drawer and closes after opening a report', async ({ page, reporting }) => {
  const initial = await seed(reporting, 'Mobile sidebar report');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(path(reporting.url, initial.report_id));
  await expect(page.locator('header[aria-label="Report toolbar"]')).toContainText('Mobile sidebar report');
  await expect(page.getByTestId('catalog-sidebar')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show catalog sidebar', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Catalog sidebar', exact: true });
  await expect(drawer.getByRole('treeitem', { name: 'Mobile sidebar report', exact: true })).toHaveAttribute('aria-selected', 'true');
  await drawer.getByRole('link', { name: 'Mobile sidebar report', exact: true }).click();
  await expect(drawer).toHaveCount(0);
  await expect(page.locator('header[aria-label="Report toolbar"]')).toContainText('Mobile sidebar report');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('sidebar creates nested folders through the worker API, including from a lazy Reports tab', async ({ page, reporting }) => {
  await page.goto(`?service=${encodeURIComponent(reporting.url)}#token=test-alice`);
  const tree = page.getByTestId('catalog-sidebar').getByRole('tree', { name: 'Reports', exact: true });
  let parent: string | null = null;
  for (const [index, name] of ['Sidebar folders', 'FY2026', 'October'].entries()) {
    await tree.getByRole('link', { name: index ? ['Sidebar folders', 'FY2026'][index - 1] : 'Finance report library', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'New folder…', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'New folder', exact: true });
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
    await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const folder = (await reporting.client().call('list_folders', {})).find(f => f.name === name)!;
    expect(folder.parent_folder_id).toBe(parent); parent = folder.folder_id;
    // Select it to reveal the next level, including an empty folder.
    await tree.getByRole('link', { name, exact: true }).click();
    await expect(tree.getByRole('treeitem', { name, exact: true })).toHaveAttribute('aria-level', String(index + 2));
    expect(new URL(page.url()).searchParams.has('report_new_folder')).toBe(false);
  }
  expect((await reporting.client().call('get_report_service_info', {})).limits.find(l => l.name === 'max_folder_depth')?.value).toBe(32n);
});

test('sidebar folder creation recovers an admitted request without creating another folder', async ({ page, reporting }) => {
  await page.goto(path(reporting.url));
  const sidebar = page.getByTestId('catalog-sidebar');
  await sidebar.getByRole('link', { name: 'Finance report library', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New folder…', exact: true }).click();
  let dropped = false;
  await page.route('**/create_folder', async route => {
    const response = await route.fetch();
    if (!dropped) { dropped = true; await route.abort('failed'); } else await route.fulfill({ response });
  });
  const dialog = page.getByRole('dialog', { name: 'New folder', exact: true });
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Recovered sidebar folder');
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Retry pending change', exact: true }).click();
  await expect(sidebar.getByRole('link', { name: 'Recovered sidebar folder', exact: true })).toBeVisible();
  expect((await reporting.client().call('list_folders', {})).filter(f => f.name === 'Recovered sidebar folder')).toHaveLength(1);
});

test('sidebar drag moves a published report into nested folders and back with its identity and history', async ({ page, reporting }) => {
  const c = reporting.client(), initial = await seed(reporting, 'Drag published report');
  const parent = await c.call('create_folder', { request_id: crypto.randomUUID(), name: 'Drag destinations' });
  const child = await c.call('create_folder', { request_id: crypto.randomUUID(), name: 'Nested destination', parent_folder_id: parent.folder_id });
  await c.call('publish', { request_id: crypto.randomUUID(), report_id: initial.report_id, revision_id: initial.head_revision_id, expected_published_revision_id: null });
  await page.goto(path(reporting.url, initial.report_id));
  await saved(page);
  const tree = page.getByTestId('catalog-sidebar').getByRole('tree', { name: 'Reports', exact: true });
  await tree.getByRole('button', { name: 'Expand Drag destinations', exact: true }).click();
  const source = tree.getByRole('treeitem', { name: 'Drag published report', exact: true });
  await source.locator(':scope > div').dragTo(tree.getByRole('treeitem', { name: 'Nested destination', exact: true }));
  const dialog = page.getByRole('dialog', { name: 'Move report', exact: true });
  await expect(dialog.getByRole('treeitem', { name: 'Nested destination', exact: true })).toHaveAttribute('aria-selected', 'true');
  await dialog.getByRole('button', { name: 'Move report', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const moved = await c.call('get_report', { report_id: initial.report_id });
  expect(moved.folder_id).toBe(child.folder_id); expect(moved.published_revision_id).toBe(initial.head_revision_id); expect(moved.head_revision_id).toBe(initial.head_revision_id);
  expect(await c.call('list_revisions', { report_id: initial.report_id })).toHaveLength(1);
  await expect(source).toHaveAttribute('aria-level', '4');
  await source.locator(':scope > div').dragTo(tree.getByRole('treeitem', { name: 'Finance report library', exact: true }));
  await expect(dialog.getByRole('treeitem', { name: 'Finance report library', exact: true })).toHaveAttribute('aria-selected', 'true');
  await dialog.getByRole('button', { name: 'Move report', exact: true }).click();
  await expect.poll(async () => (await c.call('get_report', { report_id: initial.report_id })).folder_id).toBeNull();
});

test('sidebar drag saves an open local draft before moving to a worker and supports moving back', async ({ page, reporting }) => {
  await page.goto(`reports?service=${encodeURIComponent(reporting.url)}#token=test-alice`);
  await page.getByRole('region', { name: 'Report browser' }).getByRole('button', { name: 'New report', exact: true }).click();
  const id = new URL(page.url()).searchParams.get('evidence_report')!;
  const tree = page.getByTestId('catalog-sidebar').getByRole('tree', { name: 'Reports', exact: true });
  const source = tree.locator('[data-file-node]').filter({ has: page.locator(`a[href*="evidence_report=${id}"]`) });
  await expect(source).toBeVisible();
  await page.getByRole('textbox', { name: 'Report title', exact: true }).fill('Unsaved sidebar transfer');
  await source.locator(':scope > div').dragTo(tree.getByRole('treeitem', { name: 'Finance report library', exact: true }));
  const dialog = page.getByRole('dialog', { name: 'Move report', exact: true });
  await expect(dialog).toContainText('History and publication are not transferred');
  await dialog.getByRole('button', { name: 'Move report', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const moved = (await reporting.client().call('list_reports', { query: 'Unsaved sidebar transfer' }))[0];
  expect(moved.envelope?.title).toBe('Unsaved sidebar transfer');
  await expect(source).toHaveCount(0);
  const remote = tree.getByRole('treeitem', { name: 'Unsaved sidebar transfer', exact: true });
  await remote.locator(':scope > div').dragTo(tree.getByRole('treeitem', { name: 'Local', exact: true }));
  await expect(dialog.getByRole('treeitem', { name: 'Local', exact: true })).toHaveAttribute('aria-selected', 'true');
  await dialog.getByRole('button', { name: 'Move report', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Report browser' }).getByRole('button', { name: 'Unsaved sidebar transfer', exact: true })).toBeVisible();
  expect(await reporting.client().call('list_reports', { query: 'Unsaved sidebar transfer' })).toHaveLength(0);
  await expect(source).toHaveCount(0); // The original local id was never recreated.
});

test('sidebar rejects read-only and same-folder drops and protects an unconfirmed worker draft', async ({ page, reporting }) => {
  const c = reporting.client(), initial = await seed(reporting, 'Protected sidebar draft');
  await c.call('create_folder', { request_id: crypto.randomUUID(), name: 'Protected destination' });
  await page.goto(path(reporting.url, initial.report_id)); await edit(page);
  const tree = page.getByTestId('catalog-sidebar').getByRole('tree', { name: 'Reports', exact: true });
  const source = tree.getByRole('treeitem', { name: 'Protected sidebar draft', exact: true });
  await source.locator(':scope > div').dragTo(tree.getByRole('treeitem', { name: 'Finance report library', exact: true }));
  await expect(page.getByRole('dialog', { name: 'Move report', exact: true })).toHaveCount(0);
  await page.route('**/commit_revision', route => route.abort('failed'));
  await page.getByRole('textbox', { name: 'Report title', exact: true }).fill('Keep my failed draft');
  await expect(page.getByRole('button', { name: 'Retry save', exact: true })).toBeVisible();
  await source.locator(':scope > div').dragTo(tree.getByRole('treeitem', { name: 'Protected destination', exact: true }));
  await expect(page.getByTestId('catalog-sidebar').getByRole('alert')).toContainText('Finish saving');
  await expect(page.getByRole('textbox', { name: 'Report title', exact: true })).toHaveValue('Keep my failed draft');
  expect((await c.call('get_report', { report_id: initial.report_id })).folder_id).toBeNull();
  // This worker hides other users' folders entirely; anonymous library root is read-only.
  await page.unroute('**/commit_revision');
  page.once('dialog', dialog => dialog.accept());
  await page.goto(path(reporting.url, undefined, null));
  const destination = tree.getByRole('treeitem', { name: 'Finance report library', exact: true });
  await expect(destination).toBeVisible();
  await expect(tree.getByRole('button', { name: 'New folder in Finance report library', exact: true })).toHaveCount(0);
  await expect(tree.getByRole('treeitem', { name: 'Protected destination', exact: true })).toHaveCount(0);
  await page.getByRole('navigation', { name: 'Saved reports' }).getByRole('button', { name: 'New report', exact: true }).click();
  await page.getByRole('textbox', { name: 'Report title', exact: true }).fill('Read-only drop source');
  await saved(page);
  const local = tree.getByRole('treeitem', { name: 'Read-only drop source', exact: true });
  await local.locator(':scope > div').dragTo(destination);
  await expect(page.getByRole('dialog', { name: 'Move report', exact: true })).toHaveCount(0);
  expect(await c.call('list_reports', { query: 'Read-only drop source' })).toHaveLength(0);
});

test.describe('touch sidebar actions', () => {
  test.use({ hasTouch: true, isMobile: true });
  test('mobile sidebar folder and move actions survive closing the catalog drawer', async ({ page, reporting }) => {
    const initial = await seed(reporting, 'Mobile move report');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(path(reporting.url, initial.report_id)); await saved(page);
    await page.getByRole('button', { name: 'Show catalog sidebar', exact: true }).click();
    let drawer = page.getByRole('dialog', { name: 'Catalog sidebar', exact: true });
    await drawer.getByRole('button', { name: 'Actions for Finance report library', exact: true }).click();
    await page.getByRole('menuitem', { name: 'New folder…', exact: true }).click();
    const folder = page.getByRole('dialog', { name: 'New folder', exact: true });
    await expect(drawer).toHaveCount(0);
    await folder.getByRole('textbox', { name: 'Name', exact: true }).fill('Mobile destination');
    await folder.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(folder).toHaveCount(0);
    await page.getByRole('button', { name: 'Show catalog sidebar', exact: true }).click();
    drawer = page.getByRole('dialog', { name: 'Catalog sidebar', exact: true });
    await drawer.getByRole('button', { name: 'Expand Finance report library', exact: true }).click();
    const actions = drawer.getByRole('button', { name: 'Actions for Mobile move report', exact: true });
    await expect(actions).toHaveCSS('opacity', '1');
    await actions.tap();
    await page.getByRole('menuitem', { name: 'Move…', exact: true }).tap();
    const dialog = page.getByRole('dialog', { name: 'Move report', exact: true });
    await expect(drawer).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Expand Finance report library', exact: true }).click();
    await dialog.getByRole('treeitem', { name: 'Mobile destination', exact: true }).click();
    await dialog.getByRole('button', { name: 'Move report', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect((await reporting.client().call('get_report', { report_id: initial.report_id })).folder_id).toBe((await reporting.client().call('list_folders', {})).find(f => f.name === 'Mobile destination')!.folder_id);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});

test('worker sidebar menus support right click, keyboard and hover without navigating', async ({ page, reporting }) => {
  const c = reporting.client(), initial = await seed(reporting, 'Context menu report');
  const destination = await c.call('create_folder', { request_id: crypto.randomUUID(), name: 'Context menu destination' });
  await page.goto(path(reporting.url, initial.report_id)); await saved(page);
  const tree = page.getByTestId('catalog-sidebar').getByRole('tree', { name: 'Reports', exact: true });
  const row = tree.getByRole('treeitem', { name: 'Context menu report', exact: true });
  const link = row.getByRole('link', { name: 'Context menu report', exact: true });
  const actions = row.getByRole('button', { name: 'Actions for Context menu report', exact: true });
  // The dropdown is labelled by its trigger; the context menu has its own label.
  const menu = page.getByRole('menu');
  const startingUrl = page.url();
  const reportHref = await link.getAttribute('href');
  await page.mouse.move(1500, 1000);
  await expect(actions).toHaveCSS('opacity', '0');
  await expect(row.getByRole('button', { name: 'Move Context menu report', exact: true })).toHaveCount(0);
  await link.hover();
  await expect(actions).toHaveCSS('opacity', '1');
  await link.click({ button: 'right' });
  await expect(menu).toBeVisible();
  expect(page.url()).toBe(startingUrl);
  await expect(menu.getByRole('menuitem', { name: 'Open in new tab', exact: true })).toHaveAttribute('href', reportHref!);
  await expect(menu.getByRole('menuitem', { name: 'Move…', exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /Rename|Delete|Export/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await link.focus();
  await page.mouse.move(1500, 1000);
  await expect(actions).toHaveCSS('opacity', '1');
  await page.keyboard.press('Shift+F10');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(link).toBeFocused();
  // Arrow navigation focuses the tree item instead of the link.
  await row.focus();
  await page.keyboard.press('Shift+F10');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(actions).toBeFocused();
  await actions.click();
  await expect(menu).toBeVisible();
  expect(page.url()).toBe(startingUrl);
  await menu.getByRole('menuitem', { name: 'Move…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Move report', exact: true });
  await dialog.getByRole('button', { name: 'Expand Finance report library', exact: true }).click();
  await dialog.getByRole('treeitem', { name: 'Context menu destination', exact: true }).click();
  await dialog.getByRole('button', { name: 'Move report', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await c.call('get_report', { report_id: initial.report_id })).folder_id).toBe(destination.folder_id);
  expect(await c.call('list_revisions', { report_id: initial.report_id })).toHaveLength(1);
});

test('read-only worker sidebar menu offers navigation without move or local mutations', async ({ page, reporting }) => {
  const c = reporting.client(), initial = await seed(reporting, 'Read-only context report');
  await c.call('publish', { request_id: crypto.randomUUID(), report_id: initial.report_id, revision_id: initial.head_revision_id, expected_published_revision_id: null });
  await page.goto(path(reporting.url, initial.report_id, null));
  await expect(page.getByRole('status', { name: 'Save status', exact: true })).toHaveText('Read only');
  const row = page.getByTestId('catalog-sidebar').getByRole('treeitem', { name: 'Read-only context report', exact: true });
  await row.getByRole('link', { name: 'Read-only context report', exact: true }).click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Read-only context report actions', exact: true });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveCount(4);
  await expect(menu.getByRole('menuitem', { name: 'Transfer ownership…', exact: true })).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: 'Open in new tab', exact: true })).toBeVisible();
  await expect(menu.getByRole('separator')).toHaveCount(0);
  expect((await c.call('get_report', { report_id: initial.report_id })).folder_id).toBeNull();
});

test('sidebar refresh discovers external changes in the tree, overview and worker library', async ({ page, reporting }) => {
  const c = reporting.client(), initial = await seed(reporting, 'Before external update');
  const removed = await seed(reporting, 'Removed outside Cupola');
  await page.goto(`reports?service=${encodeURIComponent(reporting.url)}#token=test-alice`);
  const sidebar = page.getByTestId('catalog-sidebar');
  const tree = sidebar.getByRole('tree', { name: 'Reports', exact: true });
  const overview = page.getByRole('region', { name: 'Report browser', exact: true });
  const refresh = sidebar.getByRole('button', { name: 'Refresh catalogs and reports', exact: true });
  await expect(overview.getByRole('button', { name: 'Before external update', exact: true })).toBeVisible();
  await tree.getByRole('button', { name: 'Expand Finance report library', exact: true }).click();
  await c.call('commit_revision', { request_id: crypto.randomUUID(), report_id: initial.report_id, expected_revision_id: initial.head_revision_id, envelope: { ...initial.envelope!, title: 'Updated outside Cupola' }, body: initial.body! });
  await c.call('delete_report', { request_id: crypto.randomUUID(), report_id: removed.report_id, expected_version: removed.version });
  const folder = await c.call('create_folder', { request_id: crypto.randomUUID(), name: 'Created outside Cupola' });
  const nested = await seed(reporting, 'New nested external report');
  await c.call('move_report', { request_id: crypto.randomUUID(), report_id: nested.report_id, expected_version: nested.version, folder_id: folder.folder_id });
  await expect(tree.getByRole('link', { name: 'Created outside Cupola', exact: true })).toHaveCount(0);
  await refresh.click();
  await expect(tree.getByRole('link', { name: 'Updated outside Cupola', exact: true })).toBeVisible();
  await expect(tree.getByRole('link', { name: 'Removed outside Cupola', exact: true })).toHaveCount(0);
  await tree.getByRole('button', { name: 'Expand Created outside Cupola', exact: true }).click();
  await expect(tree.getByRole('link', { name: 'New nested external report', exact: true })).toBeVisible();
  await expect(overview.getByRole('button', { name: 'Updated outside Cupola', exact: true })).toBeVisible();
  await expect(overview.getByRole('button', { name: 'New nested external report', exact: true })).toBeVisible();
  await expect(overview.getByRole('button', { name: 'Removed outside Cupola', exact: true })).toHaveCount(0);
  // The worker contents view has its own session and must refresh too.
  await tree.getByRole('link', { name: 'Finance report library', exact: true }).click();
  const library = page.getByRole('region', { name: 'Worker report library', exact: true });
  await expect(library.getByRole('button', { name: 'Created outside Cupola', exact: true })).toBeVisible();
  await seed(reporting, 'Created while browsing the library');
  await reporting.client('test-admin').call('set_folder_ownership', { request_id: crypto.randomUUID(), folder_id: folder.folder_id, expected_version: folder.version,
    ownership: { owner_ref: { kind: 'principal', id: 'bob', display_name: '' }, parent_owner_ref: null } });
  await refresh.click();
  await expect(library.getByRole('button', { name: 'Created while browsing the library', exact: true })).toBeVisible();
  await expect(library.getByRole('button', { name: 'Created outside Cupola', exact: true })).toHaveCount(0);
  await expect(tree.getByRole('link', { name: 'Created outside Cupola', exact: true })).toHaveCount(0);
});

test('remote reports render on sidebar open and sidebar refresh preserves the draft and execution', async ({ page, reporting }) => {
  const definition = encodeReport({ ...report('Automatic worker report'),
    setupSql: 'CREATE TEMP TABLE IF NOT EXISTS sidebar_refresh_runs (value INTEGER); INSERT INTO temp.main.sidebar_refresh_runs VALUES (1);',
    source: '# Automatic worker report\n\n```sql runs\nSELECT \'Render \' || COUNT(*)::VARCHAR AS label FROM temp.main.sidebar_refresh_runs\n```\n\n{% table data="runs" /%}',
  }, { description: '', tags: [] });
  const c = reporting.client(), initial = await c.call('create_report', { request_id: crypto.randomUUID(), envelope: definition.envelope, body: definition.body });
  await page.goto(path(reporting.url));
  const sidebar = page.getByTestId('catalog-sidebar');
  const tree = sidebar.getByRole('tree', { name: 'Reports', exact: true });
  await tree.getByRole('button', { name: 'Expand Finance report library', exact: true }).click();
  await tree.getByRole('link', { name: 'Automatic worker report', exact: true }).click();
  await expect(page.getByTestId('evidence-document')).toContainText('Render 1', { timeout: 120_000 });
  await expect(page.getByText(/Review its source before running/)).toHaveCount(0);
  await edit(page);
  await page.route('**/commit_revision', route => route.abort('failed'));
  await page.getByRole('textbox', { name: 'Report title', exact: true }).fill('Keep this unsaved draft');
  await expect(page.getByRole('button', { name: 'Retry save', exact: true })).toBeVisible();
  let reportReads = 0;
  page.on('request', request => { if (request.url().endsWith('/get_report')) reportReads++; });
  await c.call('create_folder', { request_id: crypto.randomUUID(), name: 'Added while editing' });
  const refresh = sidebar.getByRole('button', { name: 'Refresh catalogs and reports', exact: true });
  await refresh.click();
  await expect(tree.getByRole('link', { name: 'Added while editing', exact: true })).toBeVisible();
  await expect(refresh).toBeEnabled();
  await expect(page.getByRole('textbox', { name: 'Report title', exact: true })).toHaveValue('Keep this unsaved draft');
  await expect(page.getByRole('button', { name: 'Retry save', exact: true })).toBeVisible();
  await expect(page.getByTestId('evidence-document')).toContainText('Render 1');
  expect(reportReads).toBe(0);
  const execution = await page.evaluate(async () => {
    const result = await (window as any).__bridge.query("SELECT CASE WHEN COUNT(*) = 1 THEN true ELSE error('Report ran more than once') END FROM temp.main.sidebar_refresh_runs");
    return { ok: result.ok, error: result.error };
  });
  expect(execution).toMatchObject({ ok: true });
  expect((await c.call('get_report', { report_id: initial.report_id })).envelope?.title).toBe('Automatic worker report');
  await page.unroute('**/commit_revision');
  await page.getByRole('button', { name: 'Retry save', exact: true }).click();
  await saved(page);
  expect((await c.call('get_report', { report_id: initial.report_id })).envelope?.title).toBe('Keep this unsaved draft');
});


test('folder context menus rename and show duplicate-name errors inside the naming dialog', async ({ page, reporting }) => {
  const c = reporting.client(), folder = await c.call('create_folder', { request_id: crypto.randomUUID(), name: 'Naming test' });
  const child = await c.call('create_folder', { request_id: crypto.randomUUID(), name: 'Child preserved', parent_folder_id: folder.folder_id });
  await page.goto(path(reporting.url));
  const tree = page.getByTestId('catalog-sidebar').getByRole('tree', { name: 'Reports', exact: true });
  await expect(tree.getByRole('button', { name: 'Actions for Finance report library' })).toHaveCSS('opacity', '0');
  await tree.getByRole('link', { name: 'Finance report library', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New folder…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New folder', exact: true });
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Naming test');
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('already exists');
  await expect(dialog.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Naming test');
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Another name');
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await tree.getByRole('link', { name: 'Finance report library', exact: true }).click();
  const root = tree.getByRole('treeitem', { name: 'Finance report library', exact: true });
  if (await root.getAttribute('aria-expanded') !== 'true') await root.getByRole('button', { name: 'Expand Finance report library', exact: true }).click();
  await tree.getByRole('treeitem', { name: 'Naming test', exact: true }).focus();
  await page.keyboard.press('Shift+F10');
  await page.getByRole('menuitem', { name: 'Rename…', exact: true }).click();
  const rename = page.getByRole('dialog', { name: 'Rename folder', exact: true });
  await rename.getByRole('textbox', { name: 'Name', exact: true }).fill('Another name');
  await rename.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(rename.getByRole('alert')).toContainText('already exists');
  await rename.getByRole('textbox', { name: 'Name', exact: true }).fill('Renamed folder');
  await rename.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(tree.getByRole('link', { name: 'Renamed folder', exact: true })).toBeVisible();
  expect((await c.call('get_folder', { folder_id: child.folder_id })).parent_folder_id).toBe(folder.folder_id);
});

test('metadata search and tag filters work across reports and inside a library', async ({ page, reporting }) => {
  const first = encodeReport(report('Metadata only match'), { description: 'Quarterly forecast', tags: ['planning', 'finance'] });
  await reporting.client().call('create_report', { request_id: crypto.randomUUID(), ...first });
  await seed(reporting, 'Other report');
  await page.goto(`reports?service=${encodeURIComponent(reporting.url)}#token=test-alice`);
  const browser = page.getByRole('region', { name: 'Report browser', exact: true });
  await browser.getByRole('textbox', { name: 'Search reports', exact: true }).fill('FORECAST');
  await expect(browser.getByRole('button', { name: 'Metadata only match', exact: true })).toBeVisible();
  await expect(browser.getByRole('button', { name: 'Other report', exact: true })).toHaveCount(0);
  await browser.getByRole('textbox', { name: 'Search reports', exact: true }).fill('');
  await browser.getByRole('combobox', { name: 'Filter by tag', exact: true }).selectOption('planning');
  await expect(browser.getByRole('button', { name: 'Other report', exact: true })).toHaveCount(0);
  await page.getByTestId('catalog-sidebar').getByRole('link', { name: 'Finance report library', exact: true }).click();
  const library = page.getByRole('region', { name: 'Worker report library', exact: true });
  await expect(library).toContainText('Worker:');
  await library.getByRole('textbox', { name: 'Search reports', exact: true }).fill('planning');
  await expect(library.getByRole('button', { name: 'Metadata only match', exact: true })).toBeVisible();
  await expect(library.getByRole('button', { name: 'Other report', exact: true })).toHaveCount(0);
});

test('management pages preserve drafts and browser navigation; ownership opens from right-click', async ({ page, reporting }) => {
  const initial = await seed(reporting, 'Management pages');
  await page.goto(path(reporting.url, initial.report_id)); await edit(page);
  await page.route('**/commit_revision', route => route.abort('failed'));
  await page.getByRole('textbox', { name: 'Report title', exact: true }).fill('Draft retained on return');
  await expect(page.getByRole('button', { name: 'Retry save', exact: true })).toBeVisible();
  await chooseReportAction(page, 'Version history');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Report history', exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('report_view')).toBe('history');
  await page.goBack();
  await expect(page.getByRole('textbox', { name: 'Report title', exact: true })).toHaveValue('Draft retained on return');
  await page.goForward();
  await expect(page.getByRole('heading', { name: 'Report history', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to report', exact: true }).click();
  await page.unroute('**/commit_revision');
  await page.getByRole('button', { name: 'Retry save', exact: true }).click(); await saved(page);
  const tree = page.getByTestId('catalog-sidebar').getByRole('tree', { name: 'Reports', exact: true });
  await tree.getByRole('link', { name: 'Draft retained on return', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Transfer ownership…', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Transfer ownership', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Search owners', exact: true }).fill('bob@example.test');
  await page.getByRole('radio', { name: /Bob Finance/ }).check();
  await page.getByRole('button', { name: 'Transfer ownership', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Worker report library' })).toBeVisible();
  const transferred = await reporting.client('test-bob').call('get_report', { report_id: initial.report_id });
  expect(transferred.created_by.id).toBe('alice'); expect(transferred.ownership.owner_ref.id).toBe('bob');
});

test('folder ownership uses worker choices and local folders rename from the sidebar', async ({ page, reporting }) => {
  const folder = await reporting.client().call('create_folder', { request_id: crypto.randomUUID(), name: 'Ownership folder' });
  await page.goto(path(reporting.url));
  const tree = page.getByTestId('catalog-sidebar').getByRole('tree', { name: 'Reports', exact: true });
  await tree.getByRole('button', { name: 'Expand Finance report library', exact: true }).click();
  await tree.getByRole('link', { name: 'Ownership folder', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Transfer ownership…', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Transfer ownership', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Search owners', exact: true }).fill('bob@example.test');
  await page.getByRole('radio', { name: /Bob Finance/ }).check();
  await page.getByRole('button', { name: 'Transfer ownership', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Worker report library' })).toBeVisible();
  expect((await reporting.client('test-bob').call('get_folder', { folder_id: folder.folder_id })).created_by.id).toBe('alice');
  await tree.getByRole('link', { name: 'Local', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New folder…', exact: true }).click();
  await page.getByRole('dialog', { name: 'New folder' }).getByRole('textbox', { name: 'Name', exact: true }).fill('Local folder to rename');
  await page.getByRole('button', { name: 'Create folder', exact: true }).click();
  await tree.getByRole('link', { name: 'Local folder to rename', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename…', exact: true }).click();
  await page.getByRole('dialog', { name: 'Rename folder' }).getByRole('textbox', { name: 'Name', exact: true }).fill('Renamed local folder');
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(tree.getByRole('link', { name: 'Renamed local folder', exact: true })).toBeVisible();
});
