import { test, expect } from "@playwright/test";
import { gotoApp, openEditor, replaceEditorText, shellQuery, waitForShellBridge, T_NORMAL } from "./helpers";

test.beforeEach(async ({ page }) => {
  await gotoApp(page);
  await waitForShellBridge(page);
  await openEditor(page);
});

for (const trigger of ["button", "shortcut"] as const) {
  test(`${trigger} runs the selection rather than the containing statement`, async ({ page }) => {
    const editor = page.locator(".cm-content");
    const selected = "SELECT 111 AS selected";
    await replaceEditorText(editor, `${selected}, 222 AS unselected`);
    await editor.press("ControlOrMeta+a");
    await editor.press("ArrowLeft");
    for (let i = 0; i < selected.length; i++) await editor.press("Shift+ArrowRight");
    await expect(page.getByTestId("editor-run")).toHaveText("Run selection");
    if (trigger === "button") await page.getByTestId("editor-run").click();
    else await editor.press("ControlOrMeta+Enter");
    await expect(page.getByRole("cell", { name: "111", exact: true })).toBeVisible({ timeout: T_NORMAL });
    await expect(page.getByRole("columnheader", { name: /unselected/ })).toHaveCount(0);
  });
}

test("query tabs retain selection, scrolling and undo independently", async ({ page }) => {
  const editor = page.locator(".cm-content");
  const sql = Array.from({ length: 150 }, (_, i) => `-- line ${i}`).join("\n") + "\nSELECT 111 AS original";
  await replaceEditorText(editor, sql);
  // A distinct undo step after the original document insertion.
  await page.getByTestId("editor-format").click();
  await editor.click();
  await editor.press("ControlOrMeta+End");
  await page.keyboard.insertText(" -- added");
  for (let i = 0; i < 5; i++) await editor.press("Shift+ArrowLeft");
  await expect(page.getByTestId("editor-run")).toHaveText("Run selection");
  const scroller = page.locator(".cm-scroller");
  const beforeScroll = await scroller.evaluate((el) => el.scrollTop);
  expect(beforeScroll).toBeGreaterThan(100);

  await page.getByTestId("editor-add-tab").click();
  await expect(page.getByTestId("editor-run")).toHaveText("Run");
  await replaceEditorText(editor, "SELECT 222 AS second");
  await page.getByTestId("editor-tabs").getByText("Query 1", { exact: true }).click();
  await expect(page.getByTestId("editor-run")).toHaveText("Run selection");
  await expect.poll(async () => Math.abs(await scroller.evaluate((el) => el.scrollTop) - beforeScroll)).toBeLessThan(3);

  // Focus without clicking (a click would replace the restored selection).
  await editor.focus();
  await page.keyboard.insertText("replaced");
  await expect(editor).toContainText("-- replaced");
  await editor.press("ControlOrMeta+z");
  await expect(editor).toContainText("-- added");
  await editor.press("ControlOrMeta+z");
  await expect(editor).not.toContainText("-- added");
  await expect(editor).toContainText("original");

  // Editing a restored session must still save to the correct tab.
  await page.getByTestId("editor-tabs").getByText("Query 2", { exact: true }).click();
  await expect(editor).toHaveText("SELECT 222 AS second");
  await page.reload();
  await waitForShellBridge(page);
  await page.getByTestId("editor-tabs").getByText("Query 1", { exact: true }).click();
  await editor.focus();
  await editor.press("ControlOrMeta+End");
  await expect(editor).not.toContainText("-- added");
  await expect(editor).toContainText("original");
});

test("another tab cannot cancel a running query through Run or its shortcut", async ({ page }) => {
  const catalog = await shellQuery(page, "SELECT catalog_name FROM information_schema.schemata WHERE catalog_name = 'cupola_test'");
  test.skip(!catalog.rows?.length, "requires test-worker/run.sh");
  const editor = page.locator(".cm-content");
  await replaceEditorText(editor, "SELECT count(*) AS n FROM cupola_test.edge.slow_rows(8000, 1000)");
  await page.getByTestId("editor-add-tab").click();
  await replaceEditorText(editor, "SELECT 222 AS second");
  await page.getByTestId("editor-tabs").getByText("Query 1", { exact: true }).click();
  await page.getByTestId("editor-run").click();
  await expect(page.getByTestId("editor-stop")).toBeVisible();
  await editor.focus();
  await editor.press("ControlOrMeta+Enter");
  await page.getByTestId("editor-tabs").getByText("Query 2", { exact: true }).click();
  await expect(page.getByTestId("editor-background-run")).toContainText("Query 1");
  await expect(page.getByTestId("editor-run")).toBeDisabled();
  await expect(page.getByTestId("editor-run-menu")).toBeDisabled();
  await editor.focus();
  await editor.press("ControlOrMeta+Enter");
  await expect(page.getByTestId("editor-background-run")).toBeVisible();
  await page.getByRole("button", { name: "Show running query" }).click();
  await expect(page.getByTestId("editor-stop")).toBeVisible();
  await expect(page.getByRole("cell", { name: "8000", exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("editor-cancelled")).toBeHidden();
  await page.getByTestId("editor-tabs").getByText("Query 2", { exact: true }).click();
  await expect(page.getByTestId("editor-background-run")).toBeHidden();
  await expect(page.getByTestId("editor-run")).toBeEnabled();
  await page.getByTestId("editor-run").click();
  await expect(page.getByRole("cell", { name: "222", exact: true })).toBeVisible({ timeout: T_NORMAL });
});
