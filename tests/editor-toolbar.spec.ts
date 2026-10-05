/**
 * The Query Editor toolbar: Run's menu (run all, explain), Share, the
 * shortcuts list, and the side-panel toggles.
 */
import { test, expect } from "@playwright/test";
import { gotoApp, openEditor, typeInEditor, waitForShellBridge, T_NORMAL, T_SHELL_BOOT } from "./helpers";

test.beforeEach(async ({ page }) => {
  await gotoApp(page);
  await waitForShellBridge(page);
  await openEditor(page);
});

test("Run all runs every statement; Explain shows the plan", async ({ page }) => {
  await typeInEditor(page, "CREATE OR REPLACE TEMP TABLE pw_toolbar AS SELECT 5 AS v; SELECT v * 2 AS doubled FROM pw_toolbar");
  await page.getByTestId("editor-run-menu").click();
  await page.getByTestId("editor-run-all").click();
  const view = page.getByTestId("sql-editor-view");
  await expect(view.getByText("doubled", { exact: true })).toBeVisible({ timeout: T_SHELL_BOOT });
  await expect(view.getByText("10", { exact: true })).toBeVisible();

  await typeInEditor(page, "SELECT v FROM pw_toolbar WHERE v > 1");
  await page.getByTestId("editor-run-menu").click();
  await page.getByTestId("editor-explain").click();
  await expect(view.getByText(/SEQ_SCAN|TABLE_SCAN|FILTER|PROJECTION/).first()).toBeVisible({ timeout: T_SHELL_BOOT });
});

test("Share holds link, file and report; shortcuts are listed for this platform", async ({ page }) => {
  await page.getByTestId("editor-share-menu").click();
  await expect(page.getByTestId("editor-share-link")).toBeVisible();
  await expect(page.getByTestId("editor-download-sql")).toBeVisible();
  await expect(page.getByTestId("editor-add-to-report")).toBeVisible();
  await page.getByTestId("editor-shortcuts").click();
  const dialog = page.getByTestId("editor-shortcuts-dialog");
  await expect(dialog).toBeVisible({ timeout: T_NORMAL });
  const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent));
  await expect(dialog).toContainText(mac ? "⌘Enter" : "Ctrl+Enter");
  await expect(page.getByTestId("editor-run")).toHaveAttribute("title", new RegExp(mac ? "⌘Enter" : "Ctrl\\+Enter"));
});

test("Inspector, Ask AI and History each open their tab of the side panel", async ({ page }) => {
  for (const [button, tab] of [["editor-inspector-toggle", "inspector"], ["editor-ask-ai", "ai"], ["editor-history", "history"]] as const) {
    await page.getByTestId(button).click();
    await expect(page.getByTestId(`dock-tab-${tab}`)).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId(button)).toHaveAttribute("aria-pressed", "true");
  }
  await page.getByTestId("editor-history").click();
  await expect(page.getByTestId("editor-dock")).toBeHidden();
});
