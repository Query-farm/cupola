import { test, expect } from '@playwright/test';
import { gotoApp, waitForShellBridge, evidencePath, EVIDENCE_SERVICE_URL } from './helpers';

test.use({ viewport: { width: 1500, height: 1100 } });
test('Reports starts at the list and preserves an opened report across tab switches and saved links', async ({ page }) => {
  await gotoApp(page);
  await waitForShellBridge(page);
  await page.getByTestId('tab-reports').click();
  const panel = page.getByTestId('evidence-panel');
  const list = panel.getByRole('heading', { name: /^(All reports|On this device)$/ });
  await expect(list).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Back to report', exact: true })).toHaveCount(0);
  await expect(panel.getByTestId('evidence-document')).toHaveCount(0);
  await expect(page).toHaveURL(/reports(?:\/saved)?/);

  await page.getByTestId('tab-catalog').click();
  await page.getByTestId('tab-reports').click();
  await expect(list).toBeVisible();
  await panel.getByRole('button', { name: 'New report', exact: true }).click();
  const title = panel.getByRole('textbox', { name: 'Report title', exact: true });
  await title.fill('Session report');
  await page.getByTestId('tab-catalog').click();
  await page.getByTestId('tab-reports').click();
  await expect(title).toHaveValue('Session report');
  await expect(panel.getByRole('status', { name: 'Save status' })).toHaveText('Saved in this browser');
  await expect(page).toHaveURL(/evidence_report=/);
  await panel.getByRole('button', { name: 'Saved reports', exact: true }).click();
  await expect(list).toBeVisible();
  await panel.getByRole('button', { name: 'Session report', exact: true }).click();
  await panel.getByRole('button', { name: 'Edit report', exact: true }).click();
  await expect(title).toHaveValue('Session report');

  await page.reload();
  await expect(panel.getByRole('button', { name: 'Edit report', exact: true })).toBeVisible();
  await expect(panel.getByText('Session report', { exact: true }).first()).toBeVisible();
  await expect(list).toHaveCount(0);
});

test('editor navigation stays on one row and reveals the selected tab at variable widths', async ({ page }) => {
  test.setTimeout(120000);
  await page.goto(evidencePath('evidence/reports'));
  const panel = page.getByTestId('evidence-panel');
  await panel.getByRole('button', { name: 'New report', exact: true }).click();
  const nav = panel.getByTestId('evidence-editor-navigation');
  await expect(nav).toBeVisible({ timeout: 90000 });
  async function checkRow() {
    const boxes = await nav.getByRole('tab').evaluateAll(tabs => tabs.map(tab => { const r = tab.getBoundingClientRect(); return { top: r.top, height: r.height }; }));
    expect(boxes).toHaveLength(9);
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

// The sidebar's report links open reports inside the app: no page load, so the engine, the
// catalog and every other tab keep their state. Back still steps between them.
test('sidebar report links open reports without reloading the page', async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript((serviceUrl) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    for (const [id, title] of [['first', 'First report'], ['second', 'Second report']]) {
      const report = { version: 1, id, title, serviceUrl, source: `# ${title}`, setupSql: '', parameters: [], values: {}, createdAt: 1, updatedAt: id === 'first' ? 2 : 1 };
      localStorage.setItem(`cupola.evidence.report.v2:${encodeURIComponent(serviceUrl)}:${id}`, JSON.stringify(report));
    }
  }, EVIDENCE_SERVICE_URL);
  // The catalog page, before the Reports tab has ever been opened.
  await page.goto(evidencePath(''));
  const sidebar = page.getByRole('navigation', { name: 'Saved reports' });
  await expect(sidebar.getByRole('link', { name: 'First report' })).toBeVisible({ timeout: 90_000 });
  await page.evaluate(() => { (window as { __sameDocument?: boolean }).__sameDocument = true; });
  const sameDocument = () => page.evaluate(() => (window as { __sameDocument?: boolean }).__sameDocument === true);
  const panel = page.getByTestId('evidence-panel');
  const document = panel.getByTestId('evidence-document');

  await sidebar.getByRole('link', { name: 'First report' }).click();
  await expect(document.getByRole('heading', { name: 'First report' })).toBeVisible({ timeout: 90_000 });
  await expect(page).toHaveURL(/evidence_report=first/);
  expect(await sameDocument()).toBe(true);

  // From one report to another, and from another tab.
  await sidebar.getByRole('link', { name: 'Second report' }).click();
  await expect(document.getByRole('heading', { name: 'Second report' })).toBeVisible({ timeout: 60_000 });
  await expect(page).toHaveURL(/evidence_report=second/);
  await page.getByTestId('tab-catalog').click();
  await sidebar.getByRole('link', { name: 'First report' }).click();
  await expect(document.getByRole('heading', { name: 'First report' })).toBeVisible({ timeout: 60_000 });
  await expect(page).toHaveURL(/evidence_report=first/);

  // The list, and Back to the report it left.
  await sidebar.getByRole('link', { name: 'Reports' }).click();
  await expect(page).toHaveURL(/reports(?:\/saved)?/);
  await expect(panel.getByRole('row').filter({ hasText: 'Second report' })).toBeVisible();
  await page.goBack();
  await expect(document.getByRole('heading', { name: 'First report' })).toBeVisible({ timeout: 60_000 });
  expect(await sameDocument()).toBe(true);

  // A modified click is still the browser's: a new tab, not an in-app switch.
  const [popup] = await Promise.all([page.context().waitForEvent('page'), sidebar.getByRole('link', { name: 'Second report' }).click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] })]);
  await expect(popup).toHaveURL(/evidence_report=second/);
  await expect(page).toHaveURL(/evidence_report=first/);
  await popup.close();

  // Headings open the libraries even when their lists are collapsed or already mounted.
  await sidebar.getByRole('button', { name: 'Collapse reports', exact: true }).click();
  await expect(sidebar.getByRole('link', { name: 'First report', exact: true })).toBeHidden();
  await sidebar.getByRole('link', { name: 'Reports', exact: true }).click();
  await expect(panel.getByRole('region', { name: 'Report browser' })).toBeVisible();
  await expect(sidebar.getByRole('button', { name: 'Expand reports', exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: 'Saved notebooks' }).getByRole('link', { name: 'Notebooks', exact: true }).click();
  await expect(page.getByTestId('notebook-library')).toBeVisible();
  await sidebar.getByRole('link', { name: 'Reports', exact: true }).click();
  await expect(page).toHaveURL(/reports(?:\/saved)?/);
  await page.reload();
  await expect(panel.getByRole('region', { name: 'Report browser' })).toBeVisible();
});
