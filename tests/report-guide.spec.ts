import { expect, test } from "@playwright/test";
import { APP_ORIGIN, BASE, T_NORMAL, T_SHELL_BOOT, waitForShellBridge } from "./helpers";

test("report guide is a runnable in-product gallery backed by canned local data", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(`${APP_ORIGIN}${BASE}report-guide/`);

  await expect(page.getByTestId("tab-reports")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Local report examples", { exact: true })).toBeVisible();
  await expect(page.locator(".report-authoring-control input").first()).toHaveValue("Cupola report block gallery", { timeout: T_SHELL_BOOT });
  await expect(page.getByText(/canned data queried locally/i)).toBeVisible();
  await expect(page.getByTestId("report-parameters-toggle")).toContainText("Glen Allen, Virginia");

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
  await expect(page.getByTestId("report-block-showcase-table")).toContainText("2026-08-20 07:00:00", { timeout: T_SHELL_BOOT });
  await expect(page.getByTestId("reports-run")).toHaveText(/Run report/, { timeout: T_SHELL_BOOT });
  await expect(page.getByTestId("report-block-showcase-chart").locator("svg")).toBeAttached();
  await expect(page.getByTestId("report-block-showcase-small-multiples").locator("svg")).toBeAttached();
  const smallMultipleLabels = await page.getByTestId("report-block-showcase-small-multiples").locator("svg text").allTextContents();
  expect(smallMultipleLabels).not.toContain("0");
  expect(smallMultipleLabels).toContain("65% reference");
  await expect(page.getByTestId("report-block-showcase-sparkline").getByTestId("report-sparkline-split")).toHaveAttribute("aria-label", "Now · forecast begins");
  await expect(page.getByTestId("report-block-showcase-map").locator(".leaflet-container")).toBeAttached();
  await expect(page.getByTestId("report-block-showcase-map").locator("img.leaflet-tile").first()).toBeVisible({ timeout: T_SHELL_BOOT });
  await expect(page.getByTestId("report-block-showcase-map").locator("img.leaflet-tile").first()).toHaveAttribute("crossorigin", "");
  await expect(page.getByTestId("report-block-showcase-perspective").locator("perspective-viewer")).toBeAttached({ timeout: T_SHELL_BOOT });
  await expect(page.getByText("This page is a real report")).toBeAttached();
  await expect(page.getByText("AI-generated", { exact: false })).toBeAttached();
  await expect(page.getByText(/Run report to load data/i)).toHaveCount(0);

  await expect(page.getByTestId("report-block-showcase-kpi")).toHaveAttribute("data-report-tone", "warning");
  await page.getByTestId("report-parameters-toggle").click();
  await page.locator('input[type="number"]').fill("70");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByTestId("report-block-showcase-kpi")).toHaveAttribute("data-report-tone", "success", { timeout: T_SHELL_BOOT });

  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByTestId("reports-workspace")).toHaveAttribute("data-report-mode", "reader");
  await expect(page.getByRole("heading", { name: "Cupola report block gallery" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Agent" })).toHaveCount(0);
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
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.getByRole("button", { name: "View published" }).click();
  await expect(page.getByRole("heading", { name: "Cupola report block gallery" })).toBeVisible();
  await expect(page.getByText("Unpublished gallery draft")).toHaveCount(0);
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
  await page.getByRole("button", { name: "Library" }).click();
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
