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

test('floating schedules send grouped failure alerts and surface recovery in the attention page', async ({ page, scheduler }) => {
  const c = scheduler.client(), beforeMail = await scheduler.capturedMailCount();
  const saved = await c.call('create_report', { request_id: crypto.randomUUID(), ...encodeReport(report('Floating alert report'), { description: '', tags: [] }) });
  await page.addInitScript(({ url }) => sessionStorage.setItem('vgi.oauth.tokens.' + url, JSON.stringify({ access_token: 'test-alice', expires_at: Date.now() / 1000 + 3600 })), { url: scheduler.url });
  await page.goto(`reports?service=${encodeURIComponent(scheduler.url)}&report_service=${encodeURIComponent(scheduler.url)}&report_id=${saved.report_id}&report_view=schedules&report_schedule=new`);
  await expect(page.getByLabel('Version to generate', { exact: true })).toHaveValue('head');
  await page.getByLabel('Email me when this schedule needs attention', { exact: true }).check();
  await page.getByLabel('Alert recipients', { exact: true }).fill('owner@forbidden.test');
  await page.getByRole('button', { name: 'Check alert recipients', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('not allowed');
  await page.getByLabel('Alert recipients', { exact: true }).fill('owner@example.test');
  await page.getByRole('button', { name: 'Check alert recipients', exact: true }).click();
  await expect(page.getByText('1 alert recipient allowed. No email was sent.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Authorize / renew access', exact: true }).click();
  await expect(page.getByText('Authorized until', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Create schedule', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit schedule', exact: true })).toBeVisible();
  const [schedule] = await c.call('schedules.list_schedules', { report_id: saved.report_id });
  expect(schedule.definition.alerts?.destinations).toEqual([{ kind: 'email', address: 'owner@example.test' }]);
  expect(await scheduler.capturedMailCount()).toBe(beforeMail);
  // The schedule was created before this saved revision; head tracking must pick it up.
  const broken = encodeReport({ ...report('Floating alert report'), source: '# Broken\n\n```sql broken\nSELECT * FROM missing_alert_test_table\n```\n\n{% table data="broken" /%}' }, { description: '', tags: [] });
  const revision = await c.call('commit_revision', { request_id: crypto.randomUUID(), report_id: saved.report_id, expected_revision_id: saved.head_revision_id, ...broken });
  await page.getByRole('button', { name: 'Run now', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Failed', exact: true })).toBeVisible({ timeout: 120_000 });
  await expect.poll(() => scheduler.capturedMailCount()).toBe(beforeMail + 1);
  const [run] = await c.call('schedules.list_runs', { schedule_id: schedule.schedule_id });
  expect(run.revision_id).toBe(revision.head_revision_id);
  const message = (await scheduler.capturedMail()).find(text => text.includes('owner@example.test'))!;
  expect(message).toContain('Report schedule failed'); expect(message).not.toContain('missing_alert_test_table');
  await page.goto(`reports?service=${encodeURIComponent(scheduler.url)}&report_view=activity&report_service=all`);
  const activity = page.getByRole('region', { name: 'Schedules & alerts', exact: true });
  const row = activity.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Floating alert report', exact: true }) });
  await expect(row.getByText('Needs attention', { exact: true })).toBeVisible();
  await expect(row.getByRole('link', { name: 'View run', exact: true })).toHaveAttribute('href', new RegExp(run.run_id));
  await page.screenshot({ path: '/tmp/cupola-alert-attention.png', fullPage: true });
  await row.getByRole('link', { name: 'Manage schedule', exact: true }).click();
  await page.getByRole('button', { name: 'Run now', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Failed', exact: true })).toBeVisible({ timeout: 120_000 });
  expect(await scheduler.capturedMailCount()).toBe(beforeMail + 1);
  const fixed = await c.call('commit_revision', { request_id: crypto.randomUUID(), report_id: saved.report_id, expected_revision_id: revision.head_revision_id, ...encodeReport(report('Floating alert report'), { description: '', tags: [] }) });
  const admitted = await c.call('schedules.run_now', { schedule_id: schedule.schedule_id, request_id: crypto.randomUUID() });
  await expect.poll(async () => (await c.call('schedules.get_run', { run_id: admitted.run_id })).status, { timeout: 120_000 }).toBe('succeeded');
  expect((await c.call('schedules.get_run', { run_id: admitted.run_id })).revision_id).toBe(fixed.head_revision_id);
  const healthy = await c.call('schedules.get_schedule', { schedule_id: schedule.schedule_id });
  expect(healthy.issues).toHaveLength(0); expect(healthy.last_successful_at).not.toBeNull();
  await c.call('schedules.delete_schedule', { schedule_id: schedule.schedule_id, expected_version: healthy.version, request_id: crypto.randomUUID() });
});

test('attention combines workers and renewal links clear missing and expiring access', async ({ page, scheduler }) => {
  const second = await startReportingWorker('Research schedules', `${process.env.CUPOLA_APP_ORIGIN || 'http://localhost:4321'}/v${pkg.version}/report-render`);
  const created: Array<{ worker: typeof scheduler; id: string }> = [];
  try {
    for (const [index, worker] of [scheduler, second].entries()) {
      const c = worker.client();
      const saved = await c.call('create_report', { request_id: crypto.randomUUID(), ...encodeReport(report(index ? 'Access expires soon' : 'Access was revoked'), { description: '', tags: [] }) });
      await authorizeSchedules(c, requiredDelegations(worker.url, []), 'Expiry', () => ({ options: null, data_version_spec: '', implementation_version: '' }), 7, () => c);
      const grant = await c.call('identity.issue_grant', { purpose: 'Expiry check', scopes: [], ttl_seconds: 3600n });
      const key = requiredDelegations(worker.url, [])[0], previous = (await c.call('delegations.list_delegations', {})).find(d => d.kind === 'service')!;
      const writes = await c.call('delegations.put_delegations', { request_id: crypto.randomUUID(), delegations: [{ expected_version: previous.version, delegation: { ...key, grant: grant.token, ticket: '', expires_at: grant.expires_at * 1000 } }] });
      const record = await c.call('schedules.create_schedule', { request_id: crypto.randomUUID(), schedule: { ...newSchedule(saved, worker.url), enabled: true, trigger: { kind: 'once', run_at: Date.now() + 7 * 86400_000, cron: null, time_zone: 'UTC', start_at: null, end_at: null } } });
      created.push({ worker, id: record.schedule_id });
      if (!index) await c.call('delegations.revoke_delegation', { key, expected_version: writes.delegations[0].version, request_id: crypto.randomUUID() });
    }
    await page.addInitScript(({ urls }) => { for (const url of urls) sessionStorage.setItem('vgi.oauth.tokens.' + url, JSON.stringify({ access_token: 'test-alice', expires_at: Date.now() / 1000 + 3600 })); }, { urls: [scheduler.url, second.url] });
    await page.goto(`reports?service=${encodeURIComponent(scheduler.url)}`);
    await page.getByTestId('workspace-picker').click(); await page.getByTestId('attach-catalog-open').click();
    const form = page.getByTestId('attach-catalog-form'); await form.getByTestId('attach-catalog-url').fill(second.url);
    await expect(form.getByTestId('attach-catalog-choices')).toBeVisible(); await form.getByTestId('attach-catalog-submit').click(); await expect(form).toBeHidden(); await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Schedules & alerts', exact: true }).click();
    const activity = page.getByRole('region', { name: 'Schedules & alerts', exact: true });
    await expect(activity.getByRole('heading', { name: 'Access was revoked', exact: true })).toBeVisible();
    await expect(activity.getByRole('heading', { name: 'Access expires soon', exact: true })).toBeVisible();
    const row = activity.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Access expires soon', exact: true }) });
    await row.getByRole('link', { name: 'Renew access', exact: true }).click();
    await expect(page.locator('#scheduled-access')).toHaveAttribute('open', '');
    await page.getByRole('button', { name: 'Authorize / renew access', exact: true }).click();
    await expect.poll(async () => (await second.client().call('schedules.get_schedule', { schedule_id: created[1].id })).issues.length).toBe(0);
    await page.getByRole('button', { name: 'All schedules', exact: true }).click();
    await page.getByRole('button', { name: 'Schedules & alerts', exact: true }).click();
    await expect(activity.getByRole('heading', { name: 'Access expires soon', exact: true })).toHaveCount(0);
    await expect(activity.getByRole('heading', { name: 'Access was revoked', exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    for (const { worker, id } of created) { const c = worker.client(); const current = await c.call('schedules.get_schedule', { schedule_id: id }); await c.call('schedules.delete_schedule', { schedule_id: id, expected_version: current.version, request_id: crypto.randomUUID() }); }
    await second.stop();
  }
});

test('create, authorize, preview without mail, send once after a lost reply, edit, pause, and inspect history', async ({ page, scheduler }) => {
  const beforeMail = await scheduler.capturedMailCount();
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
  expect(await scheduler.capturedMailCount()).toBe(beforeMail);
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
  expect(await scheduler.capturedMailCount()).toBe(beforeMail + 1);
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
