import { test, expect } from '@playwright/test';
import { gotoApp, waitForShellBridge } from './helpers';

test.use({ channel: 'chrome', viewport: { width: 1500, height: 1100 } });
test('Reports starts at the list and preserves an opened report across tab switches and saved links', async ({ page }) => {
  await gotoApp(page);
  await waitForShellBridge(page);
  await page.getByTestId('tab-reports').click();
  const panel = page.getByTestId('evidence-panel');
  const list = panel.getByRole('heading', { name: 'Saved reports', exact: true });
  await expect(list).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Back to report', exact: true })).toHaveCount(0);
  await expect(panel.getByTestId('evidence-document')).toHaveCount(0);
  await expect(page).toHaveURL(/reports\/saved/);

  await page.getByTestId('tab-catalog').click();
  await page.getByTestId('tab-reports').click();
  await expect(list).toBeVisible();
  await panel.getByRole('button', { name: 'New report', exact: true }).click();
  const title = panel.getByRole('textbox', { name: 'Report title', exact: true });
  await title.fill('Session report');
  await page.getByTestId('tab-catalog').click();
  await page.getByTestId('tab-reports').click();
  await expect(title).toHaveValue('Session report');
  await panel.getByRole('button', { name: 'Save report', exact: true }).click();
  await expect(page).toHaveURL(/evidence_report=/);
  await panel.getByRole('button', { name: 'Saved reports', exact: true }).click();
  await expect(list).toBeVisible();
  await panel.getByRole('button', { name: 'Back to report', exact: true }).click();
  await expect(title).toHaveValue('Session report');

  await page.reload();
  await expect(panel.getByRole('button', { name: 'Edit report', exact: true })).toBeVisible();
  await expect(panel.getByText('Session report', { exact: true }).first()).toBeVisible();
  await expect(list).toHaveCount(0);
});

test('editor navigation stays on one row and reveals the selected tab at variable widths', async ({ page }) => {
  test.setTimeout(120000);
  await page.goto('evidence/reports');
  const panel = page.getByTestId('evidence-panel');
  await panel.getByRole('button', { name: 'New report', exact: true }).click();
  const nav = panel.getByTestId('evidence-editor-navigation');
  await expect(nav).toBeVisible({ timeout: 90000 });
  async function checkRow() {
    const boxes = await nav.getByRole('tab').evaluateAll(tabs => tabs.map(tab => { const r = tab.getBoundingClientRect(); return { top: r.top, height: r.height }; }));
    expect(boxes).toHaveLength(7);
    expect(new Set(boxes.map(box => Math.round(box.top))).size).toBe(1);
    expect(Math.max(...boxes.map(box => box.height))).toBeLessThanOrEqual(45);
    const selected = nav.getByRole('tab', { selected: true });
    const tab = (await selected.boundingBox())!;
    const bounds = (await nav.boundingBox())!;
    expect(tab.x).toBeGreaterThanOrEqual(bounds.x);
    expect(tab.x + tab.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
  }
  await checkRow();
  await expect(nav.getByRole('button', { name: 'Show later editor tabs' })).toBeEnabled();
  await nav.getByRole('button', { name: 'Show later editor tabs' }).click();
  await nav.getByRole('tab', { name: 'Parameters', exact: true }).click();
  await checkRow();
  await nav.getByRole('tab', { name: 'Parameters', exact: true }).press('ArrowLeft');
  await expect(nav.getByRole('tab', { name: 'Appearance', exact: true })).toBeFocused();
  await nav.getByRole('tab', { name: 'Appearance', exact: true }).press('Enter');
  await expect(nav.getByRole('tab', { name: 'Appearance', exact: true })).toHaveAttribute('aria-selected', 'true');
  await checkRow();
  const divider = panel.getByRole('separator', { name: 'Resize report editor' });
  await divider.focus(); await divider.press('Home');
  await checkRow();
  await panel.getByRole('button', { name: 'Full-screen editor', exact: true }).click();
  await expect(nav.getByRole('button', { name: 'Show later editor tabs' })).toHaveCount(0);
  await checkRow();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(nav.getByRole('button', { name: 'Show earlier editor tabs' })).toBeVisible();
  await checkRow();
  await nav.getByRole('tab', { name: 'Chat', exact: true }).click();
  await checkRow();
  await expect(panel.getByRole('textbox', { name: 'Chat message input' })).toBeVisible();
});
