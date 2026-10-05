/**
 * Unified top tab bar + M0/M1 refinements: tab switching, sidebar collapse,
 * column-comment tooltips, drag-insert into the editor, download .sql.
 */
import { test, expect } from "@playwright/test";
import { gotoApp, openEditor, typeInEditor, waitForShellBridge, T_NORMAL, T_SHELL_BOOT } from "./helpers";

/** Run a query in the editor and pivot its result as a snapshot. */
async function pivotSnapshot(page: import("@playwright/test").Page) {
  await openEditor(page);
  await typeInEditor(page, "SELECT 1 AS one");
  await page.getByTestId("editor-run").click();
  await page.getByTestId("editor-open-perspective").click({ timeout: T_SHELL_BOOT });
  await page.getByTestId("editor-pivot-snapshot").click();
  await expect(page.getByTestId("tab-perspective")).toHaveAttribute("aria-selected", "true", { timeout: T_SHELL_BOOT });
}

test.beforeEach(async ({ page }) => {
  await gotoApp(page);
  await waitForShellBridge(page);
});

test.describe("Unified tab bar", () => {
  test("all five tabs are present and switch; Perspective is not one until it is opened", async ({ page }) => {
    for (const id of ["catalog", "editor", "askai", "reports", "shell"]) {
      await expect(page.getByTestId(`tab-${id}`)).toBeVisible();
    }
    await expect(page.getByRole("tablist", { name: "Workspace" }).getByRole("tab")).toHaveText([
      "Query Editor",
      "Ask AI",
      "Reports",
      "SQL Shell",
      "Catalog",
    ]);
    await expect(page.getByTestId("tab-perspective")).toHaveCount(0);
    await page.getByTestId("tab-shell").click();
    await expect(page.getByTestId("tab-shell")).toHaveAttribute("aria-selected", "true");
  });

  test("a pivot opens the Perspective tab; closing it empties it and returns to the editor", async ({ page }) => {
    await pivotSnapshot(page);
    await expect(page.locator("perspective-viewer")).toBeAttached({ timeout: T_SHELL_BOOT });

    await page.getByTestId("tab-perspective-close").click();
    await expect(page.getByTestId("tab-perspective")).toHaveCount(0);
    await expect(page.getByTestId("tab-editor")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("perspective-viewer")).toHaveCount(0);
  });

  test("does not restore the transient Perspective tab after a reload", async ({ page }) => {
    await pivotSnapshot(page);
    await expect.poll(() => page.evaluate(() => localStorage.getItem("vgi-active-tab"))).toBe("perspective");

    await page.reload();

    await expect(page.getByTestId("tab-catalog")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("tab-perspective")).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => localStorage.getItem("vgi-active-tab"))).toBe("catalog");
  });

  test("sidebar collapses and expands", async ({ page }) => {
    await expect(page.getByRole("tree").first()).toBeVisible();
    await page.getByTestId("toggle-sidebar").click();
    await expect(page.getByRole("tree").first()).toBeHidden();
    await page.getByTestId("toggle-sidebar").click();
    await expect(page.getByRole("tree").first()).toBeVisible();
  });

  test("download .sql triggers a download", async ({ page }) => {
    await openEditor(page);
    await typeInEditor(page, "SELECT 1 AS one");
    const downloadPromise = page.waitForEvent("download");
    await page.getByTestId("editor-share-menu").click();
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

  test("starting prompt uses an accessible, keyboard-dismissable dialog", async ({ page }) => {
    await page.getByTestId("tab-askai").click();
    const trigger = page.getByRole("button", { name: "Starting prompt" });
    await trigger.click();

    const dialog = page.getByRole("dialog", { name: "Starting Prompt" });
    await expect(dialog).toBeVisible({ timeout: T_NORMAL });
    await expect(dialog.getByRole("button", { name: "Copy starting prompt" })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden({ timeout: T_NORMAL });
    await expect(trigger).toBeFocused();
  });
});
