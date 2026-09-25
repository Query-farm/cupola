import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';

test.use({ channel: 'chrome', viewport: { width: 1500, height: 1100 } });
test('live Evidence report reuses the shell worker across refresh, editing and tabs', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('evidence');
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
  await panel.getByRole('tab', { name: 'Data', exact: true }).click();
  await expect(panel.getByRole('textbox', { name: 'Dataset SQL', exact: true })).toContainText('cupola_weather');
  await panel.getByRole('tab', { name: 'Code', exact: true }).click();
  const source = panel.getByRole('textbox', { name: 'Evidence source', exact: true });
  await source.fill(readFileSync(new URL('../src/lib/evidence/open-meteo.md', import.meta.url), 'utf8').replace('# Your week outdoors', '# Shared engine forecast'));
  await expect(panel.getByText('Changes not applied · Update preview', { exact: true })).toBeVisible();
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
  await panel.getByRole('button', { name: 'Focus report', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Exit focus mode', exact: true })).toBeVisible();
  expect(await page.getByRole('tab', { name: 'Query Editor', exact: true }).evaluate(el => {
    (el as HTMLElement).focus();
    return !!el.closest('[inert]') && document.activeElement !== el;
  })).toBe(true);
  await panel.getByRole('button', { name: 'Exit focus mode', exact: true }).press('Escape');
  await expect(panel.getByRole('button', { name: 'Focus report', exact: true })).toBeVisible();
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
  await page.goto('evidence/reports');
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
  await panel.getByRole('button', { name: 'Save report', exact: true }).click();
  await expect(panel.getByRole('status').filter({ hasText: /^Saved locally$/ })).toBeVisible();
  await expect(panel.getByText('Saved in this browser.', { exact: true })).toHaveCount(0);
  await page.evaluate(() => { (window as any).__savedReportWorker = (window as any).__bridge.worker; });
  await panel.getByRole('button', { name: 'Saved reports', exact: true }).click();
  await expect(page).toHaveURL(/reports\/saved/);
  await expect(panel.getByRole('row').filter({ hasText: 'Parameter round trip' })).toContainText('City, Amount, As of, Include');
  await panel.getByRole('button', { name: 'Open report', exact: true }).click();
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
  await page.addInitScript(() => {
    const base = { version: 1, source: '# Scoped report', setupSql: '', parameters: [], values: {}, createdAt: 1, updatedAt: 1 };
    const reports = [
      { ...base, id: 'same-id', title: 'This worker report', serviceUrl: 'https://vgi-open-meteo.rusty-bb6.workers.dev' },
      { ...base, id: 'same-id', title: 'Other worker report', serviceUrl: 'https://other-worker.example' },
      { ...base, id: 'other-only', title: 'Other private report', serviceUrl: 'https://other-worker.example' },
    ];
    for (const report of reports) localStorage.setItem(`cupola.evidence.report.v2:${encodeURIComponent(report.serviceUrl)}:${encodeURIComponent(report.id)}`, JSON.stringify(report));
  });
  await page.goto('evidence/reports');
  const panel = page.getByTestId('evidence-panel');
  await expect(panel.getByRole('row').filter({ hasText: 'This worker report' })).toBeVisible({ timeout: 90_000 });
  await expect(panel.getByRole('row').filter({ hasText: 'Other worker report' })).toHaveCount(0);
  await expect(panel.getByRole('row').filter({ hasText: 'Other private report' })).toHaveCount(0);
  await page.goto('evidence?evidence_report=other-only');
  await expect(panel.getByRole('alert')).toContainText('not found for this worker', { timeout: 90_000 });
  await expect(panel.getByRole('row').filter({ hasText: 'This worker report' })).toBeVisible();
});
