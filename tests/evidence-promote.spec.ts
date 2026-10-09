/** Add to report: the editor's query becomes a new report, which saves at once. Reports have no
 *  Save button (they save after each edit), and an untouched new report used to count as unchanged,
 *  so the promoted query sat on "Not saved yet" and was lost on leaving. */
import { test, expect } from '@playwright/test';
import { gotoApp, openEditor, typeInEditor, waitForShellBridge } from './helpers';

test('a query added to a report is saved without editing it', async ({ page }) => {
  await gotoApp(page);
  await waitForShellBridge(page);
  await openEditor(page);
  await typeInEditor(page, "SELECT 42 AS answer");
  await page.getByTestId('editor-share-menu').click();
  await page.getByTestId('editor-add-to-report').click();

  await expect(page.getByTestId('tab-reports')).toHaveAttribute('aria-selected', 'true');
  const panel = page.getByTestId('evidence-panel');
  await expect(panel.getByRole('status', { name: 'Save status' })).toHaveText('Saved in this browser', { timeout: 30_000 });
  await expect(page).toHaveURL(/evidence_report=/);
  const sidebar = page.getByRole('navigation', { name: 'Saved reports' });
  await expect(sidebar.getByRole('link', { name: 'Query 1' })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Saved reports' }).getByRole('link', { name: 'Query 1' })).toBeVisible({ timeout: 30_000 });
});

test('a blank new report is saved locally before its first edit', async ({ page }) => {
  await gotoApp(page);
  await waitForShellBridge(page);
  await page.getByTestId('tab-reports').click();
  const panel = page.getByTestId('evidence-panel');
  await panel.getByRole('button', { name: 'New report' }).click();
  await expect(panel.getByRole('status', { name: 'Save status' })).toHaveText('Saved in this browser');
});
