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
    parameters: [{ id: "city", key: "city", label: "City", type: "text", defaultValue: "Glen Allen" }],
    datasets: [{ id: "weather", name: "Weather", sql: "SELECT 68 AS humidity_pct" }],
    blocks: [{
      id: "summary",
      type: "markdown",
      title: "48-Hour Forecast — $city",
      markdown: "## Executive summary\n\nAll three datasets are ready.\n\nLocation: **$city**.",
      layout: { x: 0, y: 0, w: 12, h: 3 },
    }, {
      id: "content-only",
      type: "markdown",
      markdown: "### Supporting context\n\nThis card intentionally has no separate title.\n\n![Cupola mark](/favicon.svg)",
      layout: { x: 0, y: 3, w: 12, h: 3 },
    }, {
      id: "legacy-text",
      type: "markdown",
      title: "Text",
      markdown: "Legacy generic titles are treated as content-only cards.",
      layout: { x: 0, y: 6, w: 12, h: 2 },
    }, {
      id: "generated-summary",
      type: "ai_narrative",
      title: "Generated conditions",
      datasetId: "weather",
      instruction: "Summarize the current humidity.",
      snapshot: {
        markdown: "**Humidity is elevated** based on the latest observation.",
        generatedAt: now,
        dataFingerprint: "test-fingerprint",
        model: "test-model",
        rowCount: 1,
      },
      layout: { x: 0, y: 8, w: 12, h: 3 },
    }],
  };
  await page.locator('input[type="file"]').setInputFiles({
    name: "text.cupola-report.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(report)),
  });

  await expect(page.getByText("Executive summary", { exact: true })).toBeVisible();
  await expect(page.getByText("All three datasets are ready.")).toBeVisible();
  await expect(page.getByText("Location:").locator("..")).toContainText("Glen Allen");
  await expect(page.getByTestId("report-block-header-summary")).toContainText("48-Hour Forecast — Glen Allen");
  await expect(page.getByTestId("report-block-header-summary")).not.toContainText("$city");
  await expect(page.getByTestId("report-block-header-content-only")).toHaveCount(0);
  await expect(page.getByTestId("report-block-header-legacy-text")).toHaveCount(0);
  await expect(page.getByText("Supporting context", { exact: true })).toBeVisible();
  await expect(page.getByText("Humidity is elevated", { exact: true })).toBeVisible();
  await expect(page.getByText(/AI-generated.*1 source row.*test-model/)).toBeVisible();
  await expect(page.getByTestId("report-regenerate-narrative-generated-summary")).toBeDisabled();
  await expect(page.getByTestId("report-block-content-only").locator("img")).toHaveAttribute("src", "/favicon.svg");
  await expect(page.getByText("This report has not loaded its data yet.")).toHaveCount(0);

  await expect(page.getByTestId("report-parameters-toggle")).toContainText("Glen Allen");
  await expect(page.getByTestId("report-parameters-toggle")).toHaveAttribute("aria-expanded", "false");
  await page.getByTestId("report-parameters-toggle").click();
  await page.locator(".report-parameters input").fill("Norfolk");
  await expect(page.getByTestId("report-parameters-toggle")).toContainText("Unapplied changes");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByTestId("report-parameters-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("report-parameters-toggle")).toContainText("Norfolk");
  await expect(page.getByTestId("report-block-header-summary")).toContainText("48-Hour Forecast — Norfolk");
  await expect(page.getByText("Location:").locator("..")).toContainText("Norfolk");
});

