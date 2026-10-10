import { test, expect } from '@playwright/test';
import { evidencePath, EVIDENCE_SERVICE_URL } from './helpers';

test.use({ viewport: { width: 1440, height: 1000 } });

test('filters disclose the displayed values, apply explicitly, and reset to defaults', async ({ page }) => {
  test.setTimeout(150_000);
  await page.addInitScript(serviceUrl => {
    const report = {
      version: 1, id: 'ux-filters', title: 'Regional sales', serviceUrl, createdAt: 1, updatedAt: 1,
      setupSql: '', values: {},
      parameters: [{ id: 'region', key: 'region', label: 'Region', type: 'text', required: true, defaultValue: 'North' }],
      source: '# Regional sales\n\n```sql sales\nSELECT region, amount FROM (VALUES (\'North\', 10), (\'South\', 20)) AS t(region, amount) WHERE region = $region\n```\n\n{% table data="sales" /%}\n\n{% bar_chart data="sales" x="region" y="sum(amount)" /%}',
    };
    localStorage.setItem(`cupola.evidence.report.v2:${encodeURIComponent(serviceUrl)}:${report.id}`, JSON.stringify(report));
  }, EVIDENCE_SERVICE_URL);
  await page.goto(evidencePath('reports?evidence_report=ux-filters'));
  const panel = page.getByTestId('evidence-panel');
  const rows = panel.getByTestId('evidence-document').locator('tbody');
  await expect(rows).toContainText('North', { timeout: 90_000 });
  await panel.getByRole('textbox', { name: 'Region', exact: true }).fill('South');
  await expect(panel.getByLabel('Applied filters', { exact: true })).toHaveText('Results use: Region: North');
  await expect(panel.getByRole('status', { name: 'Unapplied report changes' })).toContainText('Filters have changed');
  await expect(rows).toContainText('North');
  await expect(panel.getByRole('status', { name: 'Save status' })).toHaveText('Saved');
  await expect(panel.getByRole('button', { name: 'Export PDF', exact: true })).toBeDisabled();
  await panel.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(rows).toContainText('South');
  await expect(panel.getByLabel('Applied filters', { exact: true })).toHaveText('Results use: Region: South');
  await expect(panel.getByRole('status', { name: 'Unapplied report changes' })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Reset filters', exact: true }).click();
  await expect(rows).toContainText('North');

  // A setup failure preserves the last rendered output, then a corrected refresh replaces it.
  await panel.getByRole('button', { name: 'Edit report', exact: true }).click();
  await panel.getByRole('tab', { name: 'Setup SQL', exact: true }).click();
  const setup = panel.getByRole('textbox', { name: 'Dataset SQL', exact: true });
  await expect(panel.getByTestId('evidence-document').locator('[data-echarts-ready="true"] canvas').first()).toBeVisible();
  await setup.fill('SELECT * FROM missing_report_ux_table');
  await panel.getByRole('button', { name: 'Update preview', exact: true }).click();
  await expect(panel.getByRole('status', { name: 'Report refresh status' })).toContainText('Refresh failed');
  await expect(panel.getByRole('region', { name: 'Report problems', exact: true }).getByRole('button').filter({ hasText: 'missing_report_ux_table' }).first()).toBeEnabled();
  const retained = panel.getByTestId('retained-report-preview');
  await expect(retained.locator('tbody')).toContainText('North');
  expect(await retained.locator('canvas').first().evaluate((canvas: HTMLCanvasElement) => {
    const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    return pixels.some((value, index) => index % 4 === 3 && value > 0);
  })).toBe(true);
  await expect(panel.getByRole('region', { name: 'Last successful preview' })).toContainText('read-only');
  await setup.fill('SELECT 1');
  await panel.getByRole('button', { name: 'Update preview', exact: true }).click();
  await expect(rows).toContainText('North');
  await expect(retained).toHaveCount(0);
});

test('new reports have runnable starters and explain sharing and local storage', async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto(evidencePath('reports'));
  const panel = page.getByTestId('evidence-panel');
  await panel.getByRole('button', { name: 'New report', exact: true }).click({ timeout: 90_000 });
  await expect(panel.getByText('What would you like to report on?', { exact: true })).toBeVisible();
  await panel.getByRole('region', { name: 'Report starters' }).getByRole('button', { name: 'Summary', exact: true }).click({ timeout: 90_000 });
  await expect(panel.getByTestId('evidence-document')).toContainText('540', { timeout: 30_000 });
  await expect(panel.getByTestId('evidence-document')).toContainText('Sample data');
  await expect(panel.getByRole('textbox', { name: 'Report title', exact: true })).toHaveValue('Sales summary');
  await expect(panel.getByRole('status', { name: 'Save status' })).toHaveText('Saved');
  await panel.getByRole('button', { name: 'Share', exact: true }).click();
  const dialog = page.getByRole('region', { name: 'Share report', exact: true });
  await expect(dialog).toContainText('Saved on this device');
  await expect(dialog).toContainText('Reports → Import');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('button', { name: 'Download editable report' }).click(),
  ]);
  expect(download.suggestedFilename()).toContain('sales-summary');
  await dialog.getByRole('button', { name: 'Back to report', exact: true }).click();

  // At tablet widths the report editor has the entire available pane, with a separate preview.
  await page.setViewportSize({ width: 800, height: 900 });
  await expect(page.getByTestId('catalog-sidebar')).toHaveCount(0);
  const switcher = panel.getByRole('group', { name: 'Report workspace view' });
  await switcher.getByRole('button', { name: 'Editor', exact: true }).click();
  await expect(panel.getByRole('complementary', { name: 'Report editor', exact: true })).toBeVisible();
  await expect(panel.getByRole('region', { name: 'Report preview', exact: true })).not.toBeVisible();
  await panel.getByRole('button', { name: 'All editing tools' }).click();
  await page.getByRole('menuitem', { name: /History/ }).click();
  await expect(panel.getByRole('tab', { name: 'History', exact: true })).toHaveAttribute('aria-selected', 'true');
  await switcher.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(panel.getByTestId('evidence-document')).toBeVisible();
  await expect(panel.getByRole('complementary', { name: 'Report editor', exact: true })).not.toBeVisible();
});
