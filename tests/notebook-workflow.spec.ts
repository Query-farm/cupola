import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { APP_ORIGIN, BASE, SERVICE_URL, waitForShellBridge } from './helpers';

async function openNotebook(page: Page) {
  await page.goto(`${APP_ORIGIN}${BASE}notebooks?service=${encodeURIComponent(SERVICE_URL)}`);
  await expect(page.getByTestId('notebook-library')).toBeVisible({ timeout: 30_000 });
  await waitForShellBridge(page, 30_000);
  await page
    .getByTestId('notebook-library')
    .getByRole('button', { name: 'New notebook', exact: true })
    .click();
  await expect(page.getByTestId('notebook-workspace')).toBeVisible();
}

test('catalog actions insert into the selected notebook cell and are consumed only once', async ({
  page,
}) => {
  await openNotebook(page);
  await page.getByRole('textbox', { name: 'Notebook title', exact: true }).fill('Catalog insertion');
  await page.getByRole('button', { name: 'Insert cell at position 2', exact: true }).click();
  await page.getByRole('menuitem', { name: 'SQL cell', exact: true }).click();
  const cells = page.getByTestId('notebook-cell');
  const first = cells.nth(0).locator('.cm-content'),
    second = cells.nth(1).locator('.cm-content');
  await expect(second).toBeFocused();
  await page.getByLabel('Filter catalog').fill('regions');
  await page.getByRole('button', { name: 'Paste small.regions into notebook cell', exact: true }).click();
  await expect(second).toContainText('SELECT * FROM "cupola_test"."small"."regions" LIMIT 100');
  await expect(first).toHaveText('');
  await expect(second).toBeFocused();
  await second.fill('SELECT ');
  await page.getByLabel('Filter catalog').fill('manager');
  const column = page.getByRole('button', { name: 'Paste manager into notebook cell', exact: true }).first();
  await column.click();
  await expect(second).toHaveText('SELECT "manager"');
  await second.fill('');
  await page.getByLabel('Filter catalog').fill('slow_rows');
  await page
    .getByRole('treeitem', { name: /^slow_rows/ })
    .first()
    .getByTestId('tree-insert')
    .click();
  await expect(second).toHaveText('SELECT * FROM cupola_test.edge.slow_rows(rows, delay_ms)');
  await page.keyboard.type('5');
  await page.keyboard.press('Tab');
  await page.keyboard.type('0');
  await expect(second).toHaveText('SELECT * FROM cupola_test.edge.slow_rows(5, 0)');
  await page.getByRole('button', { name: 'Notebooks', exact: true }).click();
  await page
    .getByTestId('notebook-library')
    .getByRole('button', { name: /^Catalog insertion/ })
    .click();
  await expect(second).toHaveText('SELECT * FROM cupola_test.edge.slow_rows(5, 0)');
  await expect(first).toHaveText('');
});

