/**
 * Query history — every surface records through `ui.addQueryHistoryEntry`, the
 * History tab of the editor's side panel lists the entries ("All", plus the
 * current tab's runs as a diff stack), and they are kept per server in
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
    await page.getByTestId("editor-history-view-all").click();
    const entry = page.getByTestId("editor-history-entry").filter({ hasText: "SELECT 7 * 6 AS answer" });
    await expect(entry).toBeVisible({ timeout: T_NORMAL });
    await expect(entry).toContainText("Editor");
    await expect(entry).toContainText("1 row");

    const tabsBefore = await page.getByTestId("editor-tab").count();
    await entry.getByTestId("editor-history-open").click();
    await expect(page.locator(".cm-content").first()).toHaveText("SELECT 7 * 6 AS answer");
    await expect(page.getByTestId("editor-tab")).toHaveCount(tabsBefore + 1);
  });

  test("shell queries are listed too, and Run runs them in the editor", async ({ page }) => {
    await openShell(page);
    await page.evaluate(() => (window as any).__bridge.runQuery("SELECT 'from the shell' AS origin"));
    await openEditor(page);
    await page.getByTestId("editor-history").click();
    await page.getByTestId("editor-history-view-all").click();
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
    await page.getByTestId("editor-history-view-all").click();
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

  test("This tab lists the tab's versions as a diff stack, and Restore brings one back", async ({ page }) => {
    await page.getByTestId("editor-add-tab").click();
    await typeInEditor(page, "SELECT 1 AS first_version");
    await page.getByTestId("editor-run").click();
    await expect(page.getByTestId("sql-editor-view").getByText("first_version", { exact: true })).toBeVisible({ timeout: T_SHELL_BOOT });
    await typeInEditor(page, "SELECT 2 AS second_version");
    await page.getByTestId("editor-run").click();
    await expect(page.getByTestId("sql-editor-view").getByText("second_version", { exact: true })).toBeVisible({ timeout: T_SHELL_BOOT });

    await page.getByTestId("editor-history").click();
    await page.getByTestId("editor-history-view-tab").click();
    const runs = page.getByTestId("editor-history-revision");
    await expect(runs).toHaveCount(2);
    // The newest run shows what changed since the one before it.
    const diff = runs.first().getByTestId("editor-history-diff");
    await expect(diff).toContainText("- SELECT 1 AS first_version");
    await expect(diff).toContainText("+ SELECT 2 AS second_version");

    await runs.last().getByTestId("editor-history-restore").click();
    await expect(page.locator(".cm-content").first()).toHaveText("SELECT 1 AS first_version");
    // Restoring is an edit like any other: undo takes it back.
    await page.locator(".cm-content").first().click();
    await page.keyboard.press("ControlOrMeta+z");
    await expect(page.locator(".cm-content").first()).toHaveText("SELECT 2 AS second_version");

    // Another tab has its own runs.
    await page.getByTestId("editor-add-tab").click();
    await expect(runs).toHaveCount(0);
  });

  test("a Format and an Ask AI apply are versions too, and closing the tab deletes them", async ({ page }) => {
    await page.getByTestId("editor-add-tab").click();
    await typeInEditor(page, "select 'mine' as never_ran");
    await page.getByTestId("editor-format").click();
    await expect(page.locator(".cm-content")).toContainText("SELECT", { timeout: T_NORMAL });
    await page.getByTestId("editor-ask-ai").click();
    await page.evaluate(() =>
      (window as any).__cupolaEditorAiTest.pushAssistantSql({ sql: "SELECT 'from ai' AS proposal", columns: ["proposal"], rows: [{ proposal: "from ai" }] }),
    );
    await page.getByTestId("ai-apply-menu").click();
    await page.getByTestId("ai-apply-replace-document").click();
    await expect(page.locator(".cm-content")).toContainText("from ai", { timeout: T_NORMAL });

    await page.getByTestId("editor-history").click();
    await page.getByTestId("editor-history-view-tab").click();
    const versions = page.getByTestId("editor-history-revision");
    // Newest first: the AI's SQL, the formatted text it replaced, and the text
    // as typed (none of which ever ran).
    await expect(versions).toHaveCount(3);
    await expect(versions.nth(0)).toHaveAttribute("data-kind", "ai");
    await expect(versions.nth(1)).toHaveAttribute("data-kind", "format");
    await expect(versions.nth(2)).toHaveAttribute("data-kind", "edit");
    await expect(versions.nth(2)).toContainText("select 'mine' as never_ran");

    const key = await page.evaluate(() => Object.keys(localStorage).find((k) => k.startsWith("cupola.editor-revisions.v1::")) ?? null);
    expect(key).not.toBeNull();
    const tab = page.getByTestId("editor-tab").last();
    await tab.hover();
    await tab.getByRole("button", { name: /^Close / }).click();
    await page.getByTestId("editor-close-delete").click();
    await expect.poll(() => page.evaluate((k) => localStorage.getItem(k!), key)).toBeNull();
  });
});
