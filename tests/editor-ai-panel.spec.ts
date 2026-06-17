/**
 * Conversational Ask AI side panel in the Query Editor: toggle/persist/resize,
 * apply-back, and per-editor-tab memory. Conversation turns are injected via
 * the window.__cupolaEditorAiTest hook so these run without the network.
 */
import { test, expect } from "@playwright/test";
import { gotoApp, openEditor, typeInEditor, waitForShellBridge, T_NORMAL } from "./helpers";

test.beforeEach(async ({ page }) => {
  await gotoApp(page);
  await waitForShellBridge(page);
  await openEditor(page);
});

test.describe("Editor Ask AI panel", () => {
  test("toggles open/closed and persists across reload", async ({ page }) => {
    await expect(page.getByTestId("editor-ai-panel")).toBeHidden();
    await page.getByTestId("editor-ask-ai").click();
    await expect(page.getByTestId("editor-ai-panel")).toBeVisible();
    await expect(page.getByTestId("editor-ask-ai")).toHaveAttribute("aria-pressed", "true");

    await page.reload();
    await waitForShellBridge(page);
    // Persisted open (vgi-editor-ai-open) — editor tab was also persisted.
    await expect(page.getByTestId("editor-ai-panel")).toBeVisible({ timeout: T_NORMAL });

    await page.getByTestId("editor-ask-ai").click();
    await expect(page.getByTestId("editor-ai-panel")).toBeHidden();
  });

  test("applies AI-proposed SQL into the editor", async ({ page }) => {
    await page.getByTestId("editor-ask-ai").click();
    await page.evaluate(() =>
      (window as any).__cupolaEditorAiTest.pushAssistantSql({ sql: "SELECT 777 AS applied", columns: ["applied"], rows: [{ applied: 777 }] }),
    );
    // Expand the SQL tool block (collapsed by default) is not required for the
    // apply bar — it sits beneath the block. Open the Apply menu.
    await page.getByTestId("ai-apply-menu").click();
    await page.getByTestId("ai-apply-replace-document").click();
    await expect(page.locator(".cm-content")).toContainText("SELECT 777 AS applied", { timeout: T_NORMAL });
  });

  test("opens proposed SQL in a new editor tab", async ({ page }) => {
    await page.getByTestId("editor-ask-ai").click();
    await page.evaluate(() =>
      (window as any).__cupolaEditorAiTest.pushAssistantSql({ sql: "SELECT 'newtab' AS m", columns: ["m"], rows: [{ m: "newtab" }] }),
    );
    const tabsBefore = await page.getByTestId("editor-tabs").locator("[role=tab]").count();
    await page.getByTestId("ai-apply-open-tab").click();
    await expect(page.getByTestId("editor-tabs").locator("[role=tab]")).toHaveCount(tabsBefore + 1, { timeout: T_NORMAL });
  });

  test("keeps a separate conversation per editor tab", async ({ page }) => {
    await page.getByTestId("editor-ask-ai").click();
    await page.evaluate(() => (window as any).__cupolaEditorAiTest.pushUser("marker-in-tab-A"));
    await expect(page.getByTestId("editor-ai-panel")).toContainText("marker-in-tab-A");

    // New editor tab → its own (empty) conversation.
    await page.getByTestId("editor-add-tab").click();
    await expect(page.getByTestId("editor-ai-panel")).not.toContainText("marker-in-tab-A");

    // Back to the first tab → its conversation is still there.
    await page.getByTestId("editor-tabs").getByText("Query 1").click();
    await expect(page.getByTestId("editor-ai-panel")).toContainText("marker-in-tab-A");
  });
});
