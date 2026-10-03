/**
 * Reading long values in the results view: the grid truncates a value to its
 * column width, so the value panel shows the active cell in full, and the
 * Lines layout shows every value of every row in full.
 */
import { test, expect } from "@playwright/test";
import { gotoApp, openEditor, typeInEditor, waitForShellBridge, T_NORMAL } from "./helpers";

const LONG = "lorem ipsum ".repeat(60).trim() + " END";

test.beforeEach(async ({ page }) => {
  await gotoApp(page);
  await waitForShellBridge(page);
  // Start from the grid: the layout is a persisted setting.
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem("vgi-frontend-settings") ?? "{}");
    localStorage.setItem("vgi-frontend-settings", JSON.stringify({ ...s, previewLayout: "grid" }));
  });
  await openEditor(page);
  await typeInEditor(
    page,
    `SELECT 1 AS id, '${LONG}' AS body, '{"a":1,"b":[2,3]}' AS doc UNION ALL SELECT 2, 'short', NULL ORDER BY id`,
  );
  await page.getByTestId("editor-run").click();
  await expect(page.getByRole("grid").locator('tbody td[data-col="0"]')).toHaveText(["1", "2"], { timeout: T_NORMAL });
});

test("double-click opens a cell's full value; it follows the active cell", async ({ page }) => {
  const grid = page.getByRole("grid");
  await grid.locator('td[data-row="0"][data-col="1"]').dblclick();
  const panel = page.getByRole("region", { name: "Cell value" });
  await expect(panel.getByTestId("cell-value")).toHaveText(LONG);
  await expect(panel).toContainText("Row 1");

  // Arrow keys move the active cell, and the panel with it.
  await page.keyboard.press("ArrowRight");
  await expect(panel.getByTestId("cell-value")).toHaveText(JSON.stringify({ a: 1, b: [2, 3] }, null, 2));
  await page.keyboard.press("ArrowDown");
  await expect(panel).toContainText("NULL");

  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();

  // Enter opens it from the keyboard.
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Enter");
  await expect(panel.getByTestId("cell-value")).toHaveText("short");
});

test("Lines layout shows every value in full, and the choice persists", async ({ page }) => {
  await page.getByRole("radio", { name: "Lines layout" }).click();
  const list = page.getByRole("list", { name: "Result rows" });
  const records = list.getByRole("listitem");
  await expect(records).toHaveCount(2);
  await expect(records.first()).toContainText("Row 1");
  await expect(records.first().locator("dd").nth(1)).toHaveText(LONG);
  await expect(records.nth(1).locator("dd").nth(2)).toHaveText("NULL");

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("vgi-frontend-settings") ?? "{}").previewLayout);
  expect(stored).toBe("lines");

  await page.getByRole("radio", { name: "Grid layout" }).click();
  await expect(page.getByRole("grid")).toBeVisible();
});
