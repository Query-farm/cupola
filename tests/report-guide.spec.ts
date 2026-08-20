import { expect, test } from "@playwright/test";
import { APP_ORIGIN, BASE, T_NORMAL, T_SHELL_BOOT, waitForShellBridge } from "./helpers";

test("shows global and report-level readiness while the local engine starts", async ({ page }) => {
  test.setTimeout(90_000);
  let releaseEngine!: () => void;
  const engineGate = new Promise<void>((resolve) => { releaseEngine = resolve; });
  await page.route("**/haybarn/duckdb-*.wasm", async (route) => {
    await engineGate;
    await route.continue();
  });

  await page.goto(`${APP_ORIGIN}${BASE}report-guide/`);
  const ribbon = page.getByTestId("engine-status-ribbon");
  await expect(ribbon).toBeVisible({ timeout: T_NORMAL });
  await expect(ribbon).toContainText("Starting local data engine");
  await expect(page.getByTestId("report-engine-waiting")).toContainText("This report will run automatically");
  await expect(page.getByTestId("reports-run")).toBeDisabled();

  releaseEngine();
  await page.getByTestId("report-block-showcase-kpi").waitFor({ state: "visible", timeout: T_SHELL_BOOT });
  await expect(ribbon).toHaveCount(0, { timeout: T_SHELL_BOOT });
  await expect(page.getByTestId("report-engine-waiting")).toHaveCount(0);
  await expect(page.getByTestId("reports-run")).toBeEnabled();
});