test("browses the shared report datasets without issuing another query", async ({ page }) => {
  await page.getByTestId("tab-reports").click();
  await page.evaluate(() => {
    const bridge = (window as any).__bridge;
    const queryPrepared = bridge.queryPrepared;
    if (!queryPrepared) throw new Error("Prepared query bridge is not ready");
    (window as any).__datasetBrowserCalls = 0;
    bridge.queryPrepared = async (sql: string, params: unknown[]) => {
      (window as any).__datasetBrowserCalls += 1;
      return queryPrepared(sql, params);
    };
  });
  const now = Date.now();
  const report = {
    schemaVersion: 1,
    id: "dataset-browser-example",
    title: "Dataset browser example",
    createdAt: now,
    updatedAt: now,
    revision: 1,
    requiredSources: [],
    parameters: [{ id: "humidity", key: "humidity", label: "Humidity", type: "number", defaultValue: 68 }],
    datasets: [{ id: "conditions", name: "Current conditions", description: "A shared result", sql: "SELECT $humidity AS humidity, TIMESTAMP '2026-08-19 12:30:00' AS observed_at" }],
    blocks: [
      { id: "humidity-kpi", type: "kpi", datasetId: "conditions", title: "Humidity", valueColumn: "humidity", layout: { x: 0, y: 0, w: 4, h: 2 } },
      { id: "conditions-table", type: "table", datasetId: "conditions", title: "Conditions", layout: { x: 4, y: 0, w: 8, h: 3 } },
    ],
  };
  await page.locator('input[type="file"]').setInputFiles({
    name: "dataset-browser.cupola-report.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(report)),
  });
  await page.getByTestId("reports-run").click();
  await expect(page.getByTestId("report-block-humidity-kpi")).toContainText("68", { timeout: T_NORMAL });
  expect(await page.evaluate(() => (window as any).__datasetBrowserCalls)).toBe(1);

  await page.getByTestId("report-datasets-tab").click();
  await expect(page.getByTestId("report-datasets-view")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Current conditions" })).toBeVisible();
  await expect(page.getByText("1 row · 2 columns")).toBeVisible();
  await expect(page.getByText("Humidity (kpi)")).toBeVisible();
  await expect(page.getByText("Conditions (table)")).toBeVisible();
  await expect(page.getByTestId("report-dataset-sql")).toContainText("SELECT ? AS humidity");
  await expect(page.getByTestId("report-dataset-param-1")).toHaveText("Parameter 1 = 68");
  await expect(page.getByRole("cell", { name: "68", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: /Aug.*2026|2026/ })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__datasetBrowserCalls)).toBe(1);

  await page.getByTestId("report-view-tab").click();
  await expect(page.getByTestId("report-block-humidity-kpi")).toBeVisible();
});

test("keeps the last valid report active when a parameter fails validation", async ({ page }) => {
  await page.getByTestId("tab-reports").click();
  await page.evaluate(() => {
    const bridge = (window as any).__bridge;
    const queryPrepared = bridge.queryPrepared;
    if (!queryPrepared) throw new Error("Prepared query bridge is not ready");
    (window as any).__validatedReportCalls = 0;
    bridge.queryPrepared = async (sql: string, params: unknown[]) => {
      (window as any).__validatedReportCalls += 1;
      return queryPrepared(sql, params);
    };
  });
  const now = Date.now();
  const report = {
    schemaVersion: 1,
    id: "validated-parameters-example",
    title: "Validated parameters",
    createdAt: now,
    updatedAt: now,
    revision: 1,
    requiredSources: [],
    parameters: [{ id: "humidity", key: "humidity", label: "Humidity", type: "number", defaultValue: 50, required: true, validation: { min: 0, max: 100 } }],
    datasets: [{ id: "reading", name: "Reading", sql: "SELECT $humidity AS humidity" }],
    blocks: [{ id: "humidity-kpi", type: "kpi", datasetId: "reading", title: "Humidity", valueColumn: "humidity", layout: { x: 0, y: 0, w: 4, h: 2 } }],
  };
  await page.locator('input[type="file"]').setInputFiles({
    name: "validated.cupola-report.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(report)),
  });
  await page.getByTestId("reports-run").click();
  await expect(page.getByTestId("report-block-humidity-kpi")).toContainText("50", { timeout: T_NORMAL });
  expect(await page.evaluate(() => (window as any).__validatedReportCalls)).toBe(1);

  await page.getByTestId("report-parameters-toggle").click();
  await page.locator('.report-parameters input[type="number"]').fill("101");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByRole("alert")).toContainText("at most 100");
  await expect(page.getByTestId("report-parameters-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("report-parameters-toggle")).toContainText("50");
  await expect(page.getByTestId("report-block-humidity-kpi")).toContainText("50");
  expect(await page.evaluate(() => (window as any).__validatedReportCalls)).toBe(1);

  await page.locator('.report-parameters input[type="number"]').fill("75");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByTestId("report-block-humidity-kpi")).toContainText("75", { timeout: T_NORMAL });
  expect(await page.evaluate(() => (window as any).__validatedReportCalls)).toBe(2);
});

