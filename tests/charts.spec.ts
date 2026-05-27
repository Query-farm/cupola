/**
 * AskAIChat → Vega-Lite chart block.
 *
 * The agent loop / Claude API are not exercised here — instead the test hook
 * `window.__cupolaChartTest.pushChart` (set up by AskAIChat) lets us inject
 * a chart block directly. The hook runs the same SQL/cache/insert path
 * the render_chart tool dispatcher uses, so this covers the end-to-end
 * rendering, refresh, maximize, and download UI without needing an API key
 * or mocking SSE.
 *
 * Each test creates its own memory-table input data so it doesn't depend on
 * the connected VGI catalog's schema beyond what gotoApp() requires.
 */
import { test, expect, type Page } from "@playwright/test";
import { gotoApp, openShell, waitForShellBridge, T_FAST, T_NORMAL, T_SHELL_BOOT } from "./helpers";

test.beforeEach(async ({ page }) => {
  await gotoApp(page);
  await waitForShellBridge(page);
  await openShell(page);
  await openAskAITab(page);
});

/** Click the "Ask AI" tab in the shell panel and wait for the chart hook
 *  to be exposed (it's only set up inside AskAIChat's useEffect on mount). */
async function openAskAITab(page: Page) {
  // Tabs: shell / askai / preview / perspective / map / queries
  await page.getByRole("tab", { name: /Ask AI/ }).click();
  await page.waitForFunction(
    () => typeof (window as any).__cupolaChartTest?.pushChart === "function",
    null,
    { timeout: T_NORMAL },
  );
}

/** Create a memory table the tests can chart against, and return an SQL
 *  expression that reads it. */
async function seedTestTable(page: Page, name: string = "chart_test") {
  await page.evaluate(async (n) => {
    const bridge = (window as any).__bridge;
    await bridge.query(`DROP TABLE IF EXISTS memory.main.${n}`);
    await bridge.query(`CREATE TABLE memory.main.${n} AS
      SELECT * FROM (VALUES
        ('apples', 12, CAST(1 AS BIGINT)),
        ('bananas', 7, CAST(2 AS BIGINT)),
        ('cherries', 19, CAST(3 AS BIGINT)),
        ('dates', 4, CAST(4 AS BIGINT)),
        ('elderberries', 11, CAST(5 AS BIGINT))
      ) t(fruit, count, big_id)`);
  }, name);
  return `SELECT * FROM memory.main.${name}`;
}

async function pushChart(
  page: Page,
  args: { sql: string; spec: Record<string, any>; title?: string },
) {
  return page.evaluate(
    (a) => (window as any).__cupolaChartTest.pushChart(a),
    args,
  );
}

