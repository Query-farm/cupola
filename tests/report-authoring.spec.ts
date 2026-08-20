import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { APP_ORIGIN, BASE, T_SHELL_BOOT, waitForShellBridge } from "./helpers";

async function openGuide(page: import("@playwright/test").Page) {
  await page.goto(`${APP_ORIGIN}${BASE}report-guide/`);
  await page.getByTestId("report-block-showcase-kpi").waitFor({ state: "visible", timeout: T_SHELL_BOOT });
  await expect(page.getByTestId("reports-run")).toHaveText(/Run report/, { timeout: T_SHELL_BOOT });
}

async function openCurrentDatasetEditor(page: import("@playwright/test").Page) {
  await page.getByTestId("report-datasets-tab").click();
  await page.getByTestId("report-dataset-item-showcase-current").click();
  await page.getByTestId("report-edit-dataset").click();
  return page.getByTestId("report-dataset-sql-editor");
}

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
