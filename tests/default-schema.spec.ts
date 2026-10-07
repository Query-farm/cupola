/** Startup schema regressions using test-worker/run.sh's cupola_test catalog. */
import { test, expect } from "@playwright/test";
import { APP_URL, gotoApp } from "./helpers";

test.describe("Default schema startup", () => {
  test("opens the default schema on startup and lets the user collapse it", async ({ page }) => {
    await gotoApp(page);
    const sidebar = page.getByTestId("catalog-sidebar");
    const schema = sidebar.getByRole("treeitem", { name: "small", exact: true });
    await expect(schema).toHaveAttribute("aria-expanded", "true");
    await expect(sidebar.getByRole("treeitem", { name: /^regions / })).toBeVisible();
    await expect(page.locator("main nav").first()).toContainText("small");

    await schema.click();
    await expect(schema).toHaveAttribute("aria-expanded", "false");
    await sidebar.getByLabel("Refresh catalogs").click();
    await expect(sidebar.getByLabel("Refresh catalogs")).toBeEnabled();
    await expect(schema).toHaveAttribute("aria-expanded", "false");
  });

  test("opens the workspace's default schema when it overrides the catalog default", async ({ page }) => {
    await gotoApp(page);
    await page.evaluate(() => {
      const key = "cupola.workspaces.v1";
      const store = JSON.parse(localStorage.getItem(key)!);
      store.workspaces[0].defaultSchema = "edge";
      localStorage.setItem(key, JSON.stringify(store));
    });
    await page.reload();
    const sidebar = page.getByTestId("catalog-sidebar");
    await expect(sidebar.getByRole("treeitem", { name: "edge", exact: true })).toHaveAttribute("aria-expanded", "true");
    await expect(sidebar.getByRole("treeitem", { name: "small", exact: true })).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("main nav").first()).toContainText("edge");
  });

  for (const hash of ["#/schema/edge", "#/catalog/cupola_test/schema/edge"]) {
    test(`preserves the linked schema at ${hash}`, async ({ page }) => {
      await page.goto(`${APP_URL}${hash}`);
      const sidebar = page.getByTestId("catalog-sidebar");
      await expect(page.locator("main nav").first()).toContainText("edge");
      await expect(sidebar.getByRole("treeitem", { name: "small", exact: true })).toHaveAttribute("aria-expanded", "false");
      await expect(page).toHaveURL(`${APP_URL}${hash}`);
    });
  }

});
