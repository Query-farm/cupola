import { test, expect } from "@playwright/test";
import { APP_URL, T_NORMAL, T_SHELL_BOOT } from "./helpers";

test.use({ viewport: { width: 390, height: 844 } });

test.beforeEach(async ({ page }) => {
  await page.goto(APP_URL);
  await page.getByTestId("tab-catalog").waitFor({ state: "visible", timeout: T_SHELL_BOOT });
});

test("mobile workspace uses a dismissible catalog drawer without page overflow", async ({ page }) => {
  const header = page.getByRole("banner");
  await expect(header.getByTestId("workspace-picker")).toBeVisible();
  await expect(header.getByTestId("toggle-sidebar")).toBeVisible();
  await expect(header.getByTestId("toggle-sidebar")).toHaveAccessibleName("Open catalog menu");
  expect((await header.boundingBox())!.height).toBeLessThanOrEqual(52);
  await expect(page.getByTestId("catalog-sidebar")).toBeHidden();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.getByTestId("toggle-sidebar").click();
  const drawer = page.getByRole("dialog", { name: "Catalog sidebar" });
  await expect(drawer).toBeVisible({ timeout: T_NORMAL });
  await expect(drawer.getByRole("link", { name: "Cupola", exact: true })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden({ timeout: T_NORMAL });
});

test("settings uses horizontal navigation and stays within the viewport", async ({ page }) => {
  await page.getByTestId("toggle-sidebar").click();
  await page.getByTestId("catalog-sidebar").getByRole("button", { name: "Settings", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible({ timeout: T_NORMAL });
  await expect(dialog.getByRole("tablist")).toHaveAttribute("data-orientation", "horizontal");
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("editor tools fill the workspace on mobile and preserve the query", async ({ page }) => {
  await page.getByTestId("tab-editor").click();
  const editor = page.locator(".cm-editor").first();
  await expect(editor).toBeVisible();
  await page.getByTestId("mobile-assistant").click();

  const panel = page.getByTestId("editor-ai-panel");
  await expect(panel).toBeVisible({ timeout: T_NORMAL });
  await expect(editor).toBeHidden();
  await page.getByTestId("mobile-query").click();
  await expect(editor).toBeVisible();
  await expect(panel).toBeHidden();
});
