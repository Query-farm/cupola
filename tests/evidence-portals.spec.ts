import { test, expect } from '@playwright/test';
import { evidencePath, EVIDENCE_SERVICE_URL } from './helpers';

test.use({ viewport: { width: 1400, height: 1000 } });

// Evidence's select, popover, tooltip and dialog content portals to document.body by default.
// The report renders in a shadow root, so a body portal has none of the report's styles: a
// dropdown opened as a 40px sliver whose options could not be chosen. EvidenceDocument points
// bits-ui at a node inside the shadow root instead. This also fails if bits-ui ever resolves to
// a second copy, because BitsConfig would then set a context core's portals never read.
const SOURCE = `# Portals

{% dropdown id="category_filter" data="demo.daily_orders" value_column="category" /%}

{% big_value data="demo.daily_orders" value="count(*)" title="Rows" filters=["category_filter"] /%}

{% range_calendar id="date_filter" /%}
`;

test('report popups render inside the report and can be used', async ({ page }) => {
  test.setTimeout(120_000);
  const report = { version: 1, id: 'portals', title: 'Portals', serviceUrl: EVIDENCE_SERVICE_URL, setupSql: '', createdAt: 1, updatedAt: 1, parameters: [], values: {}, source: SOURCE };
  await page.addInitScript(saved => {
    try { localStorage.setItem(`cupola.evidence.report.v2:${encodeURIComponent(saved.serviceUrl)}:${saved.id}`, JSON.stringify(saved)); } catch { /* sandboxed frame */ }
  }, report);
  await page.goto(evidencePath('evidence?evidence_report=portals'));

  const panel = page.getByTestId('evidence-panel');
  const report_ = panel.getByTestId('evidence-document');
  const portals = panel.getByTestId('evidence-portals');
  const trigger = report_.locator('[data-render=dropdown] button[data-slot=select-trigger]');
  await expect(report_.locator('[data-render=big_value]')).toContainText('11k', { timeout: 90_000 });

  // Styled: as wide as its trigger, not a sliver. A real click selects and filters.
  await trigger.click();
  const option = portals.getByRole('option', { name: 'Books' });
  await expect(option).toBeVisible();
  expect((await option.boundingBox())!.width).toBeGreaterThan(200);
  await option.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(report_.locator('[data-render=big_value]')).toContainText('2,191');
  await expect(page).toHaveURL(/category_filter=Books/);

  // The keyboard works, and typing in the popup's search box doesn't dismiss it.
  await trigger.focus();
  await page.keyboard.press('ArrowDown');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await portals.getByRole('textbox').or(portals.locator('input')).first().fill('Spo');
  await expect(portals.getByRole('option')).toHaveCount(1);
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');

  // A click outside closes it, though events from a shadow root retarget to its host.
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await page.mouse.click(700, 960);
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');

  // Popover content takes the same route.
  await report_.locator('[data-render=range_calendar] button').first().click();
  await portals.getByRole('button', { name: 'Last 7 Days' }).click();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/date_filter=last\+7\+days/);
});
