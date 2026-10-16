import { test, expect } from '@playwright/test';
import { APP_ORIGIN, BASE, SERVICE_URL } from './helpers';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

for (const kind of ['notebook', 'query'] as const) {
  test(`a saved ${kind} reopens its editor after a mobile reload`, async ({ page }) => {
    await page.goto(`${APP_ORIGIN}${BASE}reports?service=${encodeURIComponent(SERVICE_URL)}&report_service=local&view=reports`);
    await page.getByRole('button', { name: 'New', exact: true }).click({ timeout: 30_000 });
    await page.getByRole('menuitem', { name: `New ${kind}`, exact: true }).click();
    const editor = page.getByTestId(kind === 'notebook' ? 'notebook-workspace' : 'mobile-query');
    await expect(editor).toBeVisible();
    await expect(page).toHaveURL(/evidence_report=/);
    const documentId = new URL(page.url()).searchParams.get('evidence_report');
    await page.reload();
    await expect(editor).toBeVisible({ timeout: 30_000 });
    expect(new URL(page.url()).searchParams.get('evidence_report')).toBe(documentId);
    await page.getByTestId(kind === 'notebook' ? 'tab-reports' : 'mobile-tab-library').click();
    await expect(page.getByTestId('tab-reports')).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveURL(/report_service=all/);
    await page.goBack();
    await expect(editor).toBeVisible();
    expect(new URL(page.url()).searchParams.get('evidence_report')).toBe(documentId);
  });
}
