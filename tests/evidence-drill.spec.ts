import { test, expect, type Page } from '@playwright/test';
import { evidencePath, EVIDENCE_SERVICE_URL } from './helpers';
import { geoDrillReport } from './fixtures/evidence-geo-report';

test.use({ viewport: { width: 1400, height: 1100 } });

const crumbs = (page: Page) => page.getByRole('navigation', { name: 'Drill path: All places' }).getByRole('listitem');
const rows = (page: Page) => page.getByTestId('evidence-document').locator('[data-render="table"] tbody tr');

test('clicking charts and table values drills through country, state and city; Back and the breadcrumb step up', async ({ page }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(([report]) => {
    try { localStorage.setItem(`cupola.evidence.report.v2:${encodeURIComponent(report.serviceUrl)}:${report.id}`, JSON.stringify(report)); } catch { return; }
    (window as { __cupolaPdfDebug?: unknown }).__cupolaPdfDebug = true;
  }, [geoDrillReport(EVIDENCE_SERVICE_URL)]);
  await page.goto(evidencePath('evidence?evidence_report=geo-drill'));
  const panel = page.getByTestId('evidence-panel');
  const document = panel.getByTestId('evidence-document');
  await expect(rows(page)).toHaveCount(2, { timeout: 90_000 });
  await expect(crumbs(page)).toHaveText(['All places']);

  // Level 1, by mouse: table values that name a country are drill targets.
  await document.getByRole('button', { name: 'Drill into United States' }).click();
  await expect(crumbs(page)).toHaveText(['All places', 'United States']);
  await expect(rows(page)).toHaveCount(4);
  expect(new URL(page.url()).searchParams.get('p.country')).toBe('US');
  await expect(page.getByTestId('parameter-choices-country')).toHaveAccessibleName('Country: United States');

  // Level 2, by keyboard.
  await document.getByRole('button', { name: 'Drill into Virginia' }).focus();
  await page.keyboard.press('Enter');
  await expect(crumbs(page)).toHaveText(['All places', 'United States', 'Virginia']);
  await expect(rows(page)).toHaveText([/Glen Allen/, /Norfolk/, /Richmond/]);

  // Level 3, by clicking a chart bar: the third of three columns (centred at ~83% of the plot) is Richmond.
  const canvas = document.locator('[data-render="bar_chart"] canvas').first();
  const box = (await canvas.boundingBox())!;
  await expect(async () => {
    await page.mouse.click(box.x + box.width * 0.835, box.y + box.height * 0.75);
    await expect(crumbs(page)).toHaveCount(4, { timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await expect(crumbs(page)).toHaveText(['All places', 'United States', 'Virginia', 'Richmond']);
  await expect(rows(page)).toHaveCount(1);
  // Fully drilled: nothing left to click into.
  await expect(document.getByRole('button', { name: /^Drill into/ })).toHaveCount(0);

  // The PDF names the drill path in its Filters section.
  await panel.getByRole('button', { name: 'Export PDF', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'PDF exported', exact: true })).toBeVisible({ timeout: 60_000 });
  const main = await page.evaluate(() => (window as unknown as { __cupolaPdfDebug: { main: string } }).__cupolaPdfDebug.main);
  expect(main).toContain('("Drill path", "All places › United States › Virginia › Richmond")');
  expect(main).toContain('("State", "Virginia")');

  // Back steps up one level; a crumb jumps up several.
  await page.goBack();
  await expect(crumbs(page)).toHaveText(['All places', 'United States', 'Virginia']);
  await expect(rows(page)).toHaveCount(3);
  await page.getByRole('navigation', { name: 'Drill path: All places' }).getByRole('button', { name: 'All places' }).click();
  await expect(crumbs(page)).toHaveText(['All places']);
  await expect(rows(page)).toHaveCount(2);
  expect(new URL(page.url()).searchParams.has('p.country')).toBe(false);
  expect(errors).toEqual([]);
});
