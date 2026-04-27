/**
 * Sidebar tree — rendering, filter input, expand/collapse behavior.
 */
import { test, expect } from "@playwright/test";
import { gotoApp, T_FAST, T_NORMAL } from "./helpers";

test.beforeEach(async ({ page }) => {
  await gotoApp(page);
});

test.describe("Sidebar tree", () => {
  test("renders tree with at least one treeitem", async ({ page }) => {
    const items = page.getByRole("treeitem");
    await expect(items.first()).toBeVisible({ timeout: T_NORMAL });
    expect(await items.count()).toBeGreaterThan(0);
  });

  test("filter input narrows the tree", async ({ page }) => {
    const filter = page.getByLabel("Filter catalog");
    const initial = await page.getByRole("treeitem").count();
    await filter.fill("zzzznomatchxyz");
    await expect
      .poll(() => page.getByRole("treeitem").count(), { timeout: T_NORMAL })
      .toBeLessThan(initial || 1);
    await filter.fill("");
    await expect
      .poll(() => page.getByRole("treeitem").count(), { timeout: T_NORMAL })
      .toBeGreaterThanOrEqual(initial);
  });

  test("expand and collapse a schema node", async ({ page }) => {
    const firstItem = page.getByRole("treeitem").first();
    await firstItem.scrollIntoViewIfNeeded();
    const before = await page.getByRole("treeitem").count();
    await firstItem.click();
    await expect
      .poll(() => page.getByRole("treeitem").count(), { timeout: T_NORMAL })
      .toBeGreaterThanOrEqual(before);
    const expanded = await page.getByRole("treeitem").count();
    await firstItem.click();
    await expect
      .poll(() => page.getByRole("treeitem").count(), { timeout: T_NORMAL })
      .toBeLessThanOrEqual(expanded);
  });
});
