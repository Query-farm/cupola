import { evidencePath } from './helpers';
import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 1500, height: 1100 } });
test('report setup and renderer queries can be stopped, time out, and recover on the same worker', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(evidencePath('evidence/reports'));
  const panel = page.getByTestId('evidence-panel');
  await panel.getByRole('button', { name: 'New report', exact: true }).click({ timeout: 90_000 });
  await expect(panel.getByRole('button', { name: 'Update preview', exact: true })).toBeEnabled({ timeout: 90_000 });
  // The button is not a readiness signal (Refresh stays on screen for a moment while a refresh
  // starts); wait for the engine itself.
  await expect.poll(() => page.evaluate(() => typeof (window as any).__bridge?.query === 'function'), { timeout: 90_000 }).toBe(true);
  await expect(panel.getByRole('status', { name: 'Report refresh status' })).toContainText('Updated', { timeout: 90_000 });
  await page.evaluate(() => { (window as any).__refreshWorker = (window as any).__bridge.worker; });
  await page.evaluate(() => (window as any).__bridge.query("CREATE TEMP TABLE __refresh_threads AS SELECT current_setting('threads') AS n"));
  const bound = await page.evaluate(async () => {
    const bridge = (window as any).__bridge;
    return bridge.queryPrepared("SELECT CASE WHEN ? = 'é''?; --' AND ? = true AND ? IS NULL THEN 1 ELSE error('bind mismatch') END /* ? */", ["é'?; --", true, null], { timeoutMs: 60_000 });
  });
  expect(bound.ok, bound.error).toBe(true);
  const preparedTimeout = await page.evaluate(async () => {
    try {
      const result = await (window as any).__bridge.queryPrepared('SELECT sum(i) FROM range(?) t(i)', [1000000000000], { timeoutMs: 100 });
      return result.error || 'did not time out';
    } catch (error) { return String(error); }
  });
  expect(preparedTimeout).toContain('time limit');

  await panel.getByRole('tab', { name: 'Data', exact: true }).click();
  const setup = panel.getByRole('textbox', { name: 'Dataset SQL', exact: true });
  const slow = 'SELECT sum(i) FROM range(1000000000000) t(i)';
  await setup.fill(slow);
  await panel.getByRole('button', { name: 'Update preview', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Stop refresh', exact: true })).toBeVisible();
  await page.waitForTimeout(500); // Let the real worker enter the expensive query.
  await panel.getByRole('button', { name: 'Stop refresh', exact: true }).click();
  await expect(panel.getByRole('status', { name: 'Report refresh status' })).toContainText('Refresh stopped');
  await expect(panel.getByRole('button', { name: 'Update preview', exact: true })).toBeEnabled();
  await setup.fill('SELECT 1');
  await panel.getByRole('button', { name: 'Update preview', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Update preview', exact: true })).toBeEnabled({ timeout: 15_000 });

  await setup.fill('');
  await panel.getByRole('tab', { name: 'Code', exact: true }).click();
  const source = panel.getByRole('textbox', { name: 'Evidence source', exact: true });
  await source.fill('```sql slow\n' + slow + '\n```\n\n{% table data="slow" /%}');
  await panel.getByRole('button', { name: 'Update preview', exact: true }).click();
  await expect(panel.getByTestId('evidence-document')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Stop refresh', exact: true })).toBeVisible();
  await page.waitForTimeout(500); // Let the real worker enter the expensive query.
  await panel.getByRole('button', { name: 'Stop refresh', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Update preview', exact: true })).toBeEnabled();
  await source.fill('# Recovered\n\n```sql quick\nSELECT 42 AS answer\n```\n\n{% table data="quick" /%}');
  await panel.getByRole('button', { name: 'Update preview', exact: true }).click();
  await expect(panel.getByTestId('evidence-document')).toContainText('42', { timeout: 15_000 });
  await expect(panel.getByRole('button', { name: 'Update preview', exact: true })).toBeEnabled();

  await panel.getByRole('tab', { name: 'Data', exact: true }).click();
  await setup.fill(slow);
  await page.clock.install();
  await panel.getByRole('button', { name: 'Update preview', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Stop refresh', exact: true })).toBeVisible();
  await page.clock.fastForward(60_001);
  await expect(panel).toContainText('Query exceeded the 60-second time limit.');
  await setup.fill('SELECT 1');
  await panel.getByRole('button', { name: 'Update preview', exact: true }).click();
  await expect(panel.getByTestId('evidence-document')).toContainText('42', { timeout: 15_000 });
  expect(await page.evaluate(() => (window as any).__refreshWorker === (window as any).__bridge.worker)).toBe(true);
  const restored = await page.evaluate(() => (window as any).__bridge.query("SELECT CASE WHEN current_setting('threads') = n THEN true ELSE error('Thread setting changed') END FROM __refresh_threads"));
  expect(restored.ok, restored.error).toBe(true);
});
