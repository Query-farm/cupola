/**
 * Memory catalog — creating a new view in `memory.main` should cause the
 * sidebar tree to surface it after the catalog refreshes.
 */
import { test, expect } from "@playwright/test";
import { gotoApp, openShell, waitForShellBridge, T_NORMAL, T_SHELL_BOOT } from "./helpers";

test.beforeEach(async ({ page }) => {
  await gotoApp(page);
  await waitForShellBridge(page);
  await openShell(page);
});

test.describe("Memory catalog sidebar", () => {
  test("memory catalog and schemas appear only while they contain objects", async ({ page }) => {
    // Wait for refreshMemoryTables to be wired up by CatalogApp.
    await page.waitForFunction(
      () => typeof (window as any).__bridge?.refreshMemoryTables === "function",
      null,
      { timeout: T_SHELL_BOOT },
    );
    await page.evaluate(async () => { await (window as any).__bridge.refreshMemoryTables(); });
    const local = page.getByRole('region', { name: 'On this device', exact: true });
    const memory = local.getByRole('treeitem', { name: 'memory', exact: true });
    await expect(memory).toHaveCount(0);
    await expect(local).toBeHidden();

    const VIEW_NAME = `pw_test_view_${Date.now()}`;

    // Create the view, then trigger a memory-catalog refresh.
    const created = await page.evaluate(async (name) => {
      const bridge = (window as any).__bridge;
      const drop = await bridge.query(`DROP VIEW IF EXISTS memory.main.${name}`);
      if (!drop.ok) return { ok: false, step: "drop", error: drop.error };
      const create = await bridge.query(
        `CREATE VIEW memory.main.${name} AS SELECT 1 AS x, 'hi' AS y`,
      );
      if (!create.ok) return { ok: false, step: "create", error: create.error };
      await bridge.refreshMemoryTables();
      return { ok: true };
    }, VIEW_NAME);
    expect(created.ok, JSON.stringify(created)).toBe(true);

    // Use the sidebar filter to surface the new view (auto-expands matching nodes).
    const filter = page.getByLabel("Filter catalog");
    await filter.fill(VIEW_NAME);
    const viewItem = page.getByRole("treeitem", { name: new RegExp(VIEW_NAME) }).first();
    await expect(viewItem).toBeVisible({ timeout: T_NORMAL });
    await expect(memory).toBeVisible();
    await expect(local.getByRole('treeitem', { name: 'main', exact: true })).toBeVisible();

    // Cleanup: drop the view, refresh, and assert it's gone from the tree.
    await page.evaluate(async (name) => {
      const bridge = (window as any).__bridge;
      await bridge.query(`DROP VIEW IF EXISTS memory.main.${name}`);
      await bridge.refreshMemoryTables();
    }, VIEW_NAME);

    await expect(viewItem).toBeHidden({ timeout: T_NORMAL });
    await filter.fill("");
    await expect(memory).toHaveCount(0);
    await expect(local).toBeHidden();
  });
});
