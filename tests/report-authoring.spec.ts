import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { APP_ORIGIN, BASE, T_SHELL_BOOT, waitForShellBridge } from "./helpers";

async function openGuide(page: import("@playwright/test").Page) {
  await page.goto(`${APP_ORIGIN}${BASE}report-guide/`);
  await page.getByTestId("report-block-showcase-kpi").waitFor({ state: "visible", timeout: T_SHELL_BOOT });
  await expect(page.getByTestId("reports-run")).toHaveText(/Run report/, { timeout: T_SHELL_BOOT });
}

/** Whether the element is what the pointer would hit at its center — `toBeVisible` passes for an element hidden behind another. */
async function isTopmost(locator: import("@playwright/test").Locator): Promise<boolean> {
  return locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return hit !== null && element.contains(hit);
  });
}

async function openCurrentDatasetEditor(page: import("@playwright/test").Page) {
  await page.getByTestId("report-datasets-tab").click();
  await page.getByTestId("report-dataset-item-showcase-current").click();
  await page.getByTestId("report-edit-dataset").click();
  return page.getByTestId("report-dataset-sql-editor");
}

test("KPI builder can create its first dataset and resume block setup", async ({ page }) => {
  test.setTimeout(60_000);
  await openGuide(page);
  await page.getByRole("button", { name: "Reports", exact: true }).click();
  await page.getByRole("button", { name: "New report", exact: true }).click();
  await page.getByTestId("report-add-block").click();
  await page.getByTestId("report-add-kpi").click();

  const editor = page.getByTestId("report-block-editor");
  await expect(editor.getByText("This report has no datasets for blocks yet.")).toBeVisible();
  await expect(page.getByText(/report\.blocks\[0\]\.(datasetId|valueColumn) must/)).toHaveCount(0);
  await expect(editor.getByTestId("report-block-apply")).toBeDisabled();
  await editor.getByLabel("Title", { exact: true }).fill("Answer");
  await editor.getByRole("button", { name: "Add SQL dataset" }).click();

  await expect(editor).toHaveCount(0);
  await page.getByTestId("report-dataset-sql-editor").fill("SELECT 42 AS answer");
  await page.getByRole("button", { name: "Test query", exact: true }).click();
  await expect(page.getByTestId("report-apply-dataset")).toBeEnabled({ timeout: T_SHELL_BOOT });
  await page.getByTestId("report-apply-dataset").click();

  await expect(editor).toBeVisible();
  await expect(editor.getByLabel("Title", { exact: true })).toHaveValue("Answer");
  await expect(editor.getByLabel("Dataset", { exact: true })).not.toHaveValue("");
  await editor.getByLabel("Value", { exact: true }).selectOption("answer");
  await expect(editor.getByTestId("report-block-apply")).toBeEnabled();
  await editor.getByTestId("report-block-apply").click();
  await expect(editor).toHaveCount(0);
  await expect(page.locator('.react-grid-item[data-testid^="report-block-"]')).toContainText("42");
  await expect(page.getByRole("button", { name: "Save report draft" })).toBeEnabled();
});

