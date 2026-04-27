/**
 * SQL shell panel — open, minimize/expand, and full-screen toggle.
 */
import { test, expect } from "@playwright/test";
import { gotoApp, openShell, waitForShellBridge, T_FAST, T_NORMAL } from "./helpers";

test.beforeEach(async ({ page }) => {
  await gotoApp(page);
  await waitForShellBridge(page);
});

test.describe("Shell panel chrome", () => {
  test("opens from sidebar 'SQL Shell' button", async ({ page }) => {
    await openShell(page);
    await expect(page.getByRole("button", { name: "Minimize shell panel" })).toBeVisible({ timeout: T_FAST });
  });

  test("minimize and re-expand", async ({ page }) => {
    await openShell(page);
    await page.getByRole("button", { name: "Minimize shell panel" }).click();
    await expect(page.getByRole("button", { name: "Expand shell panel" })).toBeVisible({ timeout: T_NORMAL });
    await page.getByRole("button", { name: "Expand shell panel" }).click();
    await expect(page.getByRole("button", { name: "Minimize shell panel" })).toBeVisible({ timeout: T_NORMAL });
  });

  test("toggle full screen and back", async ({ page }) => {
    await openShell(page);
    await page.getByRole("button", { name: "Enter full screen" }).click();
    await expect(page.getByRole("button", { name: "Exit full screen" })).toBeVisible({ timeout: T_NORMAL });
    await page.getByRole("button", { name: "Exit full screen" }).click();
    await expect(page.getByRole("button", { name: "Enter full screen" })).toBeVisible({ timeout: T_NORMAL });
  });
});
