/**
 * Query history — every surface records through `ui.addQueryHistoryEntry`, the
 * editor's History menu lists the entries, and they are kept per server in
 * localStorage, so they survive a reload.
 */
import { test, expect } from "@playwright/test";
import { gotoApp, openEditor, openShell, typeInEditor, waitForShellBridge, T_NORMAL, T_SHELL_BOOT } from "./helpers";

test.beforeEach(async ({ page }) => {
  await gotoApp(page);
  await waitForShellBridge(page);
  await openEditor(page);
});

test.describe("Query history", () => {
  test("an editor query is listed, survives a reload, and opens in a new tab", async ({ page }) => {
    await typeInEditor(page, "SELECT 7 * 6 AS answer");
    await page.getByTestId("editor-run").click();
    await expect(page.getByTestId("sql-editor-view").getByText("42", { exact: true })).toBeVisible({ timeout: T_SHELL_BOOT });

    await page.reload();
    await page.getByRole("tree").first().waitFor({ state: "visible", timeout: T_SHELL_BOOT });
    await openEditor(page);
    await page.getByTestId("editor-history").click();
    const entry = page.getByTestId("editor-history-entry").filter({ hasText: "SELECT 7 * 6 AS answer" });
    await expect(entry).toBeVisible({ timeout: T_NORMAL });
    await expect(entry).toContainText("Editor");
    await expect(entry).toContainText("1 row");

    const tabsBefore = await page.getByTestId("editor-tab").count();
    await entry.getByTestId("editor-history-open").click();
    await expect(page.getByTestId("editor-history-panel")).toHaveCount(0);
    await expect(page.locator(".cm-content").first()).toHaveText("SELECT 7 * 6 AS answer");
    await expect(page.getByTestId("editor-tab")).toHaveCount(tabsBefore + 1);
  });

  test("shell queries are listed too, and Run runs them in the editor", async ({ page }) => {
    await openShell(page);
    await page.evaluate(() => (window as any).__bridge.runQuery("SELECT 'from the shell' AS origin"));
    await openEditor(page);
    await page.getByTestId("editor-history").click();
    const entry = page.getByTestId("editor-history-entry").filter({ hasText: "from the shell" });
    await expect(entry).toBeVisible({ timeout: T_SHELL_BOOT });
    await expect(entry).toContainText("Shell");
    await entry.hover();
    await entry.getByTestId("editor-history-run").click();
    await expect(page.getByTestId("tab-editor")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("sql-editor-view").getByText("from the shell", { exact: true }).last()).toBeVisible({ timeout: T_SHELL_BOOT });
  });

  test("filter, remove and clear", async ({ page }) => {
    await page.evaluate(() => {
      const add = (window as any).__bridge.addQueryHistoryEntry;
      add({ id: 1, timestamp: Date.now(), sql: "SELECT 'alpha'", executionTimeMs: 3, success: true, rowCount: 1, source: "editor" });
      add({ id: 2, timestamp: Date.now(), sql: "SELECT boom", executionTimeMs: 2, success: false, error: "Binder Error: boom", source: "ask-ai", userQuestion: "why boom" });
    });
    await page.getByTestId("editor-history").click();
    const entries = page.getByTestId("editor-history-entry");
    await expect(entries).toHaveCount(2);
    await expect(entries.first()).toContainText("Binder Error: boom");
    await expect(entries.first()).toContainText("why boom");

    await page.getByLabel("Filter query history").fill("alpha");
    await expect(entries).toHaveCount(1);
    await page.getByLabel("Filter query history").fill("");

    await entries.first().hover();
    await entries.first().getByRole("button", { name: "Remove from history" }).click();
    await expect(entries).toHaveCount(1);

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId("editor-history-clear").click();
    await expect(entries).toHaveCount(0);
    await expect(page.getByTestId("editor-history-panel")).toContainText("No queries yet");
  });
});
