/**
 * DataGrid column sizing: content-sized columns (no stretch-to-fill), the
 * width clamps, drag-to-resize, and double-click autofit.
 */
import { test, expect, type Page } from "@playwright/test";
import { gotoApp, openEditor, typeInEditor, waitForShellBridge, T_NORMAL } from "./helpers";

/** Run SQL in the editor and wait for the result grid to render its header. */
async function runQuery(page: Page, sql: string): Promise<void> {
  await typeInEditor(page, sql);
  await page.getByTestId("editor-run").click();
  await expect(page.locator('[role="grid"] tbody td').first()).toBeVisible({ timeout: T_NORMAL });
}

/** Rendered widths of every header cell: ["#", ...data columns, spacer]. */
function headerWidths(page: Page): Promise<number[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[role="grid"] thead th')].map((th) =>
      Math.round(th.getBoundingClientRect().width),
    ),
  );
}

/** Pointer-drag a column's resize handle by `dx` px. */
async function dragHandle(page: Page, nthColumn: number, dx: number): Promise<void> {
  const handle = page.locator(`[role="grid"] thead th:nth-child(${nthColumn}) [role="separator"]`);
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 10 });
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  await gotoApp(page);
  await waitForShellBridge(page);
  await openEditor(page);
});

test.describe("DataGrid column sizing", () => {
  test("sizes a lone column to its content instead of the whole panel", async ({ page }) => {
    await runQuery(page, "SELECT 'hello ' || i AS greeting FROM range(20) t(i)");
    const [gutter, greeting, spacer] = await headerWidths(page);
    expect(gutter).toBeLessThan(60);
    // Content-sized, not panel-sized — the leftover goes to the spacer column.
    expect(greeting).toBeLessThan(200);
    expect(spacer).toBeGreaterThan(greeting);
  });

  test("clamps wide content and floors narrow columns", async ({ page }) => {
    await runQuery(page, "SELECT repeat('x', 300) AS wide, i AS n FROM range(20) t(i)");
    const [, wide, n] = await headerWidths(page);
    expect(wide).toBeLessThanOrEqual(400);
    expect(n).toBeGreaterThanOrEqual(48);
  });

  test("drag-resizes a column and keeps the width across a sort", async ({ page }) => {
    await runQuery(page, "SELECT 'value ' || i AS label, i AS n FROM range(20) t(i)");
    const before = (await headerWidths(page))[1];
    await dragHandle(page, 2, 60);
    const after = (await headerWidths(page))[1];
    expect(after).toBeGreaterThan(before + 40);

    // Sorting re-runs the query (and the width measurement) — the hand-set
    // width is keyed by column name, so it must survive.
    await page.locator('[role="grid"] thead th:nth-child(3) button').click();
    await expect(page.locator('[role="grid"] tbody td').first()).toBeVisible({ timeout: T_NORMAL });
    expect((await headerWidths(page))[1]).toBe(after);
  });

  test("double-click autofits a column to its widest visible value", async ({ page }) => {
    await runQuery(page, "SELECT repeat('x', 60) AS wide, i AS n FROM range(20) t(i)");
    // Starts clamped at the 400px cap, so the value is truncated.
    const cell = page.locator('[role="grid"] tbody td[data-col="0"]').first();
    await dragHandle(page, 2, -250);
    expect(await cell.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);

    const handle = page.locator('[role="grid"] thead th:nth-child(2) [role="separator"]');
    const box = (await handle.boundingBox())!;
    await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
    // Autofit sizes to the full value: no more clipping.
    await expect
      .poll(() => cell.evaluate((el) => el.scrollWidth > el.clientWidth))
      .toBe(false);
  });

  test("resizing a column does not sort it", async ({ page }) => {
    await runQuery(page, "SELECT 'value ' || i AS label, i AS n FROM range(20) t(i)");
    await dragHandle(page, 2, 60);
    // Only the reserved (invisible) chevron placeholders are present.
    const visibleChevrons = await page.evaluate(
      () => document.querySelectorAll('[role="grid"] thead svg:not(.invisible)').length,
    );
    expect(visibleChevrons).toBe(0);
  });
});
