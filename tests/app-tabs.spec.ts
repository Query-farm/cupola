/**
 * Unified top tab bar + M0/M1 refinements: tab switching, sidebar collapse,
 * column-comment tooltips, drag-insert into the editor, download .sql.
 */
import { test, expect } from "@playwright/test";
import { gotoApp, openEditor, typeInEditor, waitForShellBridge, T_NORMAL } from "./helpers";

test.beforeEach(async ({ page }) => {
  await gotoApp(page);
  await waitForShellBridge(page);
});

test.describe("Unified tab bar", () => {
  test("all seven tabs are present and switch", async ({ page }) => {
    for (const id of ["catalog", "editor", "shell", "askai", "preview", "queries", "perspective"]) {
      await expect(page.getByTestId(`tab-${id}`)).toBeVisible();
    }
    await page.getByTestId("tab-shell").click();
    await expect(page.getByTestId("tab-shell")).toHaveAttribute("aria-selected", "true");
    await page.getByTestId("tab-perspective").click();
    await expect(page.getByTestId("tab-perspective")).toHaveAttribute("aria-selected", "true");
  });

  test("sidebar collapses and expands", async ({ page }) => {
    await expect(page.getByRole("tree").first()).toBeVisible();
    await page.getByTestId("toggle-sidebar").click();
    await expect(page.getByRole("tree").first()).toBeHidden();
    await page.getByTestId("toggle-sidebar").click();
    await expect(page.getByRole("tree").first()).toBeVisible();
  });

  test("Preview tab shows an empty state with no selection/result", async ({ page }) => {
    await page.getByTestId("tab-preview").click();
    await expect(page.getByText(/Select a table in the sidebar, or run a query/i)).toBeVisible({ timeout: T_NORMAL });
  });

  test("download .sql triggers a download", async ({ page }) => {
    await openEditor(page);
    await typeInEditor(page, "SELECT 1 AS one");
    const downloadPromise = page.waitForEvent("download");
    await page.getByTestId("editor-download-sql").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.sql$/);
  });

  test("Ask AI panel toggles open from the editor toolbar", async ({ page }) => {
    await openEditor(page);
    await typeInEditor(page, "SELECT count(*) FROM foo");
    await page.getByTestId("editor-ask-ai").click();
    await expect(page.getByTestId("editor-ai-panel")).toBeVisible({ timeout: T_NORMAL });
  });
});
