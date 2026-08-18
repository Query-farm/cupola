import { test, expect } from "@playwright/test";
import { gotoApp, openEditor, typeInEditor, waitForShellBridge, T_NORMAL } from "./helpers";

test.beforeEach(async ({ page }) => {
  await gotoApp(page);
  await waitForShellBridge(page);
  // Dismiss any first-run informational dialog in a fresh browser profile.
  await page.keyboard.press("Escape");
});

test("opens the report library and creates a blank draft", async ({ page }) => {
  await page.getByTestId("tab-reports").click();
  await expect(page.getByTestId("reports-workspace")).toBeVisible({ timeout: T_NORMAL });
  await page.getByRole("button", { name: "New report" }).click();
  await expect(page.locator('input[value="New report"]')).toBeVisible();
  await expect(page.getByText("Start with a request")).toBeVisible();
});

test("renders report text blocks without waiting for a dataset", async ({ page }) => {
  await page.getByTestId("tab-reports").click();
  const now = Date.now();
  const report = {
    schemaVersion: 1,
    id: "text-block-example",
    title: "Text block example",
    createdAt: now,
    updatedAt: now,
    revision: 1,
    requiredSources: [],
    parameters: [],
    datasets: [],
    blocks: [{
      id: "summary",
      type: "markdown",
      title: "Summary",
      markdown: "## Executive summary\n\nAll three datasets are ready.",
      layout: { x: 0, y: 0, w: 12, h: 3 },
    }],
  };
  await page.locator('input[type="file"]').setInputFiles({
    name: "text.cupola-report.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(report)),
  });

  await expect(page.getByText("Executive summary", { exact: true })).toBeVisible();
  await expect(page.getByText("All three datasets are ready.")).toBeVisible();
  await expect(page.getByText("This report has not loaded its data yet.")).toHaveCount(0);
});

test("promotes the current editor statement into a runnable report table", async ({ page }) => {
  await openEditor(page);
  await typeInEditor(page, "SELECT 42 AS answer, 'North & <South>' AS note, TIMESTAMP '2021-01-01 00:00:00.123456' AS occurred_at");
  await page.getByTestId("editor-add-to-report").click();

  await expect(page.getByTestId("tab-reports")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Add query to a report")).toBeVisible({ timeout: T_NORMAL });
  await page.getByRole("button", { name: "Create new report" }).click();
  await expect(page.getByRole("button", { name: "Run report", exact: true })).toHaveCount(2);
  await page.getByTestId("reports-run").click();

  await expect(page.getByRole("columnheader", { name: "answer" })).toBeVisible({ timeout: T_NORMAL });
  await expect(page.getByRole("cell", { name: "42" })).toBeVisible({ timeout: T_NORMAL });
  await expect(page.getByRole("cell", { name: "North & <South>" })).toBeVisible({ timeout: T_NORMAL });
  await expect(page.getByRole("cell", { name: "2021-01-01 00:00:00.123456" })).toBeVisible({ timeout: T_NORMAL });

  await page.getByRole("button", { name: "Accept & save" }).click();
  await page.getByRole("button", { name: "Library" }).click();
  await expect(page.getByRole("button", { name: /^Query 1 Ready/ })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: /^Query 1 Ready/ })).toBeVisible({ timeout: T_NORMAL });
});

test("fits a chart to its report block without an inner scrollbar", async ({ page }) => {
  await page.getByTestId("tab-reports").click();
  const now = Date.now();
  const report = {
    schemaVersion: 1,
    id: "chart-sizing-example",
    title: "Chart sizing example",
    createdAt: now,
    updatedAt: now,
    revision: 1,
    requiredSources: [],
    parameters: [],
    datasets: [{ id: "chart-data", name: "Chart data", sql: "SELECT * FROM (VALUES ('A', 10), ('B', 20)) AS t(category, value)" }],
    blocks: [{
      id: "chart-block",
      type: "chart",
      datasetId: "chart-data",
      title: "Values by category",
      layout: { x: 0, y: 0, w: 8, h: 6 },
      spec: { mark: "bar", encoding: { x: { field: "category", type: "nominal" }, y: { field: "value", type: "quantitative" } } },
    }],
  };
  await page.locator('input[type="file"]').setInputFiles({
    name: "chart.cupola-report.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(report)),
  });
  await page.getByTestId("reports-run").click();

  const chart = page.getByTestId("report-chart-container");
  await expect(chart.locator("svg")).toBeVisible({ timeout: T_NORMAL });
  expect(await chart.evaluate((element) => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
});

test("renders a declarative Leaflet map from query coordinates", async ({ page }) => {
  await page.getByTestId("tab-reports").click();
  const now = Date.now();
  const report = {
    schemaVersion: 1,
    id: "map-example",
    title: "Location map",
    createdAt: now,
    updatedAt: now,
    revision: 1,
    requiredSources: [],
    parameters: [],
    datasets: [{
      id: "locations",
      name: "Locations",
      sql: "SELECT * FROM (VALUES ('New York', 40.7128, -74.0060, 'East'), ('Chicago', 41.8781, -87.6298, 'Central')) AS t(name, latitude, longitude, region)",
    }],
    blocks: [{
      id: "location-map",
      type: "map",
      datasetId: "locations",
      title: "Offices",
      latitudeColumn: "latitude",
      longitudeColumn: "longitude",
      labelColumn: "name",
      colorColumn: "region",
      tooltipColumns: ["name", "region"],
      basemap: "none",
      layout: { x: 0, y: 0, w: 12, h: 6 },
    }],
  };
  await page.locator('input[type="file"]').setInputFiles({
    name: "map.cupola-report.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(report)),
  });
  await page.getByTestId("reports-run").click();

  const map = page.getByTestId("report-map");
  await expect(map.locator(".leaflet-container")).toBeVisible({ timeout: T_NORMAL });
  await expect(map.locator(".leaflet-interactive")).toHaveCount(2, { timeout: T_NORMAL });
  await map.locator(".leaflet-interactive").first().click();
  await expect(map.getByText("New York", { exact: false })).toBeVisible();
  expect(await map.evaluate((element) => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
});
