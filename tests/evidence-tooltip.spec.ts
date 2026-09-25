import { test, expect } from '@playwright/test';

test.use({ channel: 'chrome' });
test('report chart tooltips dismiss on scroll, hidden tabs, Escape and cleanup', async ({ page }) => {
  // A lightweight host avoids needing a live worker to test real ECharts portals.
  await page.route('**/tooltip-fixture', route => route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }));
  await page.goto('tooltip-fixture');
  const base = new URL('.', page.url()).pathname;
  await page.evaluate(async base => {
    const { mountTooltipFixture } = await import(`${base}tests/fixtures/evidence-tooltip-browser.ts`);
    (window as any).fixture = mountTooltipFixture();
  }, base);
  const tooltip = page.locator('.report-tooltip-test');
  const show = async () => {
    await page.evaluate(() => (window as any).fixture.show());
    await expect(tooltip).toBeVisible();
  };
  await show();
  await page.evaluate(() => { (window as any).fixture.panel.scrollTop = 50; });
  await expect(tooltip).toBeHidden();
  await show();
  await page.evaluate(() => { (window as any).fixture.panel.style.visibility = 'hidden'; });
  await expect(tooltip).toBeHidden();
  await page.evaluate(() => { (window as any).fixture.panel.style.visibility = ''; });
  await show();
  await page.keyboard.press('Escape');
  await expect(tooltip).toBeHidden();
  await show();
  await page.evaluate(() => (window as any).fixture.cleanup());
  await expect(tooltip).toBeHidden();
  await page.evaluate(() => (window as any).fixture.chart.dispose());
  await expect(tooltip).toHaveCount(0);
});
