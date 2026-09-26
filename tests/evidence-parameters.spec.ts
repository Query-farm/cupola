import { test, expect, type Page } from '@playwright/test';
import { evidencePath, EVIDENCE_SERVICE_URL } from './helpers';
import { geoReport } from './fixtures/evidence-geo-report';

test.use({ viewport: { width: 1400, height: 1000 } });

async function openGeoReport(page: Page, extra: Record<string, unknown> = {}) {
  await page.addInitScript(([report]) => {
    try { localStorage.setItem(`cupola.evidence.report.v2:${encodeURIComponent(report.serviceUrl)}:${report.id}`, JSON.stringify(report)); } catch { /* sandboxed frame */ }
  }, [{ ...geoReport(EVIDENCE_SERVICE_URL), ...extra }]);
  await page.goto(evidencePath('evidence?evidence_report=geo-parameters'));
  const panel = page.getByTestId('evidence-panel');
  await expect(panel.getByTestId('evidence-document').getByRole('heading', { name: 'Sales by place' })).toBeVisible({ timeout: 90_000 });
  return panel;
}
async function pick(page: Page, key: string, choice: string) {
  await page.getByTestId(`parameter-choices-${key}`).click();
  await page.getByRole('listbox').getByRole('option', { name: choice, exact: true }).click();
  await expect(page.getByRole('listbox')).toHaveCount(0);
}
async function choices(page: Page, key: string) {
  await page.getByTestId(`parameter-choices-${key}`).click();
  const listbox = page.getByRole('listbox');
  await expect(listbox).toBeVisible();
  const names = await listbox.getByRole('option').allTextContents();
  await page.keyboard.press('Escape');
  await expect(listbox).toHaveCount(0);
  return names;
}
const table = (page: Page, index: number) => page.getByTestId('evidence-document').locator('[data-render="table"]').nth(index).locator('tbody tr');
const rows = (page: Page) => table(page, 0);
const places = (page: Page) => table(page, 1);

test('query-backed parameters cascade, reset children that stop applying, and bind on refresh', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const panel = await openGeoReport(page);
  await expect(rows(page)).toHaveCount(14);

  // Each list narrows to its parent's choices.
  expect(await choices(page, 'country')).toEqual(['All', 'Canada', 'United States']);
  await pick(page, 'country', 'Canada');
  await expect(page.getByTestId('parameter-choices-state')).toBeEnabled();
  await expect.poll(() => choices(page, 'state')).toEqual(['All', 'British Columbia', 'Ontario']);
  await pick(page, 'state', 'Ontario');
  await expect.poll(() => choices(page, 'city')).toEqual(['All', 'Ottawa', 'Toronto']);
  await pick(page, 'city', 'Toronto');
  await expect(page.getByTestId('parameter-choices-city')).toHaveAccessibleName('City: Toronto');

  // A parent change resets the children it no longer offers, and says so.
  await pick(page, 'country', 'United States');
  const notes = panel.getByRole('status', { name: 'Parameter changes' });
  await expect(notes).toContainText('State reset to All: Ontario is no longer a choice.');
  await expect(notes).toContainText('City reset to All: Toronto is no longer a choice.');
  await expect(page.getByTestId('parameter-choices-state')).toHaveAccessibleName('State: All');

  // Nothing changes in the report until it is refreshed.
  await expect(rows(page)).toHaveCount(14);
  await panel.getByRole('button', { name: 'Refresh report' }).click();
  await expect(rows(page)).toHaveCount(10);
  await pick(page, 'state', 'Virginia');
  await panel.getByRole('button', { name: 'Refresh report' }).click();
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).first()).toContainText('Glen Allen');
  expect(errors).toEqual([]);
});

test('search narrows long choice lists and multi-select binds a list', async ({ page }) => {
  test.setTimeout(120_000);
  const panel = await openGeoReport(page, {
    id: 'geo-parameters',
    parameters: geoReport(EVIDENCE_SERVICE_URL).parameters.map(parameter => parameter.key === 'city'
      ? { ...parameter, type: 'multi_select', defaultValue: [] } : parameter),
    source: geoReport(EVIDENCE_SERVICE_URL).source.replace('($city_all OR city = $city)', '($city_all OR city IN ($city))'),
  });
  await page.getByTestId('parameter-choices-city').click();
  await page.getByRole('combobox', { name: 'Search City' }).fill('an');
  await expect(page.getByRole('listbox').getByRole('option')).toHaveText(['Portland', 'San Francisco', 'Vancouver']);
  await page.keyboard.press('Enter');
  await page.getByRole('combobox', { name: 'Search City' }).fill('rich');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('parameter-choices-city')).toHaveAccessibleName('City: Portland, Richmond');
  await panel.getByRole('button', { name: 'Refresh report' }).click();
  await expect(rows(page)).toHaveCount(2);
});

