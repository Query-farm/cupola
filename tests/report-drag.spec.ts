import { test, expect, type Page } from "@playwright/test";
import { gotoApp, waitForShellBridge, T_NORMAL } from "./helpers";

// One grid row is REPORT_GRID_ROW_HEIGHT (56px) plus REPORT_GRID_MARGIN (12px).
const ROW_PX = 68;

// Tall enough that the whole stack and the drag path stay on screen: the
// mouse cannot grab a header scrolled out of the report canvas.
test.use({ viewport: { width: 1400, height: 1200 } });

test.beforeEach(async ({ page }) => {
  await gotoApp(page);
  await waitForShellBridge(page);
  await page.keyboard.press("Escape");
});

async function importStackedReport(page: Page, grouped: boolean) {
  await page.getByTestId("tab-reports").click();
  const now = Date.now();
  const block = (id: string, y: number) => ({
    id,
    type: "markdown",
    title: `Block ${id.toUpperCase()}`,
    markdown: `Content of block ${id}.`,
    ...(grouped ? { groupId: "section" } : {}),
    layout: { x: 0, y, w: 12, h: 4 },
  });
  const top = grouped ? 1 : 0;
  const report = {
    schemaVersion: 1,
    id: `drag-${grouped ? "grouped" : "plain"}`,
    title: "Drag reorder",
    createdAt: now,
    updatedAt: now,
    revision: 1,
    requiredSources: [],
    parameters: [],
    datasets: [],
    ...(grouped ? { groups: [{ id: "section", title: "Section" }] } : {}),
    blocks: [block("a", top), block("b", top + 4), block("c", top + 8)],
  };
  await page.locator('input[type="file"]').setInputFiles({
    name: "drag.cupola-report.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(report)),
  });
  await expect(page.getByTestId("report-block-header-c")).toBeVisible({ timeout: T_NORMAL });
}

async function blockOrder(page: Page): Promise<string[]> {
  const tops = await Promise.all(["a", "b", "c"].map(async (id) => ({
    id,
    top: (await page.getByTestId(`report-block-${id}`).boundingBox())!.y,
  })));
  return tops.sort((left, right) => left.top - right.top).map(({ id }) => id);
}

async function dragHeader(page: Page, id: string, rows: number) {
  const header = page.getByTestId(`report-block-header-${id}`);
  await header.scrollIntoViewIfNeeded();
  const box = (await header.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + rows * ROW_PX, { steps: 12 });
  await page.mouse.up();
}

for (const grouped of [false, true]) {
  test.describe(grouped ? "grouped report" : "ungrouped report", () => {
    test("a block dragged down passes the block below it", async ({ page }) => {
      await importStackedReport(page, grouped);
      expect(await blockOrder(page)).toEqual(["a", "b", "c"]);
      // Three rows is past the midpoint of the 4-row block below, but short of
      // its full height — the distance react-grid-layout's own swap needed.
      await dragHeader(page, "a", 3);
      await expect.poll(() => blockOrder(page)).toEqual(["b", "a", "c"]);
      // The new order reached the draft, not just the grid's own state: a
      // remounted grid is laid out from the draft alone.
      await page.getByTestId("report-datasets-tab").click();
      await page.getByTestId("report-view-tab").click();
      await expect(page.getByTestId("report-block-header-c")).toBeVisible();
      expect(await blockOrder(page)).toEqual(["b", "a", "c"]);
    });

    test("a block dragged up passes every block it crosses", async ({ page }) => {
      await importStackedReport(page, grouped);
      await dragHeader(page, "c", -7);
      await expect.poll(() => blockOrder(page)).toEqual(["c", "a", "b"]);
    });
  });
}
