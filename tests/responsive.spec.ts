import { test, expect } from "@playwright/test";
import { APP_URL, T_NORMAL, T_SHELL_BOOT } from "./helpers";

test.use({ viewport: { width: 390, height: 844 } });

test.beforeEach(async ({ page }) => {
  await page.goto(APP_URL);
  await page.getByTestId("tab-catalog").waitFor({ state: "visible", timeout: T_SHELL_BOOT });
});

test("mobile workspace uses a dismissible catalog drawer without page overflow", async ({ page }) => {
  await expect(page.getByTestId("catalog-sidebar")).toBeHidden();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.getByTestId("toggle-sidebar").click();
  const drawer = page.getByRole("dialog", { name: "Catalog sidebar" });
  await expect(drawer).toBeVisible({ timeout: T_NORMAL });

  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden({ timeout: T_NORMAL });
});

test("settings uses horizontal navigation and stays within the viewport", async ({ page }) => {
  await page.getByTestId("toggle-sidebar").click();
  await page.locator('[data-slot="dialog-trigger"]', { hasText: "Settings" }).click();

  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible({ timeout: T_NORMAL });
  await expect(dialog.getByRole("tablist")).toHaveAttribute("data-orientation", "horizontal");
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("editor Ask AI stacks below the editor on mobile", async ({ page }) => {
  await page.getByTestId("tab-editor").click();
  await page.getByTestId("editor-ask-ai").click();

  const panel = page.getByTestId("editor-ai-panel");
  await expect(panel).toBeVisible({ timeout: T_NORMAL });
  const editor = page.locator(".cm-editor").first();
  const [editorBox, panelBox] = await Promise.all([editor.boundingBox(), panel.boundingBox()]);
  expect(editorBox).not.toBeNull();
  expect(panelBox).not.toBeNull();
  expect(panelBox!.y).toBeGreaterThanOrEqual(editorBox!.y + editorBox!.height - 2);
});