test('applied values live in the URL: a reload or shared link reproduces the view, Back restores the previous one', async ({ page }) => {
  test.setTimeout(150_000);
  const panel = await openGeoReport(page);
  await pick(page, 'country', 'United States');
  await panel.getByRole('button', { name: 'Refresh report' }).click();
  await expect(rows(page)).toHaveCount(10);
  await pick(page, 'state', 'Virginia');
  await panel.getByRole('button', { name: 'Refresh report' }).click();
  await expect(rows(page)).toHaveCount(3);
  const url = new URL(page.url());
  expect(url.searchParams.get('p.country')).toBe('US');
  expect(url.searchParams.get('p.state')).toBe('VA');
  expect(url.searchParams.has('p.city')).toBe(false);

  // Evidence's filters=["state"] follows the parameter through its filterColumn.
  await expect(places(page)).toHaveCount(3);

  await page.goBack();
  await expect(rows(page)).toHaveCount(10);
  await expect(page.getByTestId('parameter-choices-state')).toHaveAccessibleName('State: All');
  await expect(places(page)).toHaveCount(14);
  await page.goForward();
  await expect(rows(page)).toHaveCount(3);

  // A fresh visit to the URL (a shared link) opens the same view.
  await page.reload();
  await expect(rows(page)).toHaveCount(3, { timeout: 90_000 });
  await expect(page.getByTestId('parameter-choices-country')).toHaveAccessibleName('Country: United States');
  await expect(page.getByTestId('parameter-choices-state')).toHaveAccessibleName('State: Virginia');
});

test('the drilldown example runs cleanly, and the parameter editor shows dependencies and previews choices', async ({ page }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(evidencePath('evidence/reports'));
  const panel = page.getByTestId('evidence-panel');
  await panel.getByRole('button', { name: 'Use drilldown example' }).click({ timeout: 90_000 });
  const document = panel.getByTestId('evidence-document');
  await expect(document.getByRole('heading', { name: 'Sales by place' })).toBeVisible({ timeout: 90_000 });
  await expect(document.locator('[data-render="table"] tbody tr')).toHaveCount(2, { timeout: 60_000 });
  await expect(document.getByRole('button', { name: 'Drill into United States' })).toBeVisible();
  await expect(panel.getByTestId('report-problem-count')).toHaveCount(0);

  // The example opens for editing; its Parameters tab explains the cascade and previews choices.
  await panel.getByRole('tab', { name: 'Parameters', exact: true }).click();
  await expect(panel.getByLabel('Parameter 2 dependencies')).toHaveText('Choices depend on Country. Changing it updates the choices of City.');
  await panel.getByRole('button', { name: 'Preview choices' }).nth(1).click();
  await expect(panel.getByRole('status', { name: 'Parameter 2 choices preview' })).toHaveText('6 choices: British Columbia, California, Ontario, Oregon, Texas, Virginia');
  await expect(panel.getByRole('region', { name: 'Drill paths' }).getByLabel('Drill path 1 level 2')).toHaveValue('state');
  expect(errors).toEqual([]);
});

test('a PDF per value has one section per choice, links back to the view, and leaves the report as it was', async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => { (window as { __cupolaPdfDebug?: unknown }).__cupolaPdfDebug = true; });
  const panel = await openGeoReport(page);
  await pick(page, 'country', 'Canada');
  await panel.getByRole('button', { name: 'Refresh report' }).click();
  await expect(rows(page)).toHaveCount(4);

  await panel.getByRole('button', { name: 'More report actions' }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 150_000 }),
    page.getByRole('menuitem', { name: 'PDF per state' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('sales-by-place-by-state.pdf');
  const main = await page.evaluate(() => (window as unknown as { __cupolaPdfDebug: { main: string } }).__cupolaPdfDebug.main);
  // Canada offers two states: one section each, headed by the value.
  expect(main).toContain('("Sections", "One per State (2)")');
  expect(main.match(/heading\(level: 1, text\("State: /g)).toHaveLength(2);
  expect(main).toContain('text("State: British Columbia")');
  expect(main).toContain('text("State: Ontario")');
  expect(main).toContain('("Country", "Canada")');
  expect(main).toMatch(/view: \("Open this view in Cupola", "http[^"]*evidence_report=geo-parameters[^"]*p\.country=CA/);

  // The view the reader had is back.
  await expect(panel.getByRole('button', { name: 'PDF exported', exact: true })).toBeVisible();
  await expect(rows(page)).toHaveCount(4);
  await expect(page.getByTestId('parameter-choices-state')).toHaveAccessibleName('State: All');
});