test("visually groups related report boxes into labeled rounded containers", async ({ page }) => {
  await page.getByTestId("tab-reports").click();
  const now = Date.now();
  const report = {
    schemaVersion: 1,
    id: "grouped-cities-example",
    title: "Weather by city",
    createdAt: now,
    updatedAt: now,
    revision: 1,
    requiredSources: [],
    parameters: [],
    datasets: [],
    groups: [
      { id: "glen-allen", title: "Glen Allen", description: "Current conditions", tone: "green", titleSize: "large" },
      { id: "norfolk", title: "Norfolk", description: "Coastal conditions", tone: "blue" },
    ],
    blocks: [
      { id: "glen-kpi", type: "markdown", groupId: "glen-allen", title: "Humidity", markdown: "**68%**", layout: { x: 0, y: 0, w: 4, h: 2 } },
      { id: "glen-trend", type: "markdown", groupId: "glen-allen", title: "Trend", markdown: "Humidity is rising.", layout: { x: 4, y: 0, w: 8, h: 2 } },
      { id: "norfolk-kpi", type: "markdown", groupId: "norfolk", title: "Humidity", markdown: "**74%**", layout: { x: 0, y: 3, w: 4, h: 2 } },
      { id: "norfolk-trend", type: "markdown", groupId: "norfolk", title: "Trend", markdown: "Humidity is steady.", layout: { x: 4, y: 3, w: 8, h: 2 } },
    ],
  };
  await page.locator('input[type="file"]').setInputFiles({
    name: "grouped-cities.cupola-report.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(report)),
  });

  await expect(page.getByTestId("report-group-label-glen-allen")).toContainText("Glen Allen");
  await expect(page.getByTestId("report-group-label-norfolk")).toContainText("Norfolk");
  const bounds = await page.evaluate(() => {
    const rect = (testId: string) => {
      const value = document.querySelector(`[data-testid="${testId}"]`)!.getBoundingClientRect();
      return { left: value.left, top: value.top, right: value.right, bottom: value.bottom };
    };
    return {
      glen: rect("report-group-glen-allen"),
      glenLabel: rect("report-group-label-glen-allen"),
      glenKpi: rect("report-block-glen-kpi"),
      glenTrend: rect("report-block-glen-trend"),
      norfolk: rect("report-group-norfolk"),
      norfolkKpi: rect("report-block-norfolk-kpi"),
    };
  });
  expect(bounds.glen.left).toBeLessThan(bounds.glenKpi.left);
  expect(bounds.glen.right).toBeGreaterThan(bounds.glenTrend.right);
  expect(bounds.glen.top).toBeLessThan(bounds.glenKpi.top);
  expect(bounds.glenLabel.bottom).toBeLessThan(bounds.glenKpi.top);
  expect(bounds.glen.bottom).toBeGreaterThan(bounds.glenKpi.bottom);
  expect(bounds.norfolk.top).toBeLessThan(bounds.norfolkKpi.top);
  expect(bounds.norfolk.top).toBeGreaterThan(bounds.glen.bottom);
  await expect(page.getByTestId("report-group-label-glen-allen").locator("span").first()).toHaveCSS("font-size", "16px");
});

test("applies value-driven KPI backgrounds with visible alert labels", async ({ page }) => {
  await page.getByTestId("tab-reports").click();
  const now = Date.now();
  const report = {
    schemaVersion: 1,
    id: "conditional-kpi-example",
    title: "Conditional KPI example",
    createdAt: now,
    updatedAt: now,
    revision: 1,
    requiredSources: [],
    parameters: [],
    datasets: [{ id: "weather", name: "Weather", sql: "SELECT 68 AS humidity, 82 AS temperature" }],
    groups: [],
    blocks: [{
      id: "humidity",
      type: "kpi",
      datasetId: "weather",
      title: "Humidity",
      valueColumn: "humidity",
      appearance: {
        tone: "success",
        label: "In preferred range",
        rules: [
          { column: "humidity", operator: "greater_than", value: 80, tone: "danger", emphasis: "prominent", label: "Critical humidity" },
          { column: "humidity", operator: "greater_than", value: 65, tone: "warning", emphasis: "prominent", label: "Above preferred range" },
        ],
      },
      layout: { x: 0, y: 0, w: 6, h: 3 },
    }, {
      id: "temperature",
      type: "kpi",
      datasetId: "weather",
      title: "Temperature",
      valueColumn: "temperature",
      appearance: {
        tone: "neutral",
        rules: [{ column: "temperature", operator: "between", value: 65, value2: 85, tone: "success", label: "Comfortable" }],
      },
      layout: { x: 6, y: 0, w: 6, h: 3 },
    }],
  };
  await page.locator('input[type="file"]').setInputFiles({
    name: "conditional-kpis.cupola-report.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(report)),
  });
  await page.getByTestId("reports-run").click();

  await expect(page.getByTestId("report-block-humidity")).toHaveAttribute("data-report-tone", "warning", { timeout: T_NORMAL });
  await expect(page.getByTestId("report-block-humidity")).toHaveAttribute("data-report-emphasis", "prominent");
  await expect(page.getByTestId("report-block-status-humidity")).toHaveText("Above preferred range");
  await expect(page.getByTestId("report-block-temperature")).toHaveAttribute("data-report-tone", "success");
  await expect(page.getByTestId("report-block-status-temperature")).toHaveText("Comfortable");
});

