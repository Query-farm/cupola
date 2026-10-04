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

test("Lines layout formats JSON, and a field can switch back to the stored text", async ({ page }) => {
  await page.getByRole("radio", { name: "Lines layout" }).click();
  const doc = page.getByRole("listitem").first().locator("dd").nth(2);
  await expect(doc).toHaveText(JSON.stringify({ a: 1, b: [2, 3] }, null, 2));
  await doc.hover();
  await doc.getByRole("button", { name: "Show as stored" }).click();
  await expect(doc).toHaveText('{"a":1,"b":[2,3]}');
  await doc.getByRole("button", { name: "Format JSON" }).click();
  await expect(doc).toHaveText(JSON.stringify({ a: 1, b: [2, 3] }, null, 2));
});

test("a tall record keeps its own header pinned while it scrolls", async ({ page }) => {
  await typeInEditor(page, "SELECT i AS id, repeat('tall' || chr(10), 60) AS body FROM range(1, 4) t(i)");
  await page.getByTestId("editor-run").click();
  await expect(page.getByRole("grid").locator('tbody td[data-col="0"]').first()).toHaveText("1", { timeout: T_NORMAL });
  await page.getByRole("radio", { name: "Lines layout" }).click();
  const list = page.getByRole("list", { name: "Result rows" });
  const records = list.getByRole("listitem");
  await expect(records).toHaveCount(3);

  // Scroll into the middle of the SECOND record. Its header must sit at the top
  // of the list (a transformed record used to pin every header as if its record
  // started at the top of the list, so it drifted down by the scroll offset).
  const second = records.nth(1);
  const top = await second.evaluate((el) => (el as HTMLElement).offsetTop);
  await list.evaluate((el, y) => { el.scrollTop = y + 200; }, top);
  const header = second.locator("header");
  await expect(header).toContainText("Row 2");
  await expect.poll(async () => {
    const [h, l] = await Promise.all([header.boundingBox(), list.boundingBox()]);
    return Math.round((h?.y ?? 0) - (l?.y ?? 0));
  }).toBe(0);
});

test("the value panel can be dragged wider and reset", async ({ page }) => {
  await page.evaluate(() => localStorage.removeItem("cupola.value-panel-width"));
  await page.getByRole("grid").locator('td[data-row="0"][data-col="1"]').dblclick();
  const panel = page.getByTestId("value-panel");
  const before = (await panel.boundingBox())!.width;
  const handle = page.getByRole("separator", { name: "Resize value panel" });
  const box = (await handle.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x - 150, y, { steps: 5 });
  await page.mouse.up();
  const after = (await panel.boundingBox())!.width;
  expect(after - before).toBeGreaterThan(140);
  expect(await page.evaluate(() => localStorage.getItem("cupola.value-panel-width"))).toBe(String(Math.round(after)));

  await handle.dblclick();
  await expect.poll(async () => Math.round((await panel.boundingBox())!.width)).toBe(Math.round(before));
});

test("in the maximized results, Esc closes the value panel before the dialog", async ({ page }) => {
  await page.getByTitle("Maximize results").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("grid").locator('td[data-row="0"][data-col="1"]').dblclick();
  const panel = dialog.getByRole("region", { name: "Cell value" });
  await expect(panel.getByTestId("cell-value")).toHaveText(LONG);
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("the value panel and Lines layout work in the pop-out results window", async ({ page }) => {
  const [popup] = await Promise.all([
    page.waitForEvent("popup"),
    page.getByTitle("Pop out results to a new window").click(),
  ]);
  const grid = popup.getByRole("grid");
  await expect(grid.locator('tbody td[data-col="0"]')).toHaveText(["1", "2"], { timeout: T_NORMAL });
  await grid.locator('td[data-row="0"][data-col="1"]').dblclick();
  const panel = popup.getByRole("region", { name: "Cell value" });
  await expect(panel.getByTestId("cell-value")).toHaveText(LONG);

  // The drag listens on the pop-out's own window, not the opener's.
  const panelBox = popup.getByTestId("value-panel");
  const before = (await panelBox.boundingBox())!.width;
  const box = (await popup.getByRole("separator", { name: "Resize value panel" }).boundingBox())!;
  const y = box.y + box.height / 2;
  await popup.mouse.move(box.x + box.width / 2, y);
  await popup.mouse.down();
  await popup.mouse.move(box.x - 100, y, { steps: 5 });
  await popup.mouse.up();
  expect((await panelBox.boundingBox())!.width - before).toBeGreaterThan(90);

  await popup.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await popup.getByRole("radio", { name: "Lines layout" }).click();
  await expect(popup.getByRole("listitem").first().locator("dd").nth(1)).toHaveText(LONG);
});
