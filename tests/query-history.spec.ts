/**
 * Query history — the bridge exposes a recorder that the UI surfaces in the
 * Query History tab. We verify the recorder + UI rendering directly; routing
 * through the xterm `runQuery` path is covered indirectly by the shell tests.
 */
import { test, expect } from "@playwright/test";
import { gotoApp, openShell, waitForShellBridge, T_NORMAL, T_SHELL_BOOT } from "./helpers";

test.beforeEach(async ({ page }) => {
  await gotoApp(page);
  await waitForShellBridge(page);
  await openShell(page);
});

test.describe("Query history", () => {
  test("recorded query appears in the Query History tab", async ({ page }) => {
    // Wait for the shell to have wired up addQueryHistoryEntry.
    await page.waitForFunction(
      () => typeof (window as any).__bridge?.addQueryHistoryEntry === "function",
      null,
      { timeout: T_SHELL_BOOT },
    );

    await page.evaluate(() => {
      (window as any).__bridge.addQueryHistoryEntry({
        id: Date.now(),
        timestamp: Date.now(),
        sql: "SELECT 7 * 6 AS answer",
        executionTimeMs: 4,
        success: true,
        rowCount: 1,
      });
    });

    const historyTab = page.getByRole("tab", { name: /^Query History \(\d+\)$/ });
    await expect(historyTab).toBeVisible({ timeout: T_NORMAL });
    await historyTab.click();
    await expect(page.getByText("SELECT 7 * 6 AS answer", { exact: false })).toBeVisible({
      timeout: T_NORMAL,
    });
  });
});
