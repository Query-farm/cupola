import { evidencePath } from './helpers';
import { test, expect, type Page } from '@playwright/test';

test.use({ viewport: { width: 1500, height: 1100 } });

/** A new report with its source open in the editor. Collects page errors. */
async function openNewReportSource(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(evidencePath('evidence/reports'));
  const panel = page.getByTestId('evidence-panel');
  await panel.getByRole('button', { name: 'New report', exact: true }).click();
  await panel.getByRole('tab', { name: 'Code', exact: true }).click();
  const source = panel.getByRole('textbox', { name: 'Evidence source', exact: true });
  await expect(source).toBeVisible({ timeout: 90_000 });
  await expect(panel.getByRole('button', { name: 'Update preview', exact: true })).toBeEnabled({ timeout: 90_000 });
  return { panel, source, errors };
}

async function enterFullScreen(page: Page) {
  const panel = page.getByTestId('evidence-panel');
  await panel.getByRole('button', { name: 'Full-screen editor', exact: true }).click();
  await expect(panel.getByRole('region', { name: 'Report preview', exact: true })).not.toBeVisible();
  expect(await panel.getByRole('complementary', { name: 'Report editor', exact: true }).evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThan(1400);
}

test('the report editor resizes, goes full screen and completes Core syntax', async ({ page }) => {
  test.setTimeout(120_000);
  const { panel, source, errors } = await openNewReportSource(page);
  await expect(panel.getByRole('link', { name: 'Evidence docs ↗', exact: true })).toHaveAttribute('href', /core-concepts\/markdown/);
  await expect(panel.getByRole('link', { name: 'Component reference ↗', exact: true })).toHaveAttribute('target', '_blank');

  const divider = panel.getByRole('separator', { name: 'Resize report editor' });
  const editor = panel.getByRole('complementary', { name: 'Report editor', exact: true });
  const beforeResize = await editor.evaluate(el => el.getBoundingClientRect().width);
  const handle = (await divider.boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x - 150, handle.y + handle.height / 2, { steps: 8 });
  await page.mouse.up();
  expect(await editor.evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThan(beforeResize + 100);
  await divider.focus();
  const draggedWidth = Number(await divider.getAttribute('aria-valuenow'));
  await divider.press('ArrowLeft');
  expect(Number(await divider.getAttribute('aria-valuenow'))).toBe(draggedWidth + 2);
  await panel.getByRole('button', { name: 'View report', exact: true }).click();
  await expect(divider).toHaveCount(0);
  await panel.getByRole('button', { name: 'Edit report', exact: true }).click();
  expect(Number(await divider.getAttribute('aria-valuenow'))).toBe(draggedWidth + 2);
  await divider.dblclick();
  await expect(divider).toHaveAttribute('aria-valuenow', '36');
  await enterFullScreen(page);

  await source.fill('{% line_ch');
  await source.press('Control+Space');
  // The first completion loads Evidence's tag registry (its Markdoc processor
  // and core: evidenceRegistry in editor-support.ts), a cold import of a large
  // module graph on the dev server that outlasted the 5s default under a full
  // parallel run. Later completions reuse it and keep the default timeout.
  await expect(page.getByRole('option', { name: 'line_chart', exact: true })).toBeVisible({ timeout: 30_000 });
  // Clicking avoids CodeMirror's short keyboard interaction guard immediately after opening.
  await page.getByRole('option', { name: 'line_chart', exact: true }).click();
  await expect(source).toContainText('{% line_chart');
  await source.fill('{% line_chart dat');
  await source.press('Control+Space');
  await expect(page.getByRole('option', { name: /data/ }).first()).toBeVisible();
  await source.press('Escape');
  await expect(panel.getByRole('button', { name: 'Exit full-screen editor', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('the report editor reports recoverable source and SQL errors', async ({ page }) => {
  test.setTimeout(180_000);
  const { panel, source, errors } = await openNewReportSource(page);
  await page.evaluate(() => { (window as any).__authoringWorker = (window as any).__bridge.worker; });
  await enterFullScreen(page);

  const valid = '# Authoring test\n\n```sql example\nSELECT 12 AS value\n```\n\n{% big_value data="example" value="sum(value)" /%}';
  await source.fill(valid + '\n\n{% not_a_component /%}');
  await source.press('Control+Enter');
  const problems = panel.getByRole('region', { name: 'Report problems', exact: true });
  await expect(problems).toContainText('not_a_component', { timeout: 30_000 });
  const issue = problems.getByRole('button').filter({ hasText: 'not_a_component' }).first();
  await expect(issue).toContainText('line 9');
  await issue.click();
  await expect(source).toBeFocused();
  await expect(panel.locator('.cm-lintRange-error').first()).toBeVisible();
  await source.fill(valid);
  await expect(problems).toContainText('previous preview');
  await source.press('Control+Enter');
  await expect(problems).toContainText('Problems · 0', { timeout: 30_000 });
  await panel.getByRole('button', { name: 'Show preview', exact: true }).click();
  // The big value's query runs after the document mounts, so it waits as long as
  // the refreshes do: under a full parallel run it outlasted the 5s default.
  await expect(panel.getByTestId('evidence-document')).toContainText('12', { timeout: 30_000 });

  await source.fill('# Broken query\n\n```sql missing\nSELECT * FROM cupola_table_that_does_not_exist\n```\n\n{% table data="missing" /%}');
  await source.press('Control+Enter');
  await expect(problems).toContainText('cupola_table_that_does_not_exist', { timeout: 30_000 });
  await expect(problems.getByText('Failed SQL').first()).toBeVisible();
  await source.fill(valid);
  await source.press('Control+Enter');
  await expect(panel.getByTestId('evidence-document')).toContainText('12', { timeout: 30_000 });
  await expect(problems).toContainText('Problems · 0');

  await panel.getByRole('tab', { name: 'Setup SQL', exact: true }).click();
  const data = panel.getByRole('textbox', { name: 'Dataset SQL', exact: true });
  await data.fill('SELECT * FROM missing_setup_table');
  await data.press('Control+Enter');
  await expect(problems).toContainText('Data · line 1 · error:', { timeout: 30_000 });
  await data.fill('');
  await data.press('Control+Enter');
  await expect(panel.getByTestId('evidence-document')).toContainText('12', { timeout: 30_000 });
  await expect(problems).toContainText('Problems · 0');
  // Errors are recovered from in place: the engine is never restarted.
  expect(await page.evaluate(() => (window as any).__authoringWorker === (window as any).__bridge.worker)).toBe(true);
  expect(errors).toEqual([]);
});

for (const width of [1500, 800]) {
  test(`a long setup failure keeps the report editable at ${width}px`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width, height: 900 });
    const { panel, source, errors } = await openNewReportSource(page);
    await source.fill('# Recovered report\n\n```sql answer\nSELECT 42 AS value\n```\n\n{% table data="answer" /%}');
    await panel.getByRole('tab', { name: 'Setup SQL', exact: true }).click();
    const setup = panel.getByRole('textbox', { name: 'Dataset SQL', exact: true });
    const failedSql = "CREATE TEMP TABLE broken_balances AS\nSELECT error('VGI Worker Exception: ValidationError: 21 validation errors for AccountBalanceSnapshot' || chr(10) || repeat('cash-balance: Field required' || chr(10), 100))";
    await setup.fill(`SELECT 1;\nSELECT 2;\nSELECT 3;\n\n${failedSql};\nSELECT 5;`);
    await panel.getByRole('button', { name: 'View report', exact: true }).click();
    await panel.getByRole('button', { name: 'Refresh report', exact: true }).click();
    const failures = panel.getByRole('region', { name: 'Report query errors', exact: true });
    await expect(failures).toContainText('Setup SQL failed · statement 4 of 5 · broken_balances · lines 5–6', { timeout: 30_000 });
    await expect(failures.locator('pre').first()).toHaveText(failedSql);
    await expect(failures.locator('details')).not.toHaveAttribute('open');
    await failures.getByText('Full error details', { exact: true }).click();
    await expect(failures.locator('details pre')).toContainText('cash-balance: Field required');
    // Even expanded details scroll inside the viewer and cannot consume the editor's height.
    const edit = panel.getByRole('button', { name: 'Edit report', exact: true });
    await expect(edit).toBeInViewport();
    await edit.click();
    const editor = panel.getByRole('complementary', { name: 'Report editor', exact: true });
    await expect(editor).toBeVisible();
    expect((await editor.boundingBox())!.height).toBeGreaterThan(300);
    const problems = editor.getByRole('region', { name: 'Report problems', exact: true });
    await problems.getByRole('button').filter({ hasText: 'Data · line 5 · error:' }).click();
    await expect(setup).toBeFocused();
    await setup.fill('SELECT 1');
    await panel.getByRole('button', { name: 'Update preview', exact: true }).click();
    // Update preview selects Preview on narrow screens; returning through View → Edit
    // must select the editor again, not leave it hidden behind Preview.
    await panel.getByRole('button', { name: 'View report', exact: true }).click();
    await expect(panel.getByTestId('evidence-document')).toContainText('42', { timeout: 30_000 });
    await expect(failures).toHaveCount(0);
    await panel.getByRole('button', { name: 'Edit report', exact: true }).click();
    await expect(editor).toBeVisible();
    await expect(problems).toContainText('Problems · 0');
    expect(errors).toEqual([]);
  });
}