test.describe("Vega chart block", () => {
  test("renders an SVG that fills the container width", async ({ page }) => {
    const sql = await seedTestTable(page);
    await pushChart(page, {
      sql,
      spec: {
        mark: "bar",
        encoding: {
          x: { field: "fruit", type: "nominal" },
          y: { field: "count", type: "quantitative" },
        },
      },
      title: "Fruit counts",
    });

    const block = page.getByTestId("vega-chart-block");
    await expect(block).toBeVisible({ timeout: T_NORMAL });

    // Title shown in the toolbar.
    await expect(block).toContainText("Fruit counts");

    // SVG renders inside the chart container — NOT the toolbar icons which
    // are also <svg> elements. Scope to the testId'd container.
    const chartContainer = page.getByTestId("vega-chart-container");
    const svg = chartContainer.locator("svg").first();
    await expect(svg).toBeVisible({ timeout: T_NORMAL });

    // Width check: container width ≈ chat scroll-area width. With the
    // measured-width approach in chart-embed, the SVG width should be
    // within a few pixels of the container's content width.
    const containerWidth = await chartContainer.evaluate((el) => el.clientWidth);
    const svgWidth = await svg.evaluate((el) => (el as SVGSVGElement).getBoundingClientRect().width);
    // SVG should be at least 60% of the container (catches the old 200px
    // default which was the original "narrow" regression).
    expect(svgWidth).toBeGreaterThan(containerWidth * 0.6);
  });

  test("BIGINT columns don't crash the chart", async ({ page }) => {
    const sql = await seedTestTable(page);
    // Encode the BIGINT column on x. Without sanitizeRowsForVega this would
    // throw "Conversion from BigInt to number is not allowed" — that's the
    // regression we're locking in.
    await pushChart(page, {
      sql,
      spec: {
        mark: "line",
        encoding: {
          x: { field: "big_id", type: "quantitative" },
          y: { field: "count", type: "quantitative" },
        },
      },
      title: "By big_id",
    });
    const chartContainer = page.getByTestId("vega-chart-container");
    await expect(chartContainer.locator("svg").first()).toBeVisible({ timeout: T_NORMAL });
    // If a Vega exception had fired during embed, no SVG would be in the
    // container. The visibility check above is the assertion.
  });

  test("download menu lists PNG and SVG options", async ({ page }) => {
    const sql = await seedTestTable(page);
    await pushChart(page, {
      sql,
      spec: { mark: "bar", encoding: { x: { field: "fruit" }, y: { field: "count" } } },
    });

    const block = page.getByTestId("vega-chart-block");
    await expect(block).toBeVisible();

    await page.getByTestId("chart-download").click();

    await expect(page.getByTestId("chart-download-png")).toBeVisible({ timeout: T_FAST });
    await expect(page.getByTestId("chart-download-svg")).toBeVisible({ timeout: T_FAST });
  });

  test("SVG download triggers a file download with svg content", async ({ page }) => {
    const sql = await seedTestTable(page);
    await pushChart(page, {
      sql,
      spec: { mark: "bar", encoding: { x: { field: "fruit" }, y: { field: "count" } } },
      title: "SVG export test",
    });
    await expect(page.getByTestId("vega-chart-container").locator("svg").first()).toBeVisible({ timeout: T_NORMAL });

    await page.getByTestId("chart-download").click();
    const dlPromise = page.waitForEvent("download", { timeout: T_NORMAL });
    await page.getByTestId("chart-download-svg").click();
    const download = await dlPromise;
    expect(download.suggestedFilename()).toMatch(/\.svg$/);
  });

  test("maximize opens dialog with full-size chart", async ({ page }) => {
    const sql = await seedTestTable(page);
    await pushChart(page, {
      sql,
      spec: { mark: "bar", encoding: { x: { field: "fruit" }, y: { field: "count" } } },
      title: "Maximize test",
    });

    await page.getByTestId("chart-maximize").click();

    const dialog = page.getByTestId("vega-chart-maximize-dialog");
    await expect(dialog).toBeVisible({ timeout: T_NORMAL });
    // The chart container holds Vega's SVG. Toolbar icons in the header are
    // also <svg> elements; scope to the testId'd chart container only.
    const dialogContainer = page.getByTestId("vega-chart-maximize-container");
    await expect(dialogContainer).toBeAttached({ timeout: T_NORMAL });
    const dialogSvg = dialogContainer.locator("svg").first();
    await expect(dialogSvg).toBeVisible({ timeout: T_NORMAL });

    const containerWidth = await dialogContainer.evaluate((el) => el.clientWidth);
    const dialogSvgWidth = await dialogSvg.evaluate((el) => (el as SVGSVGElement).getBoundingClientRect().width);
    // Dialog chart should fill the container.
    expect(dialogSvgWidth).toBeGreaterThan(containerWidth * 0.6);
    expect(containerWidth).toBeGreaterThan(600);

    // Esc closes the dialog.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden({ timeout: T_NORMAL });
  });

  test("refresh button updates fetchedAt and re-runs SQL", async ({ page }) => {
    const sql = await seedTestTable(page);
    await pushChart(page, {
      sql,
      spec: { mark: "bar", encoding: { x: { field: "fruit" }, y: { field: "count" } } },
    });
    const block = page.getByTestId("vega-chart-block");
    await expect(page.getByTestId("vega-chart-container").locator("svg").first()).toBeVisible({ timeout: T_NORMAL });

    // Footer initially says "just now" or "1 min ago" — capture before.
    // Mutate the table so refresh actually produces a different chart.
    await page.evaluate(async () => {
      const bridge = (window as any).__bridge;
      await bridge.query(
        `INSERT INTO memory.main.chart_test VALUES ('figs', 99, CAST(6 AS BIGINT))`,
      );
    });

    await page.getByTestId("chart-refresh").click();
    // After refresh, the row count in the footer should reflect the new row.
    await expect(block).toContainText("6 rows", { timeout: T_NORMAL });
  });

  test("spec with data.url is rejected by validateChartSpec", async ({ page }) => {
    const sql = await seedTestTable(page);
    // pushChart calls validateChartSpec internally and throws; we expect the
    // promise to reject.
    const result = await page.evaluate(async (s) => {
      try {
        await (window as any).__cupolaChartTest.pushChart({
          sql: s,
          spec: { mark: "bar", data: { url: "https://evil.example.com/x.json" } },
        });
        return { ok: true };
      } catch (e: any) {
        return { ok: false, msg: String(e?.message ?? e) };
      }
    }, sql);
    expect(result.ok).toBe(false);
    expect(result.msg).toMatch(/url/i);
  });
});