test("KPI builder preserves block edits when returning from its dataset editor", async ({ page }) => {
  test.setTimeout(60_000);
  await openGuide(page);
  await page.getByTestId("report-block-showcase-kpi").hover();
  await page.getByRole("button", { name: "Edit KPI · Humidity (%)" }).click();
  const editor = page.getByTestId("report-block-editor");
  await editor.getByLabel("Title", { exact: true }).fill("Updated humidity");
  await editor.getByRole("button", { name: "Edit dataset", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel dataset editing" }).click();
  await page.getByTestId("report-view-tab").click();
  await expect(editor.getByLabel("Title", { exact: true })).toHaveValue("Updated humidity");
  await editor.getByTestId("report-block-apply").click();
  await expect(page.getByTestId("report-block-showcase-kpi")).toContainText("Updated humidity");
});

test("dataset Test is isolated and Apply reuses the staged result", async ({ page }) => {
  test.setTimeout(60_000);
  await openGuide(page);
  await waitForShellBridge(page);
  await page.evaluate(() => {
    const bridge = (window as any).__bridge;
    const queryPrepared = bridge.queryPrepared.bind(bridge);
    (window as any).__reportAuthoringQueries = 0;
    bridge.queryPrepared = async (...args: any[]) => {
      (window as any).__reportAuthoringQueries += 1;
      return queryPrepared(...args);
    };
  });

  let sql = await openCurrentDatasetEditor(page);
  const original = await sql.inputValue();
  const changed = original.replace("('Glen Allen', TIMESTAMP '2026-08-20 12:00:00', 82, 68, 42)", "('Glen Allen', TIMESTAMP '2026-08-20 12:00:00', 82, 70, 42)");
  expect(changed).not.toBe(original);
  await sql.fill(changed);
  await page.getByRole("button", { name: "Test query" }).click();
  await expect(page.getByTestId("report-dataset-editor").getByRole("status")).toContainText("reuse these results", { timeout: T_SHELL_BOOT });
  expect(await page.evaluate(() => (window as any).__reportAuthoringQueries)).toBe(1);

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Cancel dataset editing" }).click();
  await page.getByTestId("report-view-tab").click();
  await expect(page.getByTestId("report-block-showcase-kpi")).toContainText("68");

  sql = await openCurrentDatasetEditor(page);
  await sql.fill(changed);
  await page.getByRole("button", { name: "Test query" }).click();
  await expect(page.getByTestId("report-dataset-editor").getByRole("status")).toContainText("reuse these results", { timeout: T_SHELL_BOOT });
  expect(await page.evaluate(() => (window as any).__reportAuthoringQueries)).toBe(2);
  await page.getByTestId("report-apply-dataset").click();
  expect(await page.evaluate(() => (window as any).__reportAuthoringQueries)).toBe(2);
  await page.getByTestId("report-view-tab").click();
  await expect(page.getByTestId("report-block-showcase-kpi")).toContainText("70");
});

test("dataset Apply is blocked when the result breaks consuming blocks", async ({ page }) => {
  test.setTimeout(60_000);
  await openGuide(page);
  const sql = await openCurrentDatasetEditor(page);
  await sql.fill("SELECT 70 AS humidity_changed");
  await expect(page.getByRole("button", { name: "Save report draft" })).toBeDisabled();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByTestId("report-view-tab").click();
  await expect(page.getByTestId("report-dataset-editor")).toBeVisible();
  await page.getByRole("button", { name: "Test query" }).click();
  const status = page.getByTestId("report-dataset-editor").getByRole("status");
  await expect(status).toContainText("would break report blocks", { timeout: T_SHELL_BOOT });
  await expect(status).toContainText("missing result column");
  await expect(page.getByTestId("report-apply-dataset")).toBeDisabled();
});

test("dataset Test surfaces DuckDB syntax errors and keeps Apply blocked", async ({ page }) => {
  test.setTimeout(60_000);
  await openGuide(page);
  const sql = await openCurrentDatasetEditor(page);
  await sql.fill("SELECT 1 + FROM (VALUES (1))");
  const testQuery = page.getByRole("button", { name: "Test query" });
  await expect(testQuery).toBeEnabled();
  await testQuery.click();

  const status = page.getByTestId("report-dataset-editor").getByRole("status");
  await expect(status).toContainText(/Parser Error|syntax error/i, { timeout: T_SHELL_BOOT });
  await expect(page.getByTestId("report-apply-dataset")).toBeDisabled();
});

test("direct block resizing reflows grouped neighbors instead of overlapping them", async ({ page }) => {
  test.setTimeout(60_000);
  await openGuide(page);
  const kpi = page.getByTestId("report-block-showcase-kpi");
  const smallMultiples = page.getByTestId("report-block-showcase-small-multiples");
  await kpi.hover();
  await page.getByRole("button", { name: "Edit KPI · Humidity (%)" }).click();
  await page.getByLabel("Height").fill("6");
  await page.getByTestId("report-block-apply").click();

  await expect.poll(async () => {
    const editedBox = await kpi.boundingBox();
    const neighborBox = await smallMultiples.boundingBox();
    if (!editedBox || !neighborBox) return false;
    return editedBox.y + editedBox.height <= neighborBox.y + 1;
  }).toBe(true);
});

test("the report toolbar can explicitly reflow a draft without creating overlaps", async ({ page }) => {
  test.setTimeout(60_000);
  await openGuide(page);
  const reflow = page.getByRole("button", { name: "Reflow report layout" });
  await expect(reflow).toBeVisible();
  await expect(reflow).toHaveAttribute("title", /Tighten vertical gaps/);
  await reflow.click();
  await expect(page.getByText(/Report blocks reflowed|already compact/)).toBeVisible();

  const overlaps = await page.locator('.react-grid-item[data-testid^="report-block-"]').evaluateAll((blocks) => {
    const rectangles = blocks.map((block) => block.getBoundingClientRect());
    const collisions: string[] = [];
    for (let first = 0; first < rectangles.length; first += 1) {
      for (let second = first + 1; second < rectangles.length; second += 1) {
        const a = rectangles[first];
        const b = rectangles[second];
        if (a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1) {
          collisions.push(`${first}:${second}`);
        }
      }
    }
    return collisions;
  });
  expect(overlaps).toEqual([]);
});

test("dataset deletion is guarded and editable SQL has a clear surface", async ({ page }) => {
  test.setTimeout(60_000);
  await openGuide(page);
  await page.getByTestId("report-datasets-tab").click();
  await page.getByTestId("report-dataset-item-showcase-current").click();
  const remove = page.getByTestId("report-delete-dataset");
  await expect(remove).toBeDisabled();
  await expect(remove).toHaveAttribute("title", /Used by .* report block/);

  await page.getByTestId("report-edit-dataset").click();
  const sql = page.getByTestId("report-dataset-sql-editor");
  await expect(sql).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(page.getByText(/Editable SQL/)).toBeVisible();
});

test("chart editor preserves advanced specs and never hides an invalid JSON lock", async ({ page }) => {
  test.setTimeout(60_000);
  await openGuide(page);

  const advancedChart = page.getByTestId("report-block-showcase-chart");
  await advancedChart.hover();
  await page.getByRole("button", { name: "Edit Vega-Lite chart · Reading versus guideline" }).click();
  let editor = page.getByTestId("report-block-editor");
  await expect(editor.getByRole("button", { name: "Advanced" })).toHaveAttribute("aria-pressed", "true");
  await editor.getByRole("button", { name: "Cancel" }).click();

  await page.getByTestId("report-add-block").click();
  await page.getByTestId("report-add-chart").click();
  editor = page.getByTestId("report-block-editor");
  await expect(editor.getByRole("button", { name: "Basic" })).toHaveAttribute("aria-pressed", "true");
  await editor.getByRole("button", { name: "Advanced" }).click();
  await editor.getByLabel("Vega-Lite specification").fill("{");
  await expect(editor.getByRole("alert")).toBeVisible();
  await editor.getByRole("button", { name: "Basic" }).click();
  await expect(editor.getByText("Fix invalid JSON before applying.")).toHaveCount(0);
  await expect(editor.getByTestId("report-block-apply")).toBeEnabled();
  await editor.getByTestId("report-block-apply").click();
});

test("clearing optional table columns restores the all-columns default", async ({ page }) => {
  test.setTimeout(60_000);
  await openGuide(page);
  const table = page.getByTestId("report-block-showcase-table");
  await table.hover();
  await page.getByRole("button", { name: "Edit Table · Exact rows and standard formatting" }).click();
  const editor = page.getByTestId("report-block-editor");
  await editor.getByLabel("Visible columns").fill("");
  await editor.getByTestId("report-block-apply").click();
  await expect(table.getByRole("columnheader", { name: "observed_at" })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "city" })).toBeVisible();
});

