import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { gotoApp, T_NORMAL } from "./helpers";

async function expectNoSeriousViolations(page: Page, include?: string): Promise<void> {
  let scan = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
  if (include) scan = scan.include(include);
  const results = await scan.analyze();
  const violations = results.violations.filter((violation) =>
    violation.impact === "serious" || violation.impact === "critical"
  );
  expect(violations, violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`).join("\n")).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await gotoApp(page);
});

test("catalog workspace has no serious WCAG A/AA violations", async ({ page }) => {
  await expectNoSeriousViolations(page);
});

test("settings dialog has no serious WCAG A/AA violations", async ({ page }) => {
  await page.locator('[data-slot="dialog-trigger"]', { hasText: "Settings" }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible({ timeout: T_NORMAL });
  await expectNoSeriousViolations(page, '[data-slot="dialog-content"]');
});

test("SQL editor has no serious WCAG A/AA violations", async ({ page }) => {
  await page.getByTestId("tab-editor").click();
  await expect(page.getByTestId("sql-editor-view")).toBeVisible({ timeout: T_NORMAL });
  await expectNoSeriousViolations(page, '[data-testid="sql-editor-view"]');
});
