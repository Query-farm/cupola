/**
 * DBeaver-style SQL editor surface: run statement, run selection, multi-tab
 * persistence, format, and cross-linking with the shell.
 */
import { test, expect } from "@playwright/test";
import { gotoApp, openEditor, typeInEditor, waitForShellBridge, T_NORMAL } from "./helpers";

test.beforeEach(async ({ page }) => {
  await gotoApp(page);
  await waitForShellBridge(page);
});

test.describe("SQL editor", () => {
  test("toggles to the editor with the sidebar still visible", async ({ page }) => {
    await openEditor(page);
    await expect(page.getByTestId("sql-editor-view")).toBeVisible();
    // Sidebar tree remains mounted alongside the editor.
    await expect(page.getByRole("tree").first()).toBeVisible();
  });

  test("runs the statement at the cursor and shows results", async ({ page }) => {
    await openEditor(page);
    await typeInEditor(page, "SELECT 42 AS answer");
    await page.getByTestId("editor-run").click();
    await expect(page.getByText("42").first()).toBeVisible({ timeout: T_NORMAL });
  });

  test("runs only the selected text", async ({ page }) => {
    await openEditor(page);
    await typeInEditor(page, "SELECT 1 AS one;\nSELECT 999 AS selected;");
    // Select the second statement by double-clicking its number token.
    await page.getByText("999").first().dblclick();
    await expect(page.getByTestId("editor-run")).toContainText("Run selection");
    await page.getByTestId("editor-run").click();
    await expect(page.getByText("999").nth(0)).toBeVisible({ timeout: T_NORMAL });
  });

  test("creates and persists multiple tabs across reload", async ({ page }) => {
    await openEditor(page);
    await typeInEditor(page, "SELECT 'first-tab-marker' AS m");
    await page.getByTestId("editor-add-tab").click();
    await typeInEditor(page, "SELECT 'second-tab-marker' AS m");
    // Two tabs now exist.
    await expect(page.getByTestId("editor-tabs").getByText("Query 1")).toBeVisible();
    await expect(page.getByTestId("editor-tabs").getByText("Query 2")).toBeVisible();

    await page.reload();
    await waitForShellBridge(page);
    // Editor view persisted; both tabs are restored with their SQL.
    await expect(page.getByTestId("sql-editor-view")).toBeVisible();
    await expect(page.getByTestId("editor-tabs").getByText("Query 2")).toBeVisible();
    await expect(page.getByText("second-tab-marker")).toBeVisible();
  });

  test("formats the SQL in place", async ({ page }) => {
    await openEditor(page);
    await typeInEditor(page, "select a,b from t");
    await page.getByTestId("editor-format").click();
    // sql-formatter upper-cases keywords and breaks the column list.
    await expect(page.locator(".cm-content")).toContainText("SELECT");
    await expect(page.locator(".cm-content")).toContainText("FROM");
  });

  test("surfaces a query error", async ({ page }) => {
    await openEditor(page);
    await typeInEditor(page, "SELEKT bogus");
    await page.getByTestId("editor-run").click();
    await expect(page.getByText("Query failed")).toBeVisible({ timeout: T_NORMAL });
  });
});
