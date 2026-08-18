import { test, expect } from "@playwright/test";
import { gotoApp, openEditor, typeInEditor, waitForShellBridge, T_NORMAL } from "./helpers";

test.beforeEach(async ({ page }) => {
  await gotoApp(page);
  await waitForShellBridge(page);
});

test("opens the report library and creates a blank draft", async ({ page }) => {
  await page.getByTestId("tab-reports").click();
  await expect(page.getByTestId("reports-workspace")).toBeVisible({ timeout: T_NORMAL });
  await page.getByRole("button", { name: "New report" }).click();
  await expect(page.locator('input[value="New report"]')).toBeVisible();
  await expect(page.getByText("Start with a request")).toBeVisible();
});

test("promotes the current editor statement into a runnable report table", async ({ page }) => {
  await openEditor(page);
  await typeInEditor(page, "SELECT 42 AS answer");
  await page.getByTestId("editor-add-to-report").click();

  await expect(page.getByTestId("tab-reports")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Add query to a report")).toBeVisible({ timeout: T_NORMAL });
  await page.getByRole("button", { name: "Create new report" }).click();
  await page.getByTestId("reports-workspace").getByRole("button", { name: "Refresh", exact: true }).click();

  await expect(page.getByRole("columnheader", { name: "answer" })).toBeVisible({ timeout: T_NORMAL });
  await expect(page.getByRole("cell", { name: "42" })).toBeVisible({ timeout: T_NORMAL });

  await page.getByRole("button", { name: "Accept & save" }).click();
  await page.getByRole("button", { name: "Library" }).click();
  await expect(page.getByRole("button", { name: /^Query 1 Ready/ })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: /^Query 1 Ready/ })).toBeVisible({ timeout: T_NORMAL });
});
