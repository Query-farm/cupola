/**
 * Settings modal — open/close and persistence via localStorage.
 */
import { test, expect } from "@playwright/test";
import { gotoApp, T_FAST, T_NORMAL } from "./helpers";

test.beforeEach(async ({ page }) => {
  await gotoApp(page);
});

test.describe("Settings modal", () => {
  test("opens and closes", async ({ page }) => {
    await page.locator('[data-slot="dialog-trigger"]', { hasText: "Settings" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: T_NORMAL });
    await expect(dialog.getByRole("heading", { name: "Settings" })).toBeVisible({ timeout: T_FAST });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden({ timeout: T_NORMAL });
  });

  test("toggles a switch and persists in localStorage", async ({ page }) => {
    await page.locator('[data-slot="dialog-trigger"]', { hasText: "Settings" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: T_NORMAL });
    // Base UI Switch exposes state via aria-checked ("true" | "false").
    const firstSwitch = page.getByRole("switch").first();
    await expect(firstSwitch).toBeVisible({ timeout: T_NORMAL });
    const before = await firstSwitch.getAttribute("aria-checked");
    expect(["true", "false"]).toContain(before);
    await firstSwitch.click();
    await expect
      .poll(() => firstSwitch.getAttribute("aria-checked"), { timeout: T_NORMAL })
      .not.toBe(before);
    const stored = await page.evaluate(() => localStorage.getItem("vgi-frontend-settings"));
    expect(stored).toBeTruthy();
    await firstSwitch.click(); // restore
    await page.keyboard.press("Escape");
  });
});