test("report guide is a runnable in-product gallery backed by canned local data", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(`${APP_ORIGIN}${BASE}report-guide/`);

  await expect(page.getByTestId("tab-reports")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Local report examples", { exact: true })).toBeVisible();
  await expect(page.locator(".report-authoring-control input").first()).toHaveValue("Cupola report block gallery", { timeout: T_SHELL_BOOT });
  await expect(page.getByText(/canned data queried locally/i)).toBeVisible();
  await expect(page.getByTestId("report-parameters-toggle")).toContainText("Glen Allen, Virginia");
  await expect(page.getByRole("button", { name: "Edit with AI" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save report draft" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeVisible();
  const reportActionHeights = await Promise.all([
    page.getByTestId("reports-run"),
    page.getByRole("button", { name: "Report refresh options" }),
    page.getByTestId("report-more-menu"),
  ].map((control) => control.evaluate((element) => element.getBoundingClientRect().height)));
  expect(new Set(reportActionHeights).size).toBe(1);
  await page.getByRole("button", { name: "Report refresh options" }).click();
  await expect(page.getByTestId("report-auto-refresh-0")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "More report actions" }).click();
  await expect(page.getByRole("button", { name: "Print / Save as PDF" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download report definition" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit report JSON" })).toBeVisible();
  await page.keyboard.press("Escape");

  for (const id of [
    "showcase-markdown",
    "showcase-kpi",
    "showcase-sparkline",
    "showcase-ai",
    "showcase-small-multiples",
    "showcase-bullet",
    "showcase-range-dot",
    "showcase-slopegraph",
    "showcase-chart",
    "showcase-map",
    "showcase-table",
    "showcase-perspective",
  ]) {
    await expect(page.getByTestId(`report-block-${id}`)).toBeAttached();
  }

  await expect(page.getByTestId("report-block-showcase-kpi")).toContainText("68", { timeout: T_SHELL_BOOT });
  await expect(page.getByTestId("report-block-showcase-kpi").getByTestId("report-kpi-range")).toContainText("Selected comfort range");
  await expect(page.getByTestId("report-block-showcase-kpi").getByTestId("report-kpi-range-value")).toHaveAttribute("data-outside", "high");
  await expect(page.getByTestId("report-block-showcase-sparkline").getByTestId("report-sparkline-value")).toHaveText("68");
  await expect(page.getByTestId("report-block-showcase-table")).toContainText("2026-08-20 07:00:00", { timeout: T_SHELL_BOOT });
  await expect(page.getByTestId("reports-run")).toHaveText(/Run report/, { timeout: T_SHELL_BOOT });
  await expect(page.getByTestId("report-block-showcase-chart").locator("svg")).toBeAttached();
  await expect(page.getByTestId("report-block-showcase-small-multiples").locator("svg")).toBeAttached();
  const smallMultipleLabels = await page.getByTestId("report-block-showcase-small-multiples").locator("svg text").allTextContents();
  expect(smallMultipleLabels).not.toContain("0");
  expect(smallMultipleLabels).toContain("65% reference");
  const bulletLabels = await page.getByTestId("report-block-showcase-bullet").locator("svg text").allTextContents();
  expect(bulletLabels).toContain("68");
  const rangeLabels = await page.getByTestId("report-block-showcase-range-dot").locator("svg text").allTextContents();
  expect(rangeLabels).toEqual(expect.arrayContaining(["67", "88", "82"]));
  await expect(page.getByTestId("report-block-showcase-sparkline").getByTestId("report-sparkline-split")).toHaveAttribute("aria-label", "Now · forecast begins");
  await expect(page.getByTestId("report-block-showcase-map").locator(".leaflet-container")).toBeAttached();
  await expect(page.getByTestId("report-block-showcase-map").locator("img.leaflet-tile").first()).toBeVisible({ timeout: T_SHELL_BOOT });
  await expect(page.getByTestId("report-block-showcase-map").locator("img.leaflet-tile").first()).toHaveAttribute("crossorigin", "");
  await expect(page.getByTestId("report-block-showcase-perspective").locator("perspective-viewer")).toBeAttached({ timeout: T_SHELL_BOOT });
  await expect(page.getByText("This page is a real report")).toBeAttached();
  await expect(page.getByText("AI-generated", { exact: false })).toBeAttached();
  await expect(page.getByText(/Run report to load data/i)).toHaveCount(0);

  await page.setViewportSize({ width: 360, height: 800 });
  const authorToolbarWidth = await page.locator(".report-authoring-control").first().evaluate((toolbar) => ({
    client: toolbar.clientWidth,
    scroll: toolbar.scrollWidth,
  }));
  expect(authorToolbarWidth.scroll).toBeLessThanOrEqual(authorToolbarWidth.client + 1);
  await page.setViewportSize({ width: 1280, height: 720 });

  await expect(page.getByTestId("report-block-showcase-kpi")).toHaveAttribute("data-report-tone", "warning");
  await page.getByTestId("report-parameters-toggle").click();
  await page.locator('input[type="number"]').fill("70");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByTestId("report-block-showcase-kpi")).toHaveAttribute("data-report-tone", "success", { timeout: T_SHELL_BOOT });

  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByTestId("reports-workspace")).toHaveAttribute("data-report-mode", "reader");
  await expect(page.getByRole("heading", { name: "Cupola report block gallery" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit with AI" })).toHaveCount(0);
  await expect(page.locator(".react-resizable-handle").first()).toBeHidden();
  await expect(page.getByTestId("report-block-header-showcase-kpi")).toHaveCSS("cursor", "default");
  await expect(page.getByTestId("report-parameters-toggle")).toContainText("Glen Allen, Virginia");
  const readerCanvasWidth = await page.locator(".report-canvas").evaluate((canvas) => ({
    client: canvas.clientWidth,
    scroll: canvas.scrollWidth,
  }));
  expect(readerCanvasWidth.scroll).toBeLessThanOrEqual(readerCanvasWidth.client + 1);

  await page.getByRole("button", { name: "Edit report" }).click();
  await page.locator('input[value="Cupola report block gallery"]').fill("Unpublished gallery draft");
  await page.getByRole("button", { name: "Save report draft" }).click();
  await page.getByRole("button", { name: "Published", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Cupola report block gallery" })).toBeVisible();
  await expect(page.getByText("Unpublished gallery draft")).toHaveCount(0);
});

test("authors can edit, add, duplicate, and delete report blocks directly", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(`${APP_ORIGIN}${BASE}report-guide/`);
  const kpi = page.getByTestId("report-block-showcase-kpi");
  await expect(kpi).toContainText("KPI · Humidity (%)", { timeout: T_SHELL_BOOT });

  await kpi.click();
  await page.getByRole("button", { name: "Edit KPI · Humidity (%)" }).click();
  const editor = page.getByTestId("report-block-editor");
  await expect(editor).toBeVisible();
  await editor.getByLabel("Title").fill("Humidity now");
  await expect(kpi).toContainText("Humidity now");
  page.once("dialog", (dialog) => dialog.accept());
  await editor.getByRole("button", { name: "Cancel" }).click();
  await expect(kpi).toContainText("KPI · Humidity (%)");

  await page.getByRole("button", { name: "Edit KPI · Humidity (%)" }).click();
  await editor.getByLabel("Title").fill("Humidity now");
  await editor.getByTestId("report-block-apply").click();
  await expect(kpi).toContainText("Humidity now");

  await kpi.click();
  await page.getByRole("button", { name: "Duplicate Humidity now" }).click();
  const copied = page.getByText("Copy of Humidity now", { exact: true });
  await expect(copied).toBeVisible();
  await page.locator('[data-testid^="report-block-"]').filter({ hasText: "Copy of Humidity now" }).first().click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete Copy of Humidity now" }).click();
  await expect(copied).toHaveCount(0);

  await page.getByTestId("report-add-block").click();
  await page.getByTestId("report-add-markdown").click();
  await page.getByTestId("report-markdown-editor").fill("## Directly authored\n\nSelected city: **$city_label**");
  await page.getByTestId("report-block-apply").click();
  await expect(page.getByText("Directly authored", { exact: true })).toBeVisible();
  await expect(page.getByText(/Selected city: Glen Allen, Virginia/)).toBeVisible();
});

test("authors can validate and apply report dataset SQL edits", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(`${APP_ORIGIN}${BASE}report-guide/`);
  await page.getByTestId("report-block-showcase-kpi").waitFor({ state: "visible", timeout: T_SHELL_BOOT });
  await expect(page.getByTestId("reports-run")).toHaveText(/Run report/, { timeout: T_SHELL_BOOT });
  await page.getByTestId("report-datasets-tab").click();
  await page.getByTestId("report-dataset-item-showcase-current").click();
  await page.getByTestId("report-edit-dataset").click();
  const sql = page.getByTestId("report-dataset-sql-editor");
  await expect(sql).toBeVisible();
  await sql.fill(`${await sql.inputValue()}\n-- directly edited`);
  const testQuery = page.getByRole("button", { name: "Test query" });
  await expect(testQuery).toBeEnabled({ timeout: T_SHELL_BOOT });
  await testQuery.click();
  await expect(page.getByRole("status")).toContainText("successfully", { timeout: T_SHELL_BOOT });
  await page.getByTestId("report-apply-dataset").click();
  await expect(page.getByTestId("report-dataset-sql")).toContainText("-- directly edited", { timeout: T_SHELL_BOOT });
});

test("infers dataset dependencies and reuses a refresh-scoped materialization", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(`${APP_ORIGIN}${BASE}report-guide/`);
  await waitForShellBridge(page);
  const now = Date.now();
  const report = {
    schemaVersion: 1,
    id: "dataset-dependency-example",
    title: "Dataset dependency example",
    createdAt: now,
    updatedAt: now,
    revision: 1,
    requiredSources: [],
    parameters: [],
    datasets: [
      { id: "weather_base", name: "Weather source", sql: "SELECT 10 AS temperature, 60 AS humidity" },
      { id: "weather_summary", name: "Weather summary", sql: "SELECT temperature * 2 AS score, humidity FROM weather_base" },
    ],
    blocks: [{ id: "summary-table", type: "table", datasetId: "weather_summary", title: "Summary", layout: { x: 0, y: 0, w: 12, h: 3 } }],
  };
  await page.getByRole("button", { name: "More report actions" }).click();
  await page.getByRole("button", { name: "Edit report JSON" }).click();
  await page.locator("textarea.font-mono").fill(JSON.stringify(report));
  await page.getByRole("button", { name: "Preview source" }).click();

  await page.getByTestId("reports-run").click();
  await expect(page.getByRole("cell", { name: "20", exact: true })).toBeVisible({ timeout: T_SHELL_BOOT });
  await page.getByTestId("report-datasets-tab").click();
  await page.getByTestId("report-dataset-item-weather_base").click();
  await expect(page.getByText("Shared this refresh")).toBeVisible();
  await expect(page.getByText("Feeds").locator("..")).toContainText("weather_summary");
  await page.getByTestId("report-dataset-item-weather_summary").click();
  await expect(page.getByText("Reads from").locator("..")).toContainText("weather_base");
  await page.getByTestId("report-dataset-profile-tab").click();
  await expect(page.getByTestId("report-dataset-profile")).toContainText("Refresh profile");
  await expect(page.getByTestId("report-dataset-profile-table").getByRole("row", { name: /Weather source/ })).toContainText(/ms|s/);
  await expect(page.getByTestId("report-dataset-dependency-graph")).toBeVisible();
  await expect(page.getByTestId("report-dataset-node-weather_base")).toBeVisible();
  await expect(page.getByTestId("report-dataset-node-weather_summary")).toBeVisible();
  await page.getByTestId("report-dataset-node-weather_base").click();
  await expect(page.getByTestId("report-dataset-details-tab")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Weather source" })).toBeVisible();
});

test("pauses a refresh after a rate limit and preserves dependent block data", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(`${APP_ORIGIN}${BASE}report-guide/`);
  await page.getByTestId("report-block-showcase-kpi").waitFor({ state: "visible", timeout: T_SHELL_BOOT });
  await waitForShellBridge(page);
  await page.evaluate(() => {
    const bridge = (window as any).__bridge;
    const queryPrepared = bridge.queryPrepared;
    if (!queryPrepared) throw new Error("Prepared query bridge is not ready");
    (window as any).__rateLimitReportCalls = 0;
    (window as any).__rateLimitReportFail = false;
    bridge.queryPrepared = async (sql: string, params: unknown[]) => {
      (window as any).__rateLimitReportCalls += 1;
      if ((window as any).__rateLimitReportFail) return {
        ok: false,
        error: "Invalid Input Error: VGI Worker Exception: OpenMeteoError: Open-Meteo /v1/climate: HTTP 429: Minutely API request limit exceeded. Please try again in one minute. at omGet (cf.js:20923:11) at async handler (cf.js:14140:20)",
      };
      return queryPrepared(sql, params);
    };
  });
  await page.getByRole("button", { name: "Reports", exact: true }).click();
  const now = Date.now();
  const report = {
    schemaVersion: 1,
    id: "rate-limit-example",
    title: "Rate-limit example",
    createdAt: now,
    updatedAt: now,
    revision: 1,
    requiredSources: [],
    parameters: [],
    datasets: [
      { id: "climate", name: "Climate normals", sql: "SELECT 11 AS value" },
      { id: "forecast", name: "Forecast", sql: "SELECT 22 AS value" },
    ],
    blocks: [
      { id: "climate-kpi", type: "kpi", datasetId: "climate", title: "Climate", valueColumn: "value", layout: { x: 0, y: 0, w: 6, h: 2 } },
      { id: "forecast-kpi", type: "kpi", datasetId: "forecast", title: "Forecast", valueColumn: "value", layout: { x: 6, y: 0, w: 6, h: 2 } },
    ],
  };
  await page.locator('input[type="file"]').setInputFiles({
    name: "rate-limit.cupola-report.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(report)),
  });
  await page.getByTestId("reports-run").click();
  await expect(page.getByTestId("report-block-climate-kpi")).toContainText("11", { timeout: T_NORMAL });
  await expect(page.getByTestId("report-block-forecast-kpi")).toContainText("22");
  expect(await page.evaluate(() => (window as any).__rateLimitReportCalls)).toBe(2);

  await page.evaluate(() => { (window as any).__rateLimitReportFail = true; });
  await page.getByTestId("reports-run").click();
  await expect(page.getByTestId("report-run-failure")).toContainText("Data refresh paused");
  await expect(page.getByTestId("report-run-failure")).toContainText("Open-Meteo is temporarily limiting requests");
  await expect(page.getByTestId("report-run-failure")).toContainText("1 remaining dataset was not requested");
  await expect(page.getByTestId("report-run-failure")).not.toContainText("Report validation failed");
  await expect(page.getByTestId("report-dataset-status-climate-kpi")).toContainText("Refresh delayed · showing earlier data");
  await expect(page.getByTestId("report-dataset-status-forecast-kpi")).toContainText("Refresh blocked · showing earlier data");
  await expect(page.getByTestId("report-block-climate-kpi")).toContainText("11");
  await expect(page.getByTestId("report-block-forecast-kpi")).toContainText("22");
  expect(await page.evaluate(() => (window as any).__rateLimitReportCalls)).toBe(3);
  await expect(page.getByText("omGet", { exact: false })).toHaveCount(0);
});
