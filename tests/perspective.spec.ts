/**
 * Perspective tab — handing an Arrow IPC buffer to bridge.showPerspective
 * mounts <perspective-viewer> with the expected columns.
 */
import { test, expect } from "@playwright/test";
import { gotoApp, openShell, waitForShellBridge, T_NORMAL, T_SHELL_BOOT } from "./helpers";

test.beforeEach(async ({ page }) => {
  await gotoApp(page);
  await waitForShellBridge(page);
  await openShell(page);
});

test.describe("Perspective tab", () => {
  test("loads an Arrow result into <perspective-viewer>", async ({ page }) => {
    await page.waitForFunction(
      () => typeof (window as any).__bridge?.showPerspective === "function",
      null,
      { timeout: T_NORMAL },
    );

    const handed = await page.evaluate(async () => {
      const bridge = (window as any).__bridge;
      const r = await bridge.query(
        "SELECT n, n * n AS sq, 'row_' || n::VARCHAR AS label FROM generate_series(1, 25) t(n)",
      );
      if (!r.ok || !r.arrowBuffers?.length) return false;
      await bridge.showPerspective(new Uint8Array(r.arrowBuffers[0]));
      return true;
    });
    expect(handed).toBe(true);

    await expect(page.getByRole("tab", { name: /Perspective/ }))
      .toHaveAttribute("aria-selected", "true", { timeout: T_NORMAL });

    await expect(page.locator("perspective-viewer")).toBeAttached({ timeout: T_SHELL_BOOT });

    const columns = await page.evaluate(async () => {
      const el = document.querySelector("perspective-viewer") as any;
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        try {
          const table = await el?.getTable?.();
          if (table) return (await table.columns()) as string[];
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      return null;
    });
    expect(columns).not.toBeNull();
    expect(columns).toEqual(expect.arrayContaining(["n", "sq", "label"]));
  });

  // Perspective's default `zip` list flattening expands LIST columns into one
  // row per element and aborts when two lists in a row differ in length (the
  // USGS earthquakes catalog's `ids` / `types`). Snapshots stringify instead.
  test("keeps one row per result row for LIST columns of differing length", async ({ page }) => {
    await page.waitForFunction(
      () => typeof (window as any).__bridge?.showPerspective === "function",
      null,
      { timeout: T_NORMAL },
    );

    await page.evaluate(async () => {
      const bridge = (window as any).__bridge;
      const r = await bridge.query(
        "SELECT * FROM (VALUES (1, ['a'], ['x', 'y']), (2, ['b', 'c', 'd'], [])) t(id, ids, types)",
      );
      if (!r.ok || !r.arrowBuffers?.length) throw new Error("query failed");
      await bridge.showPerspective(new Uint8Array(r.arrowBuffers[0]));
    });

    await expect(page.locator("perspective-viewer")).toBeAttached({ timeout: T_SHELL_BOOT });

    const data = await page.evaluate(async () => {
      const el = document.querySelector("perspective-viewer") as any;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        try {
          const table = await el?.getTable?.();
          if (table) {
            const view = await table.view();
            const cols = await view.to_columns();
            await view.delete();
            return cols;
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      return null;
    });
    expect(data).not.toBeNull();
    expect(data.id).toEqual([1, 2]);
    expect(data.ids).toHaveLength(2);
    expect(data.types).toHaveLength(2);
  });
});