test("the mobile block editor is viewport-contained and accessible", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await openGuide(page);
  const kpi = page.getByTestId("report-block-showcase-kpi");
  await kpi.hover();
  await page.getByRole("button", { name: "Edit KPI · Humidity (%)" }).click();
  const editor = page.getByTestId("report-block-editor");
  await expect(editor.getByLabel("Title")).toBeFocused();
  const box = await editor.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeLessThanOrEqual(1);
  expect(box!.y).toBe(0);
  expect(box!.width).toBeGreaterThanOrEqual(389);
  expect(box!.height).toBe(844);
  const widths = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client + 1);
  await expect(editor.getByRole("button", { name: "Apply" })).toBeVisible();

  const accessibility = await new AxeBuilder({ page }).include('[data-testid="report-block-editor"]').analyze();
  expect(accessibility.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical")).toEqual([]);
});

test("chart export controls do not interfere with plot tooltips or gestures", async ({ page }) => {
  test.setTimeout(60_000);
  await openGuide(page);
  const chart = page.getByTestId("report-block-showcase-chart");
  await chart.hover();
  const actions = page.getByTestId("report-block-actions-showcase-chart");
  const plot = chart.getByTestId("report-chart-container");
  await expect(actions).toBeVisible();
  await expect(plot.locator("svg")).toBeVisible();
  const marks = plot.locator("svg path");
  let tooltipVisible = false;
  for (let index = 0; index < await marks.count(); index += 1) {
    await marks.nth(index).hover({ force: true });
    tooltipVisible = await page.locator(".vg-tooltip").isVisible().catch(() => false);
    if (tooltipVisible) break;
  }
  expect(tooltipVisible).toBe(true);
  await plot.dblclick({ position: { x: 80, y: 80 } });
  await expect(page.getByTestId("report-block-editor")).toHaveCount(0);

  const map = page.getByTestId("report-block-showcase-map");
  await map.locator(".leaflet-container").dblclick({ position: { x: 100, y: 100 } });
  await expect(page.getByTestId("report-block-editor")).toHaveCount(0);
});