test("shows dataset progress while loading and preserves data while refreshing", async ({ page }) => {
  await page.getByTestId("tab-reports").click();
  await page.evaluate(() => {
    const bridge = (window as any).__bridge;
    const queryPrepared = bridge.queryPrepared;
    if (!queryPrepared) throw new Error("Prepared query bridge is not ready");
    (window as any).__reportQueryCalls = 0;
    bridge.queryPrepared = async (sql: string, params: unknown[]) => {
      (window as any).__reportQueryCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 300));
      return queryPrepared(sql, params);
    };
  });

  const now = Date.now();
  const report = {
    schemaVersion: 1,
    id: "loading-progress-example",
    title: "Loading progress example",
    createdAt: now,
    updatedAt: now,
    revision: 1,
    requiredSources: [],
    parameters: [],
    datasets: [{ id: "shared", name: "Shared metrics", sql: "SELECT 42 AS value" }, { id: "detail", name: "Detail rows", sql: "SELECT 'ready' AS state" }],
    blocks: [{
      id: "shared-kpi",
      type: "kpi",
      datasetId: "shared",
      title: "Shared KPI",
      valueColumn: "value",
      layout: { x: 0, y: 0, w: 4, h: 3 },
    }, {
      id: "shared-table",
      type: "table",
      datasetId: "shared",
      title: "Shared table",
      layout: { x: 4, y: 0, w: 4, h: 3 },
    }, {
      id: "detail-table",
      type: "table",
      datasetId: "detail",
      title: "Detail table",
      layout: { x: 8, y: 0, w: 4, h: 3 },
    }],
  };
  await page.locator('input[type="file"]').setInputFiles({
    name: "loading.cupola-report.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(report)),
  });

  await page.getByTestId("reports-run").click();
  await expect(page.getByTestId("report-run-progress")).toContainText("Loading 0 of 2 datasets");
  await expect(page.getByTestId("report-dataset-loading-shared-kpi")).toContainText("Loading data");
  await expect(page.getByTestId("report-dataset-loading-shared-table")).toContainText("Loading data");
  await expect(page.getByTestId("report-dataset-loading-detail-table")).toContainText("Waiting to load data");
  await expect(page.getByRole("cell", { name: "ready" })).toBeVisible({ timeout: T_NORMAL });
  await expect(page.getByTestId("report-run-progress")).toHaveCount(0);
  await expect(page.getByTestId("report-as-of")).toHaveCount(1);
  await expect(page.locator('[data-testid^="report-block-header-"]').filter({ hasText: "as of" })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__reportQueryCalls)).toBe(2);

  await page.getByTestId("reports-run").click();
  await expect(page.getByTestId("report-run-progress")).toContainText("Refreshing 0 of 2 datasets");
  await expect(page.getByTestId("report-dataset-status-shared-kpi")).toContainText("Refreshing");
  await expect(page.getByTestId("report-dataset-status-detail-table")).toContainText("Refresh queued");
  await expect(page.getByRole("cell", { name: "ready" })).toBeVisible();
  await expect(page.getByTestId("report-run-progress")).toHaveCount(0, { timeout: T_NORMAL });
  expect(await page.evaluate(() => (window as any).__reportQueryCalls)).toBe(4);
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
  await page.getByRole("button", { name: "Reports", exact: true }).click();
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
    }, {
      id: "chart-notes",
      type: "markdown",
      title: "Notes",
      markdown: "The chart and notes should remain side by side when printed.",
      layout: { x: 8, y: 0, w: 4, h: 6 },
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

  const chartBlock = page.getByTestId("report-block-chart-block");
  const chartActions = page.getByTestId("report-block-actions-chart-block");
  const chartHeader = page.getByTestId("report-block-header-chart-block");
  await expect(chartHeader).toContainText("CSV");
  expect(await chartActions.evaluate((element) => element.closest('[data-testid="report-chart-container"]') === null)).toBe(true);
  const actionAndChartBounds = await Promise.all([chartActions.boundingBox(), chart.boundingBox()]);
  expect(actionAndChartBounds[0]!.y + actionAndChartBounds[0]!.height).toBeLessThanOrEqual(actionAndChartBounds[1]!.y + 1);
  await expect.poll(() => chartActions.evaluate((element) => getComputedStyle(element).opacity)).toBe("0");
  await chartBlock.hover();
  await expect.poll(() => chartActions.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");

  const download = page.waitForEvent("download");
  await page.getByTestId("report-download-csv-chart-block").click();
  expect((await download).suggestedFilename()).toBe("Values_by_category.csv");

  await page.emulateMedia({ media: "print" });
  const printedLayout = await page.evaluate(() => {
    const chartBlock = document.querySelector('[data-testid="report-block-chart-block"]') as HTMLElement;
    const notesBlock = document.querySelector('[data-testid="report-block-chart-notes"]') as HTMLElement;
    const chartStyle = getComputedStyle(chartBlock);
    const chartRect = chartBlock.getBoundingClientRect();
    const notesRect = notesBlock.getBoundingClientRect();
    return {
      columnStart: chartStyle.gridColumnStart,
      columnEnd: chartStyle.gridColumnEnd,
      rowStart: chartStyle.gridRowStart,
      sideBySide: chartRect.right <= notesRect.left + 1,
      chartWider: chartRect.width > notesRect.width,
    };
  });
  expect(printedLayout).toEqual({ columnStart: "1", columnEnd: "span 8", rowStart: "1", sideBySide: true, chartWider: true });
  await page.emulateMedia({ media: "screen" });

  await chartBlock.hover();
  await page.getByTestId("report-open-sql-chart-block").click();
  await expect(page.getByTestId("tab-editor")).toHaveAttribute("aria-selected", "true", { timeout: T_NORMAL });
  await expect(page.locator(".cm-content").first()).toContainText("SELECT * FROM (VALUES ('A', 10), ('B', 20))", { timeout: T_NORMAL });
});

