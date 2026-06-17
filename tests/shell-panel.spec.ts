/**
 * SQL shell tab — selecting it, and terminal state surviving tab switches
 * (the unified top tab bar replaced the old minimize/maximize/fullscreen
 * drawer chrome).
 */
import { test, expect } from "@playwright/test";
import { gotoApp, openShell, waitForShellBridge, T_NORMAL } from "./helpers";

test.beforeEach(async ({ page }) => {
  await gotoApp(page);
  await waitForShellBridge(page);
});

test.describe("Shell tab", () => {
  test("selecting the SQL Shell tab shows the terminal", async ({ page }) => {
    await openShell(page);
    await expect(page.getByTestId("tab-shell")).toHaveAttribute("aria-selected", "true");
    // The xterm terminal surface is present.
    await expect(page.locator(".xterm").first()).toBeVisible({ timeout: T_NORMAL });
  });

  test("terminal singleton survives switching tabs", async ({ page }) => {
    await openShell(page);
    // Tag the live terminal instance (xterm uses a WebGL renderer, so its DOM
    // text is empty — assert on the singleton identity instead).
    await page.evaluate(() => { (window as any).__bridge.shellTerm.__testMarker = "kept"; });

    // Switch away and back.
    await page.getByTestId("tab-catalog").click();
    await expect(page.getByTestId("tab-catalog")).toHaveAttribute("aria-selected", "true");
    await openShell(page);

    // Same terminal instance (not torn down + recreated).
    const marker = await page.evaluate(() => (window as any).__bridge.shellTerm?.__testMarker);
    expect(marker).toBe("kept");
  });
});
