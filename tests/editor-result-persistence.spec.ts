/**
 * The editor's result grid must survive a tab switch. The view is kept mounted
 * (hidden) by CatalogApp rather than conditionally rendered, because the result
 * lives in component state as a decoded Arrow table.
 */
import { test, expect, type Page } from "@playwright/test";
import { gotoApp, openEditor, typeInEditor, waitForShellBridge, T_NORMAL } from "./helpers";

const grid = '[role="grid"]';

async function runQuery(page: Page, sql: string): Promise<void> {
  await typeInEditor(page, sql);
  await page.getByTestId("editor-run").click();
  await expect(page.locator(`${grid} tbody td`).first()).toBeVisible({ timeout: T_NORMAL });
}

test.beforeEach(async ({ page }) => {
  await gotoApp(page);
  await waitForShellBridge(page);
  await openEditor(page);
});

test.describe("editor result persistence", () => {
  for (const tab of ["askai", "shell", "catalog"] as const) {
    test(`result survives a round trip through the ${tab} tab`, async ({ page }) => {
      await runQuery(page, "SELECT i, 'row ' || i AS label FROM range(7) t(i)");
      const before = await page.locator(`${grid} tbody tr`).count();
      expect(before).toBeGreaterThan(0);

      await page.getByTestId(`tab-${tab}`).click();
      await expect(page.getByTestId("sql-editor-view")).not.toBeVisible();

      await page.getByTestId("tab-editor").click();
      await expect(page.getByTestId("sql-editor-view")).toBeVisible();
      // Still the same rendered result — not a cleared pane awaiting a re-run.
      await expect(page.locator(`${grid} tbody tr`)).toHaveCount(before);
      await expect(page.locator(`${grid} tbody td`).first()).toBeVisible();
    });
  }

  test("keeps the SQL text and result together across a switch", async ({ page }) => {
    const sql = "SELECT 42 AS answer";
    await runQuery(page, sql);
    await page.getByTestId("tab-askai").click();
    await page.getByTestId("tab-editor").click();

    await expect(page.locator(`${grid} tbody`)).toContainText("42");
    await expect(page.locator(".cm-content")).toContainText("42");
  });

  test("does not mount the editor until its tab is first opened", async ({ page }) => {
    // Fresh load on the catalog tab: no editor in the DOM at all, so the
    // CodeMirror chunk stays off the critical path.
    await page.getByTestId("tab-catalog").click();
    await page.reload();
    await page.getByRole("tree").first().waitFor({ state: "visible" });
    await expect(page.getByTestId("sql-editor-view")).toHaveCount(0);
  });
});
