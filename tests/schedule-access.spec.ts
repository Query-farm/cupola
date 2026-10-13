import { test, expect } from '@playwright/test';
import { startReportingWorker } from './reporting/worker';
import { encodeReport } from '../src/lib/reporting/body';
import { report } from './reporting/fixtures';
import pkg from '../package.json' with { type: 'json' };

test.setTimeout(120_000);
test.use({ viewport: { width: 1500, height: 1150 } });

for (const variant of ['finite', 'unlimited', 'legacy'] as const) test(`scheduled access follows ${variant} worker policy and discovers optional profile`, async ({ page }) => {
  const maximum = variant === 'unlimited' ? 0 : variant === 'legacy' ? 7 * 86400 : 365 * 86400;
  const worker = await startReportingWorker('Access policy test', `${process.env.CUPOLA_APP_ORIGIN || 'http://localhost:4321'}/v${pkg.version}/report-render`, false, { maximum, legacyIdentity: variant === 'legacy' });
  try {
    const client = worker.client();
    const saved = await client.call('create_report', { request_id: crypto.randomUUID(), ...encodeReport(report('Access policy'), { description: '', tags: [] }) });
    await page.addInitScript(url => sessionStorage.setItem('vgi.oauth.tokens.' + url, JSON.stringify({ access_token: 'test-alice', expires_at: Math.floor(Date.now() / 1000) + 3600, use_id_token: false })), worker.url);
    await page.goto(`reports?service=${encodeURIComponent(worker.url)}&report_service=${encodeURIComponent(worker.url)}&report_id=${saved.report_id}&report_view=schedules&report_schedule=new`);
    const authorize = page.getByRole('button', { name: 'Authorize / renew access', exact: true });
    await expect(authorize).toBeEnabled({ timeout: 45_000 });
    const duration = page.getByLabel('Requested access duration');
    if (variant === 'legacy') {
      await expect(duration).toHaveValue('custom');
      await expect(duration.locator('option')).toHaveCount(1);
      await expect(page.getByText('Worker does not publish a lifetime limit.', { exact: false })).toBeVisible();
      expect(await client.supports('identity.get_current_identity')).toBe(false);
      await page.getByLabel('Access duration in days').fill('180');
    } else {
      await expect(duration).toHaveValue('worker');
      await expect(page.getByText(variant === 'finite' ? 'Worker maximum: 365 days.' : 'Worker permits access without expiration.', { exact: true })).toBeVisible();
      if (variant === 'finite') {
        await duration.selectOption('custom');
        await page.getByLabel('Access duration in days').fill('180');
      }
    }
    await authorize.click();
    await expect(page.getByText(variant === 'unlimited' ? 'Authorized · no expiration' : 'Authorized until', { exact: false })).toBeVisible();
    const [delegation] = await client.call('delegations.list_delegations', {});
    if (variant === 'unlimited') expect(delegation.expires_at).toBeNull();
    else expect((delegation.expires_at! - Date.now()) / 86400000).toBeGreaterThan(variant === 'finite' ? 179 : 6);
    if (variant === 'legacy') expect((delegation.expires_at! - Date.now()) / 86400000).toBeLessThanOrEqual(7);
    await page.getByLabel('Email this report', { exact: true }).check();
    if (variant === 'legacy') {
      await expect(page.getByRole('button', { name: 'Use my email', exact: true })).toHaveCount(0);
      await page.getByLabel('Recipients', { exact: true }).fill('manual@example.test');
    } else {
      await expect(page.getByText('Alice Finance · alice@example.test', { exact: true })).toBeVisible();
      await page.getByLabel('Recipients', { exact: true }).fill('team@example.test');
      await page.getByRole('button', { name: 'Use my email', exact: true }).click();
      await page.getByRole('button', { name: 'Use my email', exact: true }).click();
      await expect(page.getByLabel('Recipients', { exact: true })).toHaveValue('team@example.test, alice@example.test');
      await page.getByLabel('Email me when this schedule needs attention', { exact: true }).check();
      await expect(page.getByRole('button', { name: 'Use my email', exact: true })).toHaveCount(2);
      await page.getByRole('button', { name: 'Use my email', exact: true }).last().click();
      await expect(page.getByLabel('Alert recipients', { exact: true })).toHaveValue('alice@example.test');
    }
    expect(await worker.capturedMailCount()).toBe(0);
  } finally { await worker.stop(); }
});
