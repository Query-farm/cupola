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

    // Save a screenshot for manual review.
    await page.getByTestId("vega-chart-block").screenshot({ path: "test-results/chart-inline-default.png" });
  });

  test("LLM-specified width does NOT shrink the chart (must fill container)", async ({ page }) => {
    // Regression: the model frequently emits `width: 500` or `width: 600`
    // in its specs. The chat container is much wider than that; respecting
    // the model's width leaves the chart looking tiny against empty space.
    // chart-embed must force the container-measured width.
    const sql = await seedTestTable(page);
    await pushChart(page, {
      sql,
      // Deliberately emit a width the chart MUST ignore.
      spec: {
        width: 200,
        mark: "bar",
        encoding: { x: { field: "fruit" }, y: { field: "count" } },
      },
      title: "Width override",
    });

    const chartContainer = page.getByTestId("vega-chart-container");
    await expect(chartContainer.locator("svg").first()).toBeVisible({ timeout: T_NORMAL });

    const { containerWidth, svgWidth } = await chartContainer.evaluate((el) => ({
      containerWidth: el.clientWidth,
      svgWidth: (el.querySelector("svg") as SVGSVGElement).getBoundingClientRect().width,
    }));
    // The chart should fill the container, NOT honor the 200px spec width.
    expect(svgWidth).toBeGreaterThan(containerWidth * 0.6);
    expect(svgWidth).toBeGreaterThan(400);
  });

  test("chart SVG fits within container — no horizontal clipping", async ({ page }) => {
    // Regression for user-reported bug: chart was being clipped on the right
    // side. Check that the SVG's right edge is inside the container's right
    // edge (no overflow).
    const sql = await seedTestTable(page);
    await pushChart(page, {
      sql,
      spec: {
        mark: "circle",
        encoding: {
          x: { field: "big_id", type: "quantitative" },
          y: { field: "count", type: "quantitative" },
          // Add a color legend on the right — this is what was pushing
          // content off-screen in the reported bug.
          color: { field: "fruit", type: "nominal" },
          size: { field: "count", type: "quantitative" },
        },
      },
      title: "Clipping check",
    });

    const chartContainer = page.getByTestId("vega-chart-container");
    const svg = chartContainer.locator("svg").first();
    await expect(svg).toBeVisible({ timeout: T_NORMAL });

    const overflow = await chartContainer.evaluate((el) => {
      const svg = el.querySelector("svg") as SVGSVGElement;
      const cRect = el.getBoundingClientRect();
      const sRect = svg.getBoundingClientRect();
      return {
        // Positive = SVG extends past container right edge (clipping).
        rightOverflow: Math.round(sRect.right - cRect.right),
        bottomOverflow: Math.round(sRect.bottom - cRect.bottom),
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      };
    });
    // SVG must not overflow the container horizontally. ~10px slack
    // accounts for subpixel rendering and the small buffer chart-embed
    // subtracts from clientWidth.
    expect(overflow.rightOverflow).toBeLessThanOrEqual(10);
    // overflow-x-auto on the container means scrollWidth can exceed
    // clientWidth IF the chart genuinely needs more space (e.g. categorical
    // x with hundreds of bars). For this 5-row chart that should not
    // happen — locks in the regression.
    expect(overflow.scrollWidth - overflow.clientWidth).toBeLessThanOrEqual(10);

    await page.getByTestId("vega-chart-block").screenshot({ path: "test-results/chart-with-legend.png" });
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

    const sizes = await dialogContainer.evaluate((el) => {
      const svg = el.querySelector("svg") as SVGSVGElement;
      return {
        containerWidth: el.clientWidth,
        containerHeight: el.clientHeight,
        svgWidth: svg.getBoundingClientRect().width,
        svgHeight: svg.getBoundingClientRect().height,
      };
    });
    // Maximize dialog should be wide.
    expect(sizes.containerWidth).toBeGreaterThan(600);
    expect(sizes.containerHeight).toBeGreaterThan(400);
    // Chart should fill the dialog: at least 60% of both width AND height.
    // The reported bug was a small chart in a big empty dialog — the LLM
    // emits height ~250 which left 70%+ of the dialog blank. forceHeight
    // in MaximizedChartDialog should override.
    expect(sizes.svgWidth).toBeGreaterThan(sizes.containerWidth * 0.6);
    expect(sizes.svgHeight).toBeGreaterThan(sizes.containerHeight * 0.6);

    // Screenshot for visual regression review.
    await dialog.screenshot({ path: "test-results/chart-maximized.png" });

    // Esc closes the dialog.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden({ timeout: T_NORMAL });
  });

  test("maximize: LLM-specified small height does NOT leave empty space", async ({ page }) => {
    // Regression: when the LLM emits height: 200, the maximize dialog
    // showed a 200px-tall chart inside an 800px-tall dialog. forceHeight
    // must win in the dialog.
    const sql = await seedTestTable(page);
    await pushChart(page, {
      sql,
      spec: {
        // Small width AND height — both should be ignored in maximize.
        width: 300,
        height: 200,
        mark: "bar",
        encoding: { x: { field: "fruit" }, y: { field: "count" } },
      },
      title: "Override test",
    });

    await page.getByTestId("chart-maximize").click();
    const dialogContainer = page.getByTestId("vega-chart-maximize-container");
    await expect(dialogContainer.locator("svg").first()).toBeVisible({ timeout: T_NORMAL });

    const sizes = await dialogContainer.evaluate((el) => {
      const svg = el.querySelector("svg") as SVGSVGElement;
      return {
        containerHeight: el.clientHeight,
        svgHeight: svg.getBoundingClientRect().height,
      };
    });
    // Chart must fill majority of available height — NOT the LLM's 200px.
    expect(sizes.svgHeight).toBeGreaterThan(sizes.containerHeight * 0.6);
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

  test("Vega-Lite warnings are surfaced to user and agent", async ({ page }) => {
    // The LLM frequently emits specs that compile with warnings but still
    // render — e.g. log scale over zero-containing data, incompatible
    // shape encoding on a circle mark. Without surfacing these, the model
    // keeps producing the same broken charts because it can't see Vega's
    // console.warn output. The render_chart dispatcher compiles the spec
    // and forwards warnings on both the block (for the user) and the
    // tool_result (for the agent).
    const sql = await seedTestTable(page);
    // Shape encoding on a `circle` mark — circles don't accept shape, so
    // vega-lite emits a warning and drops the channel. Deterministic and
    // exactly the warning that prompted this work (see user report).
    const result = await page.evaluate(async (s) => {
      return (window as any).__cupolaChartTest.pushChart({
        sql: s,
        spec: {
          mark: "circle",
          encoding: {
            x: { field: "big_id", type: "quantitative" },
            y: { field: "count", type: "quantitative" },
            // circle marks don't support shape — Vega-Lite drops with warning.
            shape: { field: "fruit", type: "nominal" },
          },
        },
        title: "Shape warning",
      });
    }, sql);

    // pushChart returns the warnings array — the same that goes to the agent.
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    // Check the keyword without coupling to Vega-Lite's exact wording.
    expect(result.warnings.join(" ").toLowerCase()).toMatch(/shape|circle|incompatible/);

    // UI shows the warnings banner.
    const banner = page.getByTestId("chart-warnings");
    await expect(banner).toBeVisible({ timeout: T_NORMAL });
    await expect(banner).toContainText(/shape|circle|incompatible/i);

    // The chart STILL renders alongside the warning (Vega clamps to a
    // valid log domain) — warnings are advisory, not fatal.
    await expect(page.getByTestId("vega-chart-container").locator("svg").first()).toBeVisible({ timeout: T_NORMAL });
  });

  test("compile failure (malformed spec) returns error before block insertion", async ({ page }) => {
    // If the LLM emits a spec that vega-lite's compile() rejects (e.g. a
    // completely malformed encoding), we should reject the tool call early
    // and surface the message to the model, NOT insert a broken block.
    const sql = await seedTestTable(page);
    const result = await page.evaluate(async (s) => {
      try {
        await (window as any).__cupolaChartTest.pushChart({
          sql: s,
          spec: {
            // mark.type is required when mark is an object — this is a
            // canonical compile error.
            mark: { invalid: "no_type_here" },
            encoding: { x: { field: "fruit" } },
          },
        });
        return { ok: true };
      } catch (e: any) {
        return { ok: false, msg: String(e?.message ?? e) };
      }
    }, sql);
    expect(result.ok).toBe(false);
    // No chart block should have been inserted.
    await expect(page.getByTestId("vega-chart-block")).toHaveCount(0);
  });

  test("axis titles are NOT clipped at the bottom of the chart container", async ({ page }) => {
    // Regression from the user's screenshot: a scatter plot with an
    // explicit x-axis title ("Longitude") had its title cropped by the
    // chart container's bottom edge. Root cause was autosize:"fit" with
    // a numeric height shrinking the plot but not reserving enough
    // bottom padding for the axis title. Fix uses autosize:"fit-x" for
    // inline charts so height grows naturally; this test locks that in.
    const sql = await seedTestTable(page);
    await pushChart(page, {
      sql,
      spec: {
        // Numeric height like an LLM would emit — used to cause clipping.
        height: 400,
        mark: "point",
        encoding: {
          x: { field: "big_id", type: "quantitative", title: "BIG_ID_AXIS_TITLE" },
          y: { field: "count", type: "quantitative", title: "COUNT_AXIS_TITLE" },
        },
      },
      title: "Axis title clipping",
    });

    const chartContainer = page.getByTestId("vega-chart-container");
    await expect(chartContainer.locator("svg").first()).toBeVisible({ timeout: T_NORMAL });

    // The axis title must be inside the container's vertical bounds —
    // not clipped by the bottom edge. Look up the title text element
    // by content, and verify its bottom is inside the container.
    const placement = await chartContainer.evaluate((el) => {
      const cRect = el.getBoundingClientRect();
      // Vega renders axis titles as <text> elements with the title string.
      const titles = Array.from(el.querySelectorAll("text"))
        .filter((t) => (t.textContent ?? "").includes("BIG_ID_AXIS_TITLE"));
      if (titles.length === 0) return { found: false } as const;
      const titleRect = titles[0].getBoundingClientRect();
      return {
        found: true as const,
        // Positive = title's bottom is past container's bottom (clipped).
        bottomOverflow: titleRect.bottom - cRect.bottom,
      };
    });
    expect(placement.found).toBe(true);
    // Title must be at least 4px above the container's bottom edge.
    expect((placement as { found: true; bottomOverflow: number }).bottomOverflow).toBeLessThanOrEqual(-4);
  });

  test("render_chart's sample payload survives JSON.stringify with BIGINT columns", async ({ page }) => {
    // Regression: readRows used to return raw Arrow BigInt for BIGINT
    // columns. render_chart builds its tool_result via JSON.stringify
    // which throws "Do not know how to serialize a BigInt". The fix
    // moved BigInt → Number/String coercion into readRows itself, so
    // every caller is automatically JSON-safe. Verify the pushChart
    // test hook (which mirrors render_chart's dispatch) doesn't throw.
    const sql = await seedTestTable(page);
    // big_id is a BIGINT column (from seedTestTable's CAST(N AS BIGINT)).
    // If readRows still returned BigInt, the JSON.stringify inside
    // pushChart would throw and this whole evaluate would reject.
    const result = await page.evaluate(async (s) => {
      return (window as any).__cupolaChartTest.pushChart({
        sql: s,
        spec: {
          mark: "bar",
          encoding: {
            x: { field: "big_id", type: "quantitative" },
            y: { field: "count", type: "quantitative" },
          },
        },
        title: "BIGINT survives JSON.stringify",
      });
    }, sql);
    // No throw = success. Also verify the chart actually rendered.
    expect(result.chartId).toBeTruthy();
    await expect(page.getByTestId("vega-chart-container").locator("svg").first()).toBeVisible({ timeout: T_NORMAL });
  });

  test("render_chart produces a PNG for the agent to see", async ({ page }) => {
    // The whole point of including the PNG in the tool_result is closing
    // the feedback loop: the model sees what it rendered and can iterate.
    // This test exercises the headless renderChartToPng path and checks
    // that a real PNG payload comes out.
    const sql = await seedTestTable(page);
    const result = await page.evaluate(async (s) => {
      return (window as any).__cupolaChartTest.pushChart({
        sql: s,
        spec: { mark: "bar", encoding: { x: { field: "fruit" }, y: { field: "count" } } },
        title: "PNG feedback",
        withPng: true,
      });
    }, sql);
    expect(result.pngMediaType).toBe("image/png");
    // Base64-encoded PNG of a real chart at 800x500 should be at least a
    // few KB. A header-only / empty render would be tiny.
    expect(result.pngBytes).toBeGreaterThan(2000);
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