test("automatically refreshes a report with its saved cadence", async ({ page }) => {
  await page.getByTestId("tab-reports").click();
  await page.evaluate(() => {
    const nativeSetInterval = window.setInterval.bind(window);
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: any[]) =>
      nativeSetInterval(handler, Math.min(timeout ?? 0, 100), ...args)) as typeof window.setInterval;
  });
  const now = Date.now();
  const report = {
    schemaVersion: 1,
    id: "auto-refresh-example",
    title: "Live conditions",
    refreshIntervalSeconds: 5,
    createdAt: now,
    updatedAt: now,
    revision: 1,
    requiredSources: [],
    parameters: [],
    datasets: [{ id: "clock", name: "Clock", sql: "SELECT current_timestamp AS refreshed_at" }],
    blocks: [{
      id: "clock-table",
      type: "table",
      datasetId: "clock",
      title: "Refresh clock",
      layout: { x: 0, y: 0, w: 12, h: 4 },
    }],
  };
  await page.locator('input[type="file"]').setInputFiles({
    name: "refresh.cupola-report.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(report)),
  });
  await page.getByRole("button", { name: "Report refresh options" }).click();
  await expect(page.getByTestId("report-auto-refresh-5")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await page.getByTestId("reports-run").click();
  const timestamp = page.getByRole("cell").first();
  await expect(timestamp).toBeVisible({ timeout: T_NORMAL });
  const initialValue = await timestamp.textContent();
  await expect.poll(() => timestamp.textContent(), { timeout: T_NORMAL }).not.toBe(initialValue);
});