test("block settings explain themselves on hover, click, and keyboard", async ({ page }) => {
  test.setTimeout(60_000);
  await openGuide(page);
  await page.getByRole("button", { name: "Reports", exact: true }).click();
  await page.getByRole("button", { name: "New report", exact: true }).click();

  // The picker says what each block type is for, not just its name.
  await page.getByTestId("report-add-block").click();
  await expect(page.getByTestId("report-add-range_dot")).toContainText("A low-to-high span per row");
  await page.getByTestId("report-add-kpi").click();

  const editor = page.getByTestId("report-block-editor");
  await expect(editor.getByTestId("report-block-editor-description")).toHaveText("One headline number, optionally placed within a range.");
  const lowBound = editor.locator('[data-report-field="Low bound"]');
  const help = lowBound.locator("[data-report-help]");
  const explanation = page.locator('[data-slot="popover-content"]', { hasText: "draws a small bar under the number" });

  await help.hover();
  await expect(explanation).toBeVisible();
  // Visible is not enough: this once opened behind the editor panel.
  expect(await isTopmost(explanation)).toBe(true);
  await editor.getByLabel("Title", { exact: true }).hover();
  await expect(explanation).toBeHidden();

  await help.click();
  await expect(explanation).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(explanation).toBeHidden();
  // Escape dismissed only the explanation; the editor and its draft remain.
  await expect(editor).toBeVisible();

  await editor.getByLabel("Title", { exact: true }).focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-slot="popover-content"]', { hasText: "The heading at the top of the block" })).toBeVisible();
});

test("report menus open above the block editor panel", async ({ page }) => {
  test.setTimeout(60_000);
  await openGuide(page);
  await page.getByTestId("report-block-showcase-kpi").hover();
  await page.getByRole("button", { name: "Edit KPI · Humidity (%)" }).click();
  await expect(page.getByTestId("report-block-editor")).toBeVisible();

  // The panel once stacked above every popover, hiding the menu's lower items.
  await page.getByRole("button", { name: "More" }).click();
  const items = page.locator('[data-slot="popover-content"] button');
  await expect(items.last()).toBeVisible();
  for (const item of await items.all()) expect(await isTopmost(item), await item.innerText()).toBe(true);
});

test("the mobile block editor covers the app header and maps beneath it", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await openGuide(page);
  const map = page.getByTestId("report-block-showcase-map");
  await map.scrollIntoViewIfNeeded();
  await expect(map.locator(".leaflet-container")).toBeVisible();
  const box = (await map.boundingBox())!;
  await map.hover();
  await map.getByRole("button", { name: /^Edit / }).first().click();
  const editor = page.getByTestId("report-block-editor");
  await expect(editor).toBeVisible();

  const coveredBy = (x: number, y: number) => page.evaluate(([px, py]) => Boolean(document.elementFromPoint(px, py)?.closest('[data-testid="report-block-editor"]')), [x, y]);
  expect(await coveredBy(195, 20)).toBe(true);
  expect(await coveredBy(box.x + box.width / 2, box.y + box.height / 2)).toBe(true);
});
