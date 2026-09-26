import { BASE, evidencePath } from './helpers';
import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 1500, height: 1100 } });
test('report appearance updates without queries and survives save, copy and reopen', async ({ page }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(evidencePath('evidence/reports'));
  const panel = page.getByTestId('evidence-panel');
  await panel.getByRole('button', { name: 'New report', exact: true }).click();
  await expect(panel.getByTestId('evidence-document')).toContainText('My report', { timeout: 90000 });
  await expect(panel.getByTestId('evidence-document').getByRole('cell', { name: '1.00', exact: true })).toBeVisible();
  await panel.getByLabel('Report title', { exact: true }).fill('Theme test');
  await panel.getByRole('tab', { name: 'Appearance', exact: true }).click();
  const surface = panel.getByTestId('evidence-report-surface');
  const chrome = await panel.locator('header').first().evaluate(el => getComputedStyle(el).backgroundColor);
  await page.evaluate(() => {
    const win = window as any;
    win.__themeWorker = win.__bridge.worker;
    win.__themeCalls = 0;
  });
  // Inspect the adapter's queries instead of replacing the shared bridge API.
  const moduleUrl = new URL('src/lib/evidence/haybarn-query-service.ts', new URL(BASE, page.url()).href).href;
  await page.evaluate(async url => {
    const { HaybarnQueryService } = await import(/* @vite-ignore */ url);
    const original = HaybarnQueryService.prototype.execute;
    HaybarnQueryService.prototype.execute = function (...args: any[]) { (window as any).__themeCalls++; return original.apply(this, args); };
  }, moduleUrl);
  for (const preset of ['paper', 'ocean', 'forest']) {
    await panel.getByLabel('Report theme', { exact: true }).selectOption(preset);
    await expect(panel.getByTestId('evidence-document')).toContainText('My report');
  }
  await panel.getByLabel('Report color mode').selectOption('dark');
  await expect(surface).toHaveAttribute('data-report-mode', 'dark');
  await expect(surface).toHaveCSS('background-color', 'rgb(23, 35, 27)');
  await panel.getByLabel('Report color mode').selectOption('light');
  await panel.getByLabel('Report heading font').selectOption('mono');
  await panel.getByLabel('Report spacing').selectOption('compact');
  await panel.getByLabel('Report chart palette').selectOption('accessible');
  await panel.getByLabel('Report accent color').fill('#8844aa');
  await expect(surface).toHaveCSS('--primary', '#8844aa');
  await expect(panel.getByTestId('evidence-document').getByRole('heading', { name: 'My report' })).toHaveCSS('font-family', /JetBrains Mono/);
  expect(await panel.locator('header').first().evaluate(el => getComputedStyle(el).backgroundColor)).toBe(chrome);
  expect(await page.evaluate(() => (window as any).__themeCalls)).toBe(0);
  expect(await page.evaluate(() => (window as any).__themeWorker === (window as any).__bridge.worker)).toBe(true);
  await panel.getByRole('button', { name: 'Save report', exact: true }).click();
  await page.reload();
  await expect(panel.getByTestId('evidence-document')).toContainText('My report', { timeout: 90000 });
  await panel.getByRole('button', { name: 'Edit report', exact: true }).click();
  await panel.getByRole('tab', { name: 'Appearance', exact: true }).click();
  await expect(panel.getByLabel('Report theme', { exact: true })).toHaveValue('forest');
  await expect(panel.getByLabel('Report accent color')).toHaveValue('#8844aa');
  await panel.getByRole('button', { name: 'Saved reports', exact: true }).click();
  await panel.getByRole('button', { name: 'Copy Theme test', exact: true }).click();
  await panel.getByRole('row').filter({ hasText: 'Theme test (copy)' }).getByRole('button', { name: 'Open report' }).click();
  await panel.getByRole('button', { name: 'Edit report', exact: true }).click();
  await panel.getByRole('tab', { name: 'Appearance', exact: true }).click();
  await expect(panel.getByLabel('Report theme', { exact: true })).toHaveValue('forest');
  await panel.getByRole('button', { name: 'Reset appearance' }).click();
  await expect(panel.getByLabel('Report theme', { exact: true })).toHaveValue('cupola');
  expect(errors).toEqual([]);
});