test("renders semantic Tufte comparison devices with provenance", async ({ page }) => {
  await page.getByTestId("tab-reports").click();
  const now = Date.now();
  const report = {
    schemaVersion: 1,
    id: "tufte-devices-example",
    title: "Regional performance",
    createdAt: now,
    updatedAt: now,
    revision: 1,
    requiredSources: [],
    parameters: [],
    datasets: [{
      id: "trends",
      name: "Regional trends",
      sql: "SELECT * FROM (VALUES ('North', DATE '2026-01-01', 90), ('North', DATE '2026-02-01', 110), ('South', DATE '2026-01-01', 75), ('South', DATE '2026-02-01', 95)) AS t(region, month, actual)",
    }, {
      id: "comparisons",
      name: "Regional comparisons",
      sql: "SELECT * FROM (VALUES ('North', 110, 100, 140, 120, 82, 110, 80, 125), ('South', 95, 105, 135, 115, 90, 95, 85, 120)) AS t(region, actual, target, broad, close, start_value, end_value, low_value, high_value)",
    }],
    blocks: [{
      id: "regional-multiples",
      type: "small_multiples",
      datasetId: "trends",
      title: "Monthly performance by region",
      facetColumn: "region",
      xColumn: "month",
      yColumn: "actual",
      xType: "temporal",
      referenceValue: 100,
      referenceLabel: "Goal",
      caption: "The same y-scale makes regional differences directly comparable.",
      source: "Regional planning model",
      layout: { x: 0, y: 0, w: 12, h: 6 },
    }, {
      id: "regional-bullets",
      type: "bullet",
      datasetId: "comparisons",
      title: "Actual versus target",
      categoryColumn: "region",
      valueColumn: "actual",
      targetColumn: "target",
      rangeColumns: ["broad", "close"],
      layout: { x: 0, y: 6, w: 6, h: 5 },
    }, {
      id: "regional-ranges",
      type: "range_dot",
      datasetId: "comparisons",
      title: "Expected range",
      categoryColumn: "region",
      lowColumn: "low_value",
      highColumn: "high_value",
      valueColumn: "actual",
      layout: { x: 6, y: 6, w: 6, h: 5 },
    }, {
      id: "regional-slopes",
      type: "slopegraph",
      datasetId: "comparisons",
      title: "Period change",
      categoryColumn: "region",
      startColumn: "start_value",
      endColumn: "end_value",
      startLabel: "Previous",
      endLabel: "Current",
      layout: { x: 0, y: 11, w: 12, h: 6 },
    }],
  };
  await page.locator('input[type="file"]').setInputFiles({
    name: "tufte.cupola-report.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(report)),
  });
  await page.getByTestId("reports-run").click();

  const charts = page.getByTestId("report-chart-container");
  await expect(charts).toHaveCount(4, { timeout: T_NORMAL });
  for (let index = 0; index < 4; index++) await expect(charts.nth(index).locator("svg")).toBeVisible({ timeout: T_NORMAL });
  await expect(page.getByTestId("report-note-regional-multiples")).toContainText("Source: Regional planning model");
  await page.getByTestId("report-block-regional-bullets").hover();
  await expect(page.getByTestId("report-download-csv-regional-bullets")).toBeVisible();
  await page.getByTestId("report-block-regional-slopes").hover();
  await expect(page.getByTestId("report-open-sql-regional-slopes")).toBeVisible();
});

