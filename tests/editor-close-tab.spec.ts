/**
 * Closing a Query Editor tab deletes its query, so a tab with SQL in it asks
 * first; an empty tab closes at once.
 */
import { test, expect } from "@playwright/test";
import { gotoApp, openEditor, typeInEditor, T_NORMAL } from "./helpers";

test.beforeEach(async ({ page }) => {
  await gotoApp(page);
  await openEditor(page);
});

test("an empty tab closes without asking", async ({ page }) => {
  await page.getByTestId("editor-add-tab").click();
  const tabs = page.getByTestId("editor-tab");
  const before = await tabs.count();
  const last = tabs.last();
  await last.hover();
  await last.getByRole("button", { name: /^Close / }).click();
  await expect(page.getByTestId("editor-close-confirm")).toBeHidden();
  await expect(tabs).toHaveCount(before - 1);
});

test("a tab with SQL asks first; Keep is the default, Delete removes it", async ({ page }) => {
  await page.getByTestId("editor-add-tab").click();
  // Typed just before closing: the stored copy lags behind the editor, so the
  // dialog has to read the live text.
  await typeInEditor(page, "SELECT 'keep me' AS marker");
  const tabs = page.getByTestId("editor-tab");
  const before = await tabs.count();
  const last = tabs.last();
  await last.hover();
  await last.getByRole("button", { name: /^Close / }).click();

  const dialog = page.getByTestId("editor-close-confirm");
  await expect(dialog).toBeVisible({ timeout: T_NORMAL });
  await expect(dialog).toContainText("keep me");
  await expect(page.getByTestId("editor-close-cancel")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(tabs).toHaveCount(before);
  await expect(page.locator(".cm-content")).toContainText("keep me");

  await last.hover();
  await last.getByRole("button", { name: /^Close / }).click();
  await page.getByTestId("editor-close-delete").click();
  await expect(dialog).toBeHidden();
  await expect(tabs).toHaveCount(before - 1);
});
