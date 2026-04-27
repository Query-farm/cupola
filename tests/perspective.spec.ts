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
});