test("renders a compact sparkline metric without Vega chart margins", async ({ page }) => {
  await page.getByTestId("tab-reports").click();
  const now = Date.now();
  const report = {
    schemaVersion: 1,
    id: "sparkline-example",
    title: "Weather trend",
    createdAt: now,
    updatedAt: now,
    revision: 1,
    requiredSources: [],
    parameters: [],
    datasets: [{ id: "temperatures", name: "Temperatures", sql: "SELECT * FROM (VALUES ('Mon', 68), ('Tue', 71), ('Wed', 73)) AS t(day, temperature)" }],
    blocks: [{
      id: "temperature-trend",
      type: "sparkline",
      datasetId: "temperatures",
      title: "Temperature",
      valueColumn: "temperature",
      labelColumn: "day",
      color: "#f97316",
      layout: { x: 0, y: 0, w: 3, h: 2 },
    }],
  };
  await page.locator('input[type="file"]').setInputFiles({
    name: "sparkline.cupola-report.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(report)),
  });
  await page.getByTestId("reports-run").click();

  const sparkline = page.getByTestId("report-sparkline");
  await expect(sparkline).toBeVisible({ timeout: T_NORMAL });
  await expect(sparkline.getByText("73", { exact: true })).toBeVisible();
  await expect(sparkline.getByText("Wed", { exact: true })).toBeVisible();
  await expect(sparkline.locator("svg polyline")).toBeVisible();
  await expect(page.getByTestId("report-chart-container")).toHaveCount(0);
  expect(await sparkline.evaluate((element) => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
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

// Regression coverage for the BigNum crash fixed in coerceArrowValue
// (src/lib/duckdb-query.ts): DuckDB HUGEINT/UHUGEINT/DECIMAL columns arrive
// from Arrow as an object-wrapped BigNum (BN.decimal(...)), not a primitive
// bigint. Number(bigNum) *throws* instead of losing precision once the value
// exceeds Number.MAX_SAFE_INTEGER — a real production report crashed a KPI
// block on exactly this (Sentry: "2200620179644536746 is not safe to convert
// to a number"). This runs the real DuckDB-WASM engine end to end (no mocked
// Arrow objects) so it exercises the actual coercion path, not a stand-in.
test("renders KPI and sparkline blocks over oversized HUGEINT/UHUGEINT/DECIMAL values without crashing", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  await page.getByTestId("tab-reports").click();
  const now = Date.now();
  // All four values exceed Number.MAX_SAFE_INTEGER (2^53-1); huge_value
  // reuses the exact value from the Sentry report.
  const report = {
    schemaVersion: 1,
    id: "bignum-example",
    title: "Oversized integer example",
    createdAt: now,
    updatedAt: now,
    revision: 1,
    requiredSources: [],
    parameters: [],
    datasets: [
      {
        id: "bignum_kpi",
        name: "Bignum KPI row",
        sql: "SELECT CAST(2200620179644536746 AS HUGEINT) AS huge_value, CAST(0 AS HUGEINT) AS low_bound, CAST(9223372036854775807 AS UHUGEINT) AS high_bound, CAST(4611686018427387904 AS DECIMAL(38,0)) AS target_value",
      },
      {
        id: "bignum_series",
        name: "Bignum series",
        sql: "SELECT * FROM (VALUES (1, CAST(1000000000000000 AS HUGEINT)), (2, CAST(2200620179644536746 AS HUGEINT)), (3, CAST(9223372036854775807 AS HUGEINT))) AS t(seq, huge_value) ORDER BY seq",
      },
    ],
    blocks: [
      {
        id: "bignum-kpi",
        type: "kpi",
        datasetId: "bignum_kpi",
        title: "Huge value",
        valueColumn: "huge_value",
        format: "text",
        lowColumn: "low_bound",
        highColumn: "high_bound",
        targetColumn: "target_value",
        rangeLabel: "Range",
        layout: { x: 0, y: 0, w: 4, h: 2 },
      },
      {
        id: "bignum-sparkline",
        type: "sparkline",
        datasetId: "bignum_series",
        title: "Huge trend",
        valueColumn: "huge_value",
        labelColumn: "seq",
        layout: { x: 4, y: 0, w: 3, h: 2 },
      },
    ],
  };
  await page.locator('input[type="file"]').setInputFiles({
    name: "bignum.cupola-report.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(report)),
  });
  await page.getByTestId("reports-run").click();

  // format: "text" round-trips the value verbatim through coerceArrowValue's
  // string fallback — this also confirms no precision was silently lost.
  const kpi = page.getByTestId("report-block-bignum-kpi");
  await expect(kpi.getByTestId("report-kpi-value")).toHaveText("2200620179644536746", { timeout: T_NORMAL });
  await expect(kpi.getByTestId("report-kpi-range")).toBeVisible();

  const sparkline = page.getByTestId("report-block-bignum-sparkline");
  await expect(sparkline.getByTestId("report-sparkline")).toBeVisible({ timeout: T_NORMAL });
  await expect(sparkline.locator("svg polyline")).toBeVisible();

  await expect(page.getByText("Something went wrong")).toHaveCount(0);
  expect(errors).toEqual([]);
});
