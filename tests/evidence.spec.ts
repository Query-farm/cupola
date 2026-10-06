import { readFileSync } from 'node:fs';
import { evidencePath, EVIDENCE_SERVICE_URL, replaceEditorText } from './helpers';
import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 1500, height: 1100 } });
test('live Evidence report reuses the shell worker across refresh, editing and tabs', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(evidencePath('evidence'));
  const panel = page.getByTestId('evidence-panel');
  const report = panel.getByTestId('evidence-document');
  await expect(report.getByRole('heading', { name: 'Your week outdoors', exact: true })).toBeVisible({ timeout: 120_000 });
  await expect(panel.getByRole('status', { name: 'Report refresh status' })).toContainText('Connected');
  await expect(report).toContainText('Glen Allen', { timeout: 30_000 });
  await expect(report.getByRole('tab', { name: 'Temperature & wind', exact: true })).toBeVisible();
  await expect(report).toContainText('Daytime highs');
  await expect(report.getByRole('heading', { name: 'Right now', exact: true })).toBeVisible();
  await expect(report).toContainText('Current conditions in both cities');
  for (const title of ['Temperature', 'Humidity', 'Pressure']) {
    await expect(report.locator(`[data-component-title="${title} · next 24 hours"] canvas`)).toBeVisible();
  }
  const nearChecks = await page.evaluate(async () => (window as any).__bridge.query(`
    WITH upcoming AS (
      SELECT * FROM cupola_weather WHERE record_kind = 'hourly'
      QUALIFY row_number() OVER (PARTITION BY location_role ORDER BY time) <= 24
    ), counts AS (
      SELECT location_role, count(*) n, count(DISTINCT time) hour_count,
             date_diff('hour', min(time), max(time)) span,
             bool_and(temperature_f IS NOT NULL AND humidity_pct BETWEEN 0 AND 100
                      AND pressure_hpa > 0) valid_readings
      FROM upcoming GROUP BY 1
    ), current_readings AS (
      SELECT count(*) n, count(DISTINCT location_role) cities,
             bool_and(time IS NOT NULL AND local_time IS NOT NULL AND temperature_f IS NOT NULL
                      AND humidity_pct BETWEEN 0 AND 100 AND pressure_hpa > 0) valid_readings
      FROM cupola_weather WHERE record_kind = 'current'
    )
    SELECT CASE WHEN (SELECT count(*)=2 AND bool_and(n=24 AND hour_count=24 AND span=23 AND valid_readings) FROM counts)
      AND (SELECT n=2 AND cities=2 AND valid_readings FROM current_readings)
      THEN true ELSE error('Invalid current conditions or 24-hour forecast') END
  `));
  expect(nearChecks.ok, nearChecks.error).toBe(true);
  await expect.poll(() => report.locator('canvas').count()).toBeGreaterThanOrEqual(4);
  await expect(report).toContainText('Overnight lows');
  await expect(report).toContainText('Next available forecast hour');
  await expect(report).toContainText('How air quality changes');
  await expect(report).not.toContainText('Find the warmest hours');
  const daily = report.locator('[data-component-title="Daily outlook"]');
  await expect(daily.locator('tbody tr')).toHaveCount(16, { timeout: 30_000 });
  await expect(daily.getByRole('columnheader', { name: 'Δ high', exact: true })).toBeVisible();
  await expect(daily.getByRole('columnheader', { name: 'Δ low', exact: true })).toBeVisible();
  const groups = daily.locator('tbody tr.cursor-pointer');
  await groups.first().click();
  await expect(daily.locator('tbody tr')).toHaveCount(9);
  await groups.first().click();
  await expect(daily.locator('tbody tr')).toHaveCount(16);
  const checks = await page.evaluate(async () => (window as any).__bridge.query(`
    WITH days AS (
      SELECT location_role, count(*) n, count(DISTINCT day) dates,
             date_diff('day', min(day), max(day)) span
      FROM cupola_weather WHERE record_kind = 'daily' GROUP BY 1
    )
    SELECT CASE WHEN count(*) = 2 AND bool_and(n=7 AND dates=7 AND span=6)
      THEN true ELSE error('Expected seven full dates per city') END FROM days
  `));
  expect(checks.ok).toBe(true);
  await report.getByText('Pollutants and forecast coverage', { exact: true }).click();
  await expect(report).toContainText('Hours with AQI data');
  await expect(report).toContainText('Available AQI forecast');
  await report.getByText('Pollutants and forecast coverage', { exact: true }).click();
  await report.getByRole('tab', { name: 'Hourly data', exact: true }).click();
  await expect(report.getByRole('columnheader', { name: 'Hour · UTC', exact: true })).toBeVisible();
  await report.getByRole('tab', { name: 'Temperature & wind', exact: true }).click();
  await expect(report).not.toContainText(/Attribute .* must|Binder Error|Parser Error|Required:/);
  await page.evaluate(() => { (window as any).__evidenceTestWorker = (window as any).__bridge.worker; });
  await page.getByRole('tab', { name: 'Query Editor', exact: true }).click();
  await page.getByRole('tab', { name: 'Reports', exact: true }).click();
  await panel.getByRole('button', { name: 'Refresh report', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Refresh report', exact: true })).toBeEnabled({ timeout: 30_000 });
  await expect(report).toContainText('Glen Allen');
  await panel.getByRole('button', { name: 'Edit report', exact: true }).click();
  const previewBounds = await panel.getByRole('region', { name: 'Report preview', exact: true }).boundingBox();
  const editorBounds = await panel.getByRole('complementary', { name: 'Report editor', exact: true }).boundingBox();
  expect(editorBounds!.x).toBeGreaterThan(previewBounds!.x);
  await panel.getByRole('tab', { name: 'Setup SQL', exact: true }).click();
  await expect(panel.getByRole('textbox', { name: 'Dataset SQL', exact: true })).toContainText('cupola_weather');
  await panel.getByRole('tab', { name: 'Code', exact: true }).click();
  const source = panel.getByRole('textbox', { name: 'Evidence source', exact: true });
  await replaceEditorText(source, readFileSync(new URL('../src/lib/evidence/open-meteo.md', import.meta.url), 'utf8').replace('# Your week outdoors', '# Shared engine forecast'));
  await expect(panel.getByRole('status', { name: 'Changes not applied' })).toBeVisible();
  await panel.getByRole('tab', { name: 'Parameters', exact: true }).click();
  await panel.getByRole('tab', { name: 'Code', exact: true }).click();
  await expect(source).toContainText('Shared engine forecast');
  await source.press('Control+End');
  await panel.getByRole('combobox', { name: 'Insert component', exact: true }).selectOption('Heading');
  await expect(source).toContainText('New section');
  await source.press('Control+Enter');
  await expect(report.getByRole('heading', { name: 'Shared engine forecast', exact: true })).toBeVisible();
  await expect(report).toContainText('Glen Allen');
  await expect(panel.getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(() => {
    const w = window as any;
    return !!w.__evidenceTestWorker && w.__evidenceTestWorker === w.__bridge.worker;
  })).toBe(true);
  expect(errors).toEqual([]);
  expect(await panel.getByRole('form', { name: 'Report inputs' }).evaluate(el => Boolean(el.closest('article')))).toBe(true);
  await expect(panel.getByRole('combobox', { name: 'Jump to section', exact: true })).toHaveCount(0);
  await panel.getByRole('button', { name: 'View report', exact: true }).click();
  await expect(panel.getByLabel('Report editor', { exact: true })).not.toBeVisible();
  await panel.getByRole('heading', { name: 'Day by day', exact: true }).scrollIntoViewIfNeeded();
  await expect.poll(() => panel.getByTestId('evidence-viewer-scroll').evaluate(el => el.scrollTop)).toBeGreaterThan(100);
  await panel.getByRole('button', { name: 'More report actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Focus report', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Exit focus mode', exact: true })).toBeVisible();
  expect(await page.getByRole('tab', { name: 'Query Editor', exact: true }).evaluate(el => {
    (el as HTMLElement).focus();
    return !!el.closest('[inert]') && document.activeElement !== el;
  })).toBe(true);
  await panel.getByRole('button', { name: 'Exit focus mode', exact: true }).press('Escape');
  await expect(panel.getByRole('button', { name: 'More report actions', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 820, height: 900 });
  await panel.getByRole('button', { name: 'Edit report', exact: true }).click();
  await expect(panel.getByRole('textbox', { name: 'Evidence source', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/cupola-evidence-editor-narrow.png' });
  await page.setViewportSize({ width: 1500, height: 1100 });
  await panel.getByRole('button', { name: 'View report', exact: true }).click();
  await page.screenshot({ path: '/tmp/cupola-evidence-chrome.png' });
  const originalClass = await page.evaluate(() => document.documentElement.className);
  const surface = panel.getByTestId('evidence-report-surface');
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  await expect(surface).toHaveAttribute('data-report-mode', 'light');
  const lightBackground = await surface.evaluate(el => getComputedStyle(el).backgroundColor);
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await expect(surface).toHaveAttribute('data-report-mode', 'dark');
  await expect.poll(() => surface.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(lightBackground);
  await page.screenshot({ path: '/tmp/cupola-evidence-dark.png' });
  await page.evaluate(value => { document.documentElement.className = value; }, originalClass);
  expect(errors).toEqual([]);
});


test('saved report library restores typed parameters, source and selected values', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(evidencePath('evidence/reports'));
  const panel = page.getByTestId('evidence-panel');
  await expect(panel.getByRole('heading', { name: 'Saved reports', exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(panel.getByText('No saved reports yet')).toBeVisible();
  await panel.getByRole('button', { name: 'New report', exact: true }).click();
  await panel.getByRole('textbox', { name: 'Report title', exact: true }).fill('Parameter round trip');
  await panel.getByRole('tab', { name: 'Parameters', exact: true }).click();
  const definitions = [
    { name: 'city', label: 'City', type: 'text', value: 'Glen Allen' },
    { name: 'amount', label: 'Amount', type: 'number', value: '12.5' },
    { name: 'as_of', label: 'As of', type: 'date', value: '2026-09-23' },
    { name: 'include', label: 'Include', type: 'boolean', value: 'true' },
  ];
  for (const [index, definition] of definitions.entries()) {
    await panel.getByRole('button', { name: 'Add parameter', exact: true }).click();
    await panel.getByLabel(`Parameter ${index + 1} name`, { exact: true }).fill(definition.name);
    await panel.getByLabel(`Parameter ${index + 1} label`, { exact: true }).fill(definition.label);
    await panel.getByLabel(`Parameter ${index + 1} type`, { exact: true }).selectOption(definition.type);
    const input = panel.getByLabel(`Parameter ${index + 1} default`, { exact: true });
    if (definition.type === 'boolean') await input.selectOption(definition.value); else await input.fill(definition.value);
  }
  const source = '# Parameter check\n\n```sql selected\nSELECT $city AS city, $amount AS amount, $as_of AS as_of, $include AS included\n```\n\n{% table data="selected" /%}';
  await panel.getByRole('tab', { name: 'Code', exact: true }).click();
  await panel.getByLabel('Evidence source', { exact: true }).fill(source);
  await expect(panel.getByRole('button', { name: 'Update preview', exact: true })).toBeEnabled({ timeout: 90_000 });
  const city = "O'Hare'); DROP TABLE data; --";
  await panel.getByLabel('City', { exact: true }).fill(city);
  await panel.getByLabel('Amount', { exact: true }).fill('0');
  await panel.getByLabel('Include', { exact: true }).selectOption('false');
  await panel.getByRole('button', { name: 'Update preview', exact: true }).click();
  await expect(panel.getByTestId('evidence-document')).toContainText(city, { timeout: 30_000 });
  await expect(panel.getByRole('status', { name: 'Save status' })).toHaveText('Saved in this browser');
  await expect(panel.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
  await expect(panel.getByText('Saved in this browser.', { exact: true })).toHaveCount(0);
  await page.evaluate(() => { (window as any).__savedReportWorker = (window as any).__bridge.worker; });
  await panel.getByRole('button', { name: 'Saved reports', exact: true }).click();
  await expect(page).toHaveURL(/reports\/saved/);
  await expect(panel.getByRole('row').filter({ hasText: 'Parameter round trip' })).toContainText('City, Amount, As of, Include');
  await panel.getByRole('button', { name: 'Parameter round trip', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__savedReportWorker === (window as any).__bridge.worker)).toBe(true);
  await expect(panel.getByTestId('evidence-document')).toContainText(city);
  await page.reload();
  await expect(panel.getByLabel('City', { exact: true })).toHaveValue(city, { timeout: 90_000 });
  await expect(panel.getByLabel('Amount', { exact: true })).toHaveValue('0');
  await expect(panel.getByLabel('Include', { exact: true })).toHaveValue('false');
  await expect(panel.getByLabel('As of', { exact: true })).toHaveValue('2026-09-23');
  await panel.getByRole('button', { name: 'Edit report', exact: true }).click();
  await panel.getByRole('tab', { name: 'Code', exact: true }).click();
  await expect(panel.getByLabel('Evidence source', { exact: true })).toContainText('Parameter check');
  await panel.getByRole('tab', { name: 'Parameters', exact: true }).click();
  await expect(panel.getByLabel('Parameter 1 default', { exact: true })).toHaveValue('Glen Allen');
  await expect(panel.getByTestId('evidence-document')).toContainText(city, { timeout: 30_000 });
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Saved reports', exact: true }).click();
  await panel.getByRole('button', { name: 'Copy Parameter round trip', exact: true }).click();
  await expect(page).toHaveURL(/reports\/saved/);
  await expect(panel.getByRole('row').filter({ hasText: 'Parameter round trip' })).toHaveCount(2);
  page.once('dialog', dialog => dialog.accept());
  await panel.getByRole('button', { name: 'Delete Parameter round trip (copy)', exact: true }).click();
  await expect(panel.getByRole('row').filter({ hasText: 'Parameter round trip' })).toHaveCount(1);
  await page.reload();
  await expect(panel.getByRole('row').filter({ hasText: 'Parameter round trip' })).toHaveCount(1, { timeout: 90_000 });
  expect(errors).toEqual([]);
  await page.screenshot({ path: '/tmp/cupola-evidence-library.png' });
});

test('saved reports list and direct links are scoped to the active worker URL', async ({ page }) => {
  await page.addInitScript((serviceUrl) => {
    const base = { version: 1, source: '# Scoped report', setupSql: '', parameters: [], values: {}, createdAt: 1, updatedAt: 1 };
    const reports = [
      { ...base, id: 'same-id', title: 'This worker report', serviceUrl },
      { ...base, id: 'same-id', title: 'Other worker report', serviceUrl: 'https://other-worker.example' },
      { ...base, id: 'other-only', title: 'Other private report', serviceUrl: 'https://other-worker.example' },
    ];
    for (const report of reports) localStorage.setItem(`cupola.evidence.report.v2:${encodeURIComponent(report.serviceUrl)}:${encodeURIComponent(report.id)}`, JSON.stringify(report));
  }, EVIDENCE_SERVICE_URL);
  await page.goto(evidencePath('evidence/reports'));
  const panel = page.getByTestId('evidence-panel');
  await expect(panel.getByRole('row').filter({ hasText: 'This worker report' })).toBeVisible({ timeout: 90_000 });
  await expect(panel.getByRole('row').filter({ hasText: 'Other worker report' })).toHaveCount(0);
  await expect(panel.getByRole('row').filter({ hasText: 'Other private report' })).toHaveCount(0);
  await page.goto(evidencePath('evidence?evidence_report=other-only'));
  await expect(page).toHaveURL(/reports\/saved/);
  await expect(panel.getByRole('row').filter({ hasText: 'This worker report' })).toBeVisible();
  await expect(panel.getByRole('row').filter({ hasText: 'Other private report' })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Back to report', exact: true })).toHaveCount(0);
});

test('reports export to a file and import, from another worker, into the saved reports', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript((serviceUrl) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    const report = { version: 1, id: 'shared', title: 'Shared report', serviceUrl, source: '# Shared report', setupSql: 'CREATE OR REPLACE TEMP TABLE shared_t AS SELECT 1 AS n',
      parameters: [{ id: 'p', key: 'n', label: 'N', type: 'number', required: false, defaultValue: 3 }], values: { n: 4 }, drillPaths: [], createdAt: 1, updatedAt: 1 };
    localStorage.setItem(`cupola.evidence.report.v2:${encodeURIComponent(serviceUrl)}:shared`, JSON.stringify(report));
  }, EVIDENCE_SERVICE_URL);
  await page.goto(evidencePath('evidence/reports'));
  const panel = page.getByTestId('evidence-panel');
  const row = (title: string) => panel.getByRole('row').filter({ hasText: title });
  await expect(row('Shared report')).toBeVisible({ timeout: 90_000 });

  const [download] = await Promise.all([page.waitForEvent('download'), panel.getByRole('button', { name: 'Export Shared report', exact: true }).click()]);
  expect(download.suggestedFilename()).toBe('shared-report.cupola-reports.json');
  const file = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(file);
  const exported = JSON.parse(readFileSync(file, 'utf8'));
  expect(exported).toMatchObject({ format: 'cupola-evidence-reports', version: 2, reports: [{ id: 'shared', setupSql: 'CREATE OR REPLACE TEMP TABLE shared_t AS SELECT 1 AS n', values: { n: 4 } }] });

  // As someone else would: from a file made on another worker, into an empty library.
  page.once('dialog', dialog => dialog.accept());
  await panel.getByRole('button', { name: 'Delete Shared report', exact: true }).click();
  await expect(row('Shared report')).toHaveCount(0);
  const input = panel.getByLabel('Report files to import');
  const fromElsewhere = { ...exported, reports: exported.reports.map((item: object) => ({ ...item, serviceUrl: 'https://other-worker.example' })) };
  await input.setInputFiles({ name: 'shared.cupola-reports.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fromElsewhere)) });
  await expect(panel.getByRole('status').filter({ hasText: 'Imported 1 report.' })).toBeVisible();
  await expect(row('Shared report')).toHaveCount(1);
  // Saved against this worker, so it opens here.
  await panel.getByRole('button', { name: 'Open report', exact: true }).click();
  await expect(panel.getByTestId('evidence-document')).toContainText('Shared report', { timeout: 60_000 });
  await panel.getByRole('button', { name: 'Saved reports', exact: true }).click();

  // The same file again changes nothing; a changed one replaces it, or is kept beside it.
  await input.setInputFiles({ name: 'shared.cupola-reports.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fromElsewhere)) });
  await expect(panel.getByRole('status').filter({ hasText: 'Imported 0 reports (1 already saved).' })).toBeVisible();
  const changed = { ...fromElsewhere, reports: [{ ...fromElsewhere.reports[0], source: '# Shared report v2' }] };
  page.once('dialog', dialog => dialog.dismiss());
  await input.setInputFiles({ name: 'changed.cupola-reports.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(changed)) });
  await expect(panel.getByRole('status').filter({ hasText: 'Imported 1 report (1 kept as a copy).' })).toBeVisible();
  await expect(row('Shared report (imported)')).toHaveCount(1);
  page.once('dialog', dialog => dialog.accept());
  await input.setInputFiles({ name: 'changed.cupola-reports.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(changed)) });
  await expect(panel.getByRole('status').filter({ hasText: 'Imported 1 report (1 replaced).' })).toBeVisible();

  // A file that isn't a report file says so.
  await input.setInputFiles({ name: 'notes.json', mimeType: 'application/json', buffer: Buffer.from('{"hello": 1}') });
  await expect(panel.getByRole('alert')).toContainText('notes.json: This is not a Cupola report file.');
  expect(errors).toEqual([]);
});

test('an earlier revision can be removed from the history; the latest cannot', async ({ page }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript((serviceUrl) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    const report = { version: 1, id: 'pruned', title: 'Pruned report', serviceUrl, source: '# Pruned report\n\nFirst paragraph.', setupSql: '', parameters: [], values: {}, createdAt: 1, updatedAt: 1000 };
    localStorage.setItem(`cupola.evidence.report.v2:${encodeURIComponent(serviceUrl)}:pruned`, JSON.stringify(report));
  }, EVIDENCE_SERVICE_URL);
  await page.goto(evidencePath('evidence?evidence_report=pruned'));
  const panel = page.getByTestId('evidence-panel');
  await expect(panel.getByTestId('evidence-document')).toContainText('First paragraph.', { timeout: 90_000 });
  await panel.getByRole('button', { name: 'Edit report', exact: true }).click();
  await panel.getByLabel('Report title').fill('Pruned report, retitled');
  await expect(panel.getByRole('status', { name: 'Save status' })).toHaveText('Saved in this browser');
  await panel.getByRole('tab', { name: 'History', exact: true }).click();
  const revisions = panel.getByRole('list', { name: 'Revisions, newest first' });
  await expect(revisions.getByRole('listitem')).toHaveCount(2);

  // The latest version is the saved report: it can be restored, not removed.
  await revisions.getByRole('button', { name: /Changed Title/ }).click();
  await expect(panel.getByRole('button', { name: 'Restore this version' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Remove from history' })).toHaveCount(0);

  // Removing asks first; Cancel keeps it.
  await revisions.getByRole('button', { name: /Saved before revision history began/ }).click();
  await panel.getByRole('button', { name: 'Remove from history' }).click();
  await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(revisions.getByRole('listitem')).toHaveCount(2);
  await panel.getByRole('button', { name: 'Remove from history' }).click();
  await panel.getByRole('group', { name: 'Confirm removing this version' }).getByRole('button', { name: 'Remove', exact: true }).click();

  // What's left is now the first version, and the report itself is unchanged.
  await expect(revisions.getByRole('listitem')).toHaveCount(1);
  await expect(revisions.getByRole('listitem').nth(0)).toContainText('First saved version');
  await expect(panel.getByLabel('Report title')).toHaveValue('Pruned report, retitled');
  const stored = await page.evaluate(() => {
    const key = Object.keys(localStorage).find(key => key.startsWith('cupola.evidence.history.v1:') && key.endsWith(':pruned'))!;
    return JSON.parse(localStorage.getItem(key)!) as { revisions: { kind: string }[]; blobs: Record<string, string> };
  });
  expect(stored.revisions.map(revision => revision.kind)).toEqual(['edit']);
  expect(Object.values(stored.blobs)).not.toContain('"Pruned report"');
  expect(errors).toEqual([]);
});

test('saving keeps revisions: who changed what, a diff, restore, and the history travels in report files', async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript((serviceUrl) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    const report = { version: 1, id: 'revised', title: 'Revised report', serviceUrl, source: '# Revised report\n\nFirst paragraph.', setupSql: '', parameters: [], values: {}, createdAt: 1, updatedAt: 1000 };
    localStorage.setItem(`cupola.evidence.report.v2:${encodeURIComponent(serviceUrl)}:revised`, JSON.stringify(report));
  }, EVIDENCE_SERVICE_URL);
  await page.goto(evidencePath('evidence?evidence_report=revised'));
  const panel = page.getByTestId('evidence-panel');
  await expect(panel.getByTestId('evidence-document')).toContainText('First paragraph.', { timeout: 90_000 });
  await panel.getByRole('button', { name: 'Edit report', exact: true }).click();
  await panel.getByLabel('Report title').fill('Revised report, retitled');
  await expect(panel.getByRole('status', { name: 'Save status' })).toHaveText('Saved in this browser');
  await panel.getByRole('tab', { name: 'History', exact: true }).click();
  const revisions = panel.getByRole('list', { name: 'Revisions, newest first' });
  // The version saved before history began opens it; the save is labelled with what changed.
  await expect(revisions.getByRole('listitem')).toHaveCount(2);
  await expect(revisions.getByRole('listitem').nth(0)).toContainText('Changed Title');
  await expect(revisions.getByRole('listitem').nth(0)).toContainText('You');
  await expect(revisions.getByRole('listitem').nth(1)).toContainText('Saved before revision history began');
  await revisions.getByRole('button', { name: /Changed Title/ }).click();
  const diff = panel.getByLabel('Title changes');
  await expect(diff).toContainText('- Revised report');
  await expect(diff).toContainText('+ Revised report, retitled');

  // Restore the first version, and save it: a revision saying so.
  await revisions.getByRole('button', { name: /Saved before revision history began/ }).click();
  await panel.getByRole('button', { name: 'Restore this version' }).click();
  await expect(panel.getByLabel('Report title')).toHaveValue('Revised report');
  await expect(panel.getByRole('status', { name: 'Save status' })).toHaveText('Saved in this browser');
  await expect(revisions.getByRole('listitem')).toHaveCount(3);
  await expect(revisions.getByRole('listitem').nth(0)).toContainText(/Restored the version of .*\(Saved before revision history began\)/);

  // The file carries the history, and importing it elsewhere brings the history back.
  await panel.getByRole('button', { name: 'Saved reports', exact: true }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), panel.getByRole('button', { name: 'Export Revised report', exact: true }).click()]);
  const file = testInfo.outputPath('revised.cupola-reports.json');
  await download.saveAs(file);
  const exported = JSON.parse(readFileSync(file, 'utf8'));
  expect(exported.version).toBe(2);
  expect(exported.reports[0].history.revisions.map((revision: { kind: string }) => revision.kind)).toEqual(['baseline', 'edit', 'restore']);
  page.once('dialog', dialog => dialog.accept());
  await panel.getByRole('button', { name: 'Delete Revised report', exact: true }).click();
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('cupola.evidence.history.v1:')))).toEqual([]);
  await panel.getByLabel('Report files to import').setInputFiles(file);
  await expect(panel.getByRole('status').filter({ hasText: 'Imported 1 report.' })).toBeVisible();
  await panel.getByRole('button', { name: 'Open report', exact: true }).click();
  await panel.getByRole('button', { name: 'Edit report', exact: true }).click();
  await panel.getByRole('tab', { name: 'History', exact: true }).click();
  // Nothing changed on the way, so the import adds no revision of its own.
  await expect(revisions.getByRole('listitem')).toHaveCount(3);
  expect(errors).toEqual([]);
});

test('reports save themselves, on close too, and a draft that cannot be saved is recovered', async ({ page }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript((serviceUrl) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    const report = { version: 1, id: 'autosaved', title: 'Autosaved report', serviceUrl, source: '# Autosaved report', setupSql: '', parameters: [], values: {}, createdAt: 1, updatedAt: 1000 };
    localStorage.setItem(`cupola.evidence.report.v2:${encodeURIComponent(serviceUrl)}:autosaved`, JSON.stringify(report));
  }, EVIDENCE_SERVICE_URL);
  const stored = () => page.evaluate((serviceUrl) => JSON.parse(localStorage.getItem(`cupola.evidence.report.v2:${encodeURIComponent(serviceUrl)}:autosaved`)!).title, EVIDENCE_SERVICE_URL);
  await page.goto(evidencePath('evidence?evidence_report=autosaved'));
  const panel = page.getByTestId('evidence-panel');
  const status = panel.getByRole('status', { name: 'Save status' });
  await expect(panel.getByTestId('evidence-document')).toContainText('Autosaved report', { timeout: 90_000 });
  await panel.getByRole('button', { name: 'Edit report', exact: true }).click();
  const title = panel.getByLabel('Report title');

  // Shortly after an edit, with nothing pressed.
  await title.fill('Autosaved once');
  await expect(status).toHaveText('Saved in this browser');
  expect(await stored()).toBe('Autosaved once');

  // A tab closed straight after an edit, before the delay: saved on the way out.
  await title.fill('Saved on close');
  await page.reload();
  await expect(panel.getByTestId('evidence-document')).toBeVisible({ timeout: 90_000 });
  expect(await stored()).toBe('Saved on close');

  // A blank title is a title being retyped: it saves as "Untitled report" and the field stays blank.
  await panel.getByRole('button', { name: 'Edit report', exact: true }).click();
  await title.fill('');
  await expect(status).toHaveText('Saved in this browser');
  expect(await stored()).toBe('Untitled report');
  await expect(title).toHaveValue('');

  // A draft that can't be saved (a parameter with no name) says so, keeps the draft, and brings it back next time.
  await panel.getByRole('tab', { name: 'Parameters', exact: true }).click();
  await panel.getByRole('button', { name: 'Add parameter', exact: true }).click();
  await panel.getByLabel('Parameter 1 name').fill('');
  await expect(status).toContainText('Not saved: parameters');
  await expect(panel.getByRole('button', { name: 'Retry save' })).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await page.reload();
  await expect(panel.getByText('Recovered changes that could not be saved when this report was last open.')).toBeVisible({ timeout: 90_000 });
  await panel.getByRole('tab', { name: 'Parameters', exact: true }).click();
  await expect(panel.getByLabel('Parameter 1 name')).toHaveValue('');
  await panel.getByLabel('Parameter 1 name').fill('fixed');
  await expect(status).toHaveText('Saved in this browser');
  await title.fill('Fixed title');
  await expect(status).toHaveText('Saved in this browser');
  expect(await stored()).toBe('Fixed title');
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('cupola.evidence.draft.v1:')))).toEqual([]);

  // One editing session is one revision: the first page load's two titles are one, the second
  // page load's edits another, the fix after the reload a third, after the version saved before
  // history began.
  await panel.getByRole('tab', { name: 'History', exact: true }).click();
  const revisions = panel.getByRole('list', { name: 'Revisions, newest first' }).getByRole('listitem');
  await expect(revisions).toHaveCount(4);
  await revisions.nth(2).getByRole('button').first().click();
  await expect(panel.getByLabel('Title changes')).toContainText('- Autosaved report');
  await expect(panel.getByLabel('Title changes')).toContainText('+ Saved on close');
  expect(errors).toEqual([]);
});

// A new report that never saved (it didn't validate) isn't lost with its tab: its URL names it, so
// a reload reopens the draft, and the library lists it until it saves.
test('a new report that never saved comes back after its tab closes', async ({ page }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const savedKeys = () => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('cupola.evidence.report.')));
  await page.goto(evidencePath('evidence/reports'));
  const panel = page.getByTestId('evidence-panel');
  await panel.getByRole('button', { name: 'New report', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Update preview', exact: true })).toBeEnabled({ timeout: 90_000 });
  const id = new URL(page.url()).searchParams.get('evidence_report');
  expect(id).toBeTruthy();
  const status = panel.getByRole('status', { name: 'Save status' });
  await panel.getByRole('tab', { name: 'Parameters', exact: true }).click();
  await panel.getByRole('button', { name: 'Add parameter', exact: true }).click();
  await panel.getByLabel('Parameter 1 name').fill('');
  await expect(status).toContainText('Not saved: parameters');
  expect(await savedKeys()).toEqual([]);

  page.once('dialog', dialog => dialog.accept());
  await page.reload();
  await expect(panel.getByText('Recovered changes that could not be saved when this report was last open.')).toBeVisible({ timeout: 90_000 });
  await panel.getByRole('tab', { name: 'Parameters', exact: true }).click();
  await expect(panel.getByLabel('Parameter 1 name')).toHaveValue('');

  // Opened without its URL: the library offers it.
  page.once('dialog', dialog => dialog.accept());
  await page.goto(evidencePath('evidence/reports'));
  const unsaved = panel.getByRole('region', { name: 'Unsaved reports' });
  await expect(unsaved).toContainText('Untitled report', { timeout: 90_000 });
  await unsaved.getByRole('button', { name: 'Continue editing', exact: true }).click();
  expect(new URL(page.url()).searchParams.get('evidence_report')).toBe(id);
  await panel.getByRole('tab', { name: 'Parameters', exact: true }).click();
  await panel.getByLabel('Parameter 1 name').fill('fixed');
  await expect(status).toHaveText('Saved in this browser');
  expect(await savedKeys()).toHaveLength(1);
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('cupola.evidence.draft.v1:')))).toEqual([]);
  await panel.getByRole('button', { name: 'Saved reports', exact: true }).click();
  await expect(panel.getByRole('region', { name: 'Unsaved reports' })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Open report', exact: true })).toHaveCount(1);
  expect(errors).toEqual([]);
});

// Reports saved before revisions existed, in either storage format, keep working: the first change
// saves them in the current format and opens their history with the version they were.
test('reports saved before revision history migrate on their first change', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const updatedAt = Date.UTC(2025, 0, 15, 12);
  await page.addInitScript(([serviceUrl, updatedAt]) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    // The oldest format: keyed by id alone, without the fields added since (drill paths, appearance…).
    localStorage.setItem('cupola.evidence.report.v1:legacy', JSON.stringify({ version: 1, id: 'legacy', title: 'Legacy report', serviceUrl, source: '# Legacy report', setupSql: '', parameters: [], values: {}, createdAt: 1, updatedAt }));
  }, [EVIDENCE_SERVICE_URL, updatedAt] as const);
  await page.goto(evidencePath('evidence?evidence_report=legacy'));
  const panel = page.getByTestId('evidence-panel');
  await expect(panel.getByTestId('evidence-document')).toContainText('Legacy report', { timeout: 90_000 });
  // Opening it changes nothing: no save, no history.
  await page.waitForTimeout(2_000);
  const keys = () => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('cupola.evidence.')).sort());
  expect(await keys()).toEqual(['cupola.evidence.report.v1:legacy']);
  await panel.getByRole('button', { name: 'Edit report', exact: true }).click();
  await panel.getByRole('tab', { name: 'History', exact: true }).click();
  await expect(panel.getByText(/^No revisions yet/)).toBeVisible();

  await panel.getByLabel('Report title').fill('Legacy report, edited');
  await expect(panel.getByRole('status', { name: 'Save status' })).toHaveText('Saved in this browser');
  const encoded = encodeURIComponent(EVIDENCE_SERVICE_URL);
  expect(await keys()).toEqual([`cupola.evidence.history.v1:${encoded}:legacy`, `cupola.evidence.report.v2:${encoded}:legacy`]);
  const revisions = panel.getByRole('list', { name: 'Revisions, newest first' }).getByRole('listitem');
  await expect(revisions).toHaveCount(2);
  await expect(revisions.nth(0)).toContainText('Changed Title');
  // The version it was, dated when it was last saved.
  await expect(revisions.nth(1)).toContainText('Saved before revision history began');
  await expect(revisions.nth(1).locator('time')).toHaveAttribute('datetime', new Date(updatedAt).toISOString());
  await revisions.nth(1).getByRole('button').first().click();
  await panel.getByRole('button', { name: 'Restore this version' }).click();
  await expect(panel.getByLabel('Report title')).toHaveValue('Legacy report');
  await expect(revisions).toHaveCount(3);
  expect(errors).toEqual([]);
});
