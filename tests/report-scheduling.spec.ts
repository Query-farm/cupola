import { test as base, expect } from '@playwright/test';
import { startReportingWorker } from './reporting/worker';
import { report } from './reporting/fixtures';
import { encodeReport } from '../src/lib/reporting/body';
import { chooseReportAction } from './helpers';
import { authorizeSchedules, newSchedule, requiredDelegations } from '../src/lib/reporting/schedules';
import { readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const test = base.extend<{}, { scheduler: Awaited<ReturnType<typeof startReportingWorker>> }>({
  scheduler: [async ({}, use) => {
    const worker = await startReportingWorker('Scheduling test library', `${process.env.CUPOLA_APP_ORIGIN || 'http://localhost:4321'}/v${pkg.version}/report-render`);
    try { await use(worker); } finally { await worker.stop(); }
  }, { scope: 'worker' }],
});

test('schedule drafts survive reload and status polling never overwrites a concurrent edit', async ({ page, scheduler }) => {
  const c = scheduler.client();
  const saved = await c.call('create_report', { request_id: crypto.randomUUID(), ...encodeReport(report('Concurrent schedule'), { description: '', tags: [] }) });
  await authorizeSchedules(c, requiredDelegations(scheduler.url, []), 'Conflict test', () => ({ options: null, data_version_spec: '', implementation_version: '' }), 7, () => c);
  const original = await c.call('schedules.create_schedule', { request_id: crypto.randomUUID(), schedule: newSchedule(saved, scheduler.url) });
  await page.addInitScript(({ url }) => sessionStorage.setItem('vgi.oauth.tokens.' + url, JSON.stringify({ access_token: 'test-alice', expires_at: Date.now() / 1000 + 3600 })), { url: scheduler.url });
  let lists = 0; page.on('response', response => { if (response.url().includes('/list_schedules')) lists++; });
  await page.goto(`reports?service=${encodeURIComponent(scheduler.url)}&report_service=${encodeURIComponent(scheduler.url)}&report_id=${saved.report_id}&report_view=schedules&report_schedule=${original.schedule_id}&report_schedule_edit=1#token=test-alice`);
  await page.getByLabel('Schedule name', { exact: true }).fill('My preserved draft');
  await page.reload();
  await expect(page.getByLabel('Schedule name', { exact: true })).toHaveValue('My preserved draft');
  const changed = await c.call('schedules.update_schedule', { schedule_id: original.schedule_id, expected_version: original.version, request_id: crypto.randomUUID(), schedule: { ...original.definition, title: 'Another author’s changes' } });
  const reads = lists;
  await expect.poll(() => lists, { timeout: 15_000 }).toBeGreaterThan(reads);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('changed on the worker');
  await expect(page.getByLabel('Schedule name', { exact: true })).toHaveValue('My preserved draft');
  expect((await c.call('schedules.get_schedule', { schedule_id: original.schedule_id })).version).toBe(changed.version);
  await page.getByRole('button', { name: 'Discard draft and load current schedule', exact: true }).click();
  await expect(page.getByLabel('Schedule name', { exact: true })).toHaveValue('Another author’s changes');
  await page.getByRole('button', { name: 'Back to schedule', exact: true }).click();
  await page.getByRole('button', { name: 'Delete schedule', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm deletion', exact: true }).click();
  await expect.poll(async () => (await c.call('schedules.list_schedules', { report_id: saved.report_id })).length).toBe(0);
});

test('saved reports remain usable when their worker does not implement schedules', async ({ page }) => {
  const worker = await startReportingWorker('Storage only');
  try {
    const saved = await worker.client().call('create_report', { request_id: crypto.randomUUID(), ...encodeReport(report('Stored report'), { description: '', tags: [] }) });
    await page.goto(`reports?service=${encodeURIComponent(worker.url)}&report_service=${encodeURIComponent(worker.url)}&report_id=${saved.report_id}#token=test-alice`);
    await chooseReportAction(page, 'Schedules & email');
    await expect(page.getByText('Scheduling is not available on this worker', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New schedule', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Back to report', exact: true }).click();
    await expect(page.getByRole('button', { name: 'More report actions', exact: true })).toBeVisible();
  } finally { await worker.stop(); }
});
test.use({ viewport: { width: 1440, height: 1100 }, actionTimeout: 30_000 });
test.setTimeout(240_000);

test('create, authorize, preview without mail, send once after a lost reply, edit, pause, and inspect history', async ({ page, scheduler }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const c = scheduler.client();
  const encoded = encodeReport({ ...report('Weekly finance email'), requires: [{ alias: 'yfinance', catalogName: 'yfinance', url: scheduler.url }] }, { description: '', tags: [] });
  const saved = await c.call('create_report', { request_id: crypto.randomUUID(), ...encoded });
  await page.goto(`reports?service=${encodeURIComponent(scheduler.url)}&report_service=${encodeURIComponent(scheduler.url)}&report_id=${saved.report_id}#token=test-alice`);
  await chooseReportAction(page, 'Schedules & email');
  await page.getByRole('button', { name: 'New schedule', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'New schedule', exact: true })).toBeVisible();
  await page.getByLabel('Schedule name', { exact: true }).fill('Monday finance brief');
  await page.getByLabel('Frequency', { exact: true }).selectOption('weekly');
  await page.getByLabel('Time zone', { exact: true }).fill('America/New_York');
  await page.getByLabel('Day', { exact: true }).selectOption('1');
  await page.getByLabel('Email this report', { exact: true }).check();
  await page.getByLabel('Recipients', { exact: true }).fill('reader@forbidden.test');
  await page.getByRole('button', { name: 'Check recipients', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('not allowed');
  await page.getByLabel('Recipients', { exact: true }).fill('reader@example.test');
  await page.getByRole('button', { name: 'Check recipients', exact: true }).click();
  await expect(page.getByRole('status')).toContainText(['1 recipient allowed']);
  await page.getByRole('button', { name: 'Authorize / renew access', exact: true }).click();
  await expect(page.getByText('Authorized until', { exact: false })).toHaveCount(2, { timeout: 20_000 });
  await page.screenshot({ path: '/tmp/cupola-scheduling-form.png', fullPage: true });
  await page.getByRole('button', { name: 'Preview without sending', exact: true }).click();
  await expect(page.getByText('No email was sent.', { exact: false })).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole('link', { name: 'report.pdf', exact: true })).toBeVisible();
  expect(await c.call('schedules.list_runs', {})).toHaveLength(0);
  expect(await scheduler.capturedMailCount()).toBe(0);
  await page.getByRole('button', { name: 'Create schedule', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit schedule', exact: true })).toBeVisible();
  const schedules = await c.call('schedules.list_schedules', { report_id: saved.report_id });
  expect(schedules).toHaveLength(1); const scheduleId = schedules[0].schedule_id;
  expect(schedules[0].definition.enabled).toBe(false);
  expect(schedules[0].definition.deliveries[0].inline).toBe('report');
  expect(schedules[0].definition.deliveries[0].attach).toEqual(['application/pdf']);
  let drop = true;
  await page.route('**/run_now', async route => { const response = await route.fetch(); if (drop) { drop = false; await route.abort('failed'); } else await route.fulfill({ response }); });
  await page.getByRole('button', { name: 'Run & send now', exact: true }).click();
  await expect(page.getByText('A request is awaiting confirmation', { exact: true })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Confirm pending request', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Schedule run', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Succeeded', exact: true })).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText('reader@example.test', { exact: true })).toBeVisible();
  expect(await c.call('schedules.list_runs', { schedule_id: scheduleId })).toHaveLength(1);
  const [run] = await c.call('schedules.list_runs', { schedule_id: scheduleId });
  expect(run.destination_results[0].status).toBe('accepted');
  expect(await scheduler.capturedMailCount()).toBe(1);
  await page.screenshot({ path: '/tmp/cupola-scheduling-run.png', fullPage: true });
  await page.getByRole('button', { name: 'Back to schedule', exact: true }).click();
  await page.getByRole('button', { name: 'Edit schedule', exact: true }).click();
  await page.getByLabel('Schedule name', { exact: true }).fill('Updated finance brief');
  await page.getByLabel('Enable automatic runs after saving').check();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause schedule', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Pause schedule', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Enable schedule', exact: true })).toBeVisible();
  expect((await c.call('schedules.get_schedule', { schedule_id: scheduleId })).definition.enabled).toBe(false);
  // Opaque credentials must never appear in the browser's persistent recovery journal.
  expect(await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('cupola.reporting.')).some(k => /"grant"|"ticket"/.test(localStorage.getItem(k) || '')))).toBe(false);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/cupola-scheduling-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