test('widgets bind SQL, preserve run provenance and pinned results, and survive reopening', async ({
  page,
}) => {
  await openNotebook(page);
  await page.getByRole('textbox', { name: 'Notebook title', exact: true }).fill('Parameterized notebook');
  await page.getByRole('button', { name: 'Add parameters', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Notebook parameters', exact: true });
  const definitions = [
    { key: 'region', label: 'Region', type: 'text', value: "O'Reilly" },
    { key: 'count', label: 'Count', type: 'number', value: '4' },
    { key: 'day', label: 'Day', type: 'date', value: '2026-10-05' },
    { key: 'category', label: 'Category', type: 'select', value: 'west' },
    { key: 'enabled', label: 'Enabled', type: 'boolean', value: 'true' },
  ];
  for (const [index, definition] of definitions.entries()) {
    const n = index + 1;
    await dialog.getByRole('button', { name: 'Add parameter', exact: true }).click();
    await dialog.getByLabel(`Parameter ${n} name`, { exact: true }).fill(definition.key);
    await dialog.getByLabel(`Parameter ${n} label`, { exact: true }).fill(definition.label);
    await dialog.getByLabel(`Parameter ${n} widget`, { exact: true }).selectOption(definition.type);
    if (definition.type === 'select') {
      await dialog.getByLabel(`Parameter ${n} choices`, { exact: true }).fill('west\neast');
      await dialog.getByLabel(`Parameter ${n} default`, { exact: true }).selectOption('west');
    } else if (definition.type === 'boolean')
      await dialog.getByLabel(`Parameter ${n} default`, { exact: true }).check();
    else await dialog.getByLabel(`Parameter ${n} default`, { exact: true }).fill(definition.value);
  }
  await dialog.getByRole('button', { name: 'Save parameters', exact: true }).click();
  await expect(dialog).toBeHidden();
  const parameters = page.getByRole('region', { name: 'Notebook parameters', exact: true });
  const cell = page.getByTestId('notebook-cell').first();
  const source =
    'SELECT $region AS region, $count::INTEGER AS count, $day::DATE AS day, $category AS category, $enabled AS enabled';
  await cell.locator('.cm-content').fill(source);
  await cell.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(cell.getByText(/1 returned rows/)).toBeVisible({ timeout: 20_000 });
  await expect(cell.getByText("O'Reilly", { exact: true })).toBeVisible();
  await cell.getByRole('button', { name: 'Pin result', exact: true }).click();
  await parameters.getByLabel('Count', { exact: true }).fill('8');
  await expect(cell.getByText('Stale output — run to update')).toBeVisible();
  await page.getByRole('button', { name: 'Run changed', exact: true }).click();
  await expect(cell.getByText('Stale output — run to update')).toBeHidden();
  await expect(cell.getByText(/Result from run #2/)).toBeVisible();
  await cell.getByRole('tab', { name: 'Pinned #1', exact: true }).click();
  await expect(
    cell
      .getByRole('tabpanel', { name: 'Pinned #1', exact: true })
      .getByRole('cell', { name: '4', exact: true }),
  ).toBeVisible();
  await cell.getByRole('button', { name: 'Run details', exact: true }).click();
  const details = page.getByRole('dialog', { name: 'Cell run details', exact: true });
  const provenance = details.getByRole('region', { name: 'Displayed result provenance', exact: true });
  await expect(provenance).toContainText('"count": 8');
  await expect(provenance).toContainText(SERVICE_URL);
  const downloaded = page.waitForEvent('download');
  await provenance.getByRole('button', { name: 'Export run details', exact: true }).click();
  const download = await downloaded;
  const record = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(record.values.count).toBe(8);
  expect(record.params).toEqual(["O'Reilly", 8, '2026-10-05', 'west', true]);
  expect(record.source).toBe(source);
  await details.press('Escape');
  await cell.getByRole('tab', { name: 'Table', exact: true }).click();
  await cell.getByRole('button', { name: 'Run options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Explain query', exact: true }).click();
  const plan = page.getByRole('dialog', { name: 'Query plan', exact: true });
  await expect(plan).toContainText('physical_plan', { timeout: 20_000 });
  await plan.press('Escape');
  await expect(cell.getByText(/Result from run #2/)).toBeVisible();
  await cell.locator('.cm-content').fill('select * from nonexistent_workflow_table');
  await cell.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(cell.getByRole('alert')).toContainText('Previous result retained');
  await cell.getByRole('button', { name: 'Run details', exact: true }).click();
  await expect(details.getByRole('region', { name: 'Latest attempt', exact: true })).toContainText(
    'nonexistent_workflow_table',
  );
  await expect(provenance).toContainText(source);
  await details.press('Escape');
  await page.getByRole('button', { name: 'Notebooks', exact: true }).click();
  await page
    .getByTestId('notebook-library')
    .getByRole('button', { name: /^Parameterized notebook/ })
    .click();
  await expect(parameters.getByLabel('Count', { exact: true })).toHaveValue('8');
  await expect(parameters.getByLabel('Region', { exact: true })).toHaveValue("O'Reilly");
  await expect(parameters.getByLabel('Enabled', { exact: true })).toBeChecked();
  await expect(cell.getByRole('tab', { name: 'Pinned #1', exact: true })).toHaveCount(0);
});

test('long queries show execution status and cancellation in run details', async ({ page }) => {
  await openNotebook(page);
  const cell = page.getByTestId('notebook-cell').first();
  await cell.locator('.cm-content').fill('SELECT count(*) FROM cupola_test.edge.slow_rows(100000, 2000)');
  await cell.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(cell.getByText(/Executing query ·/)).toBeVisible({ timeout: 20_000 });
  await cell.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(cell.getByText('Cancelled', { exact: true })).toBeVisible({ timeout: 15_000 });
  await cell.getByRole('button', { name: 'Run details', exact: true }).click();
  const details = page.getByRole('dialog', { name: 'Cell run details', exact: true });
  await expect(details).toContainText('Cancelled');
  await expect(details).toContainText('slow_rows(100000, 2000)');
  await expect(details).toContainText('Finished');
});
