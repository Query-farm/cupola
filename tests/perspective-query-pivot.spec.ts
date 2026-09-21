/**
 * The editor's Pivot menu: a query pivoted as a live view or a table runs
 * through Perspective's virtual server (`VgiDuckDBHandler`) over a TEMP view or
 * table, instead of copying the result into Perspective like Snapshot does.
 * See `src/lib/pivot-source.ts`.
 *
 * Self-contained: the source is a small table created in `memory`, so the
 * spec depends on no particular catalog.
 */
import { test, expect, type Page } from "@playwright/test";
import { gotoApp, openEditor, shellQuery, typeInEditor, waitForShellBridge, T_NORMAL, T_SHELL_BOOT } from "./helpers";

const QUERY = "SELECT id, parity FROM memory.main.pivot_probe";

test.beforeEach(async ({ page }) => {
  await gotoApp(page);
  await waitForShellBridge(page);
  const created = await shellQuery(page, "CREATE OR REPLACE TABLE memory.main.pivot_probe AS SELECT i AS id, CASE WHEN i % 2 = 0 THEN 'even' ELSE 'odd' END AS parity FROM range(10) t(i)");
  expect(created.ok, created.error).toBe(true);
});

async function runInEditor(page: Page, sql: string) {
  await openEditor(page);
  await typeInEditor(page, sql);
  await page.getByTestId("editor-run").click();
  await expect(page.getByTestId("editor-open-perspective")).toBeVisible({ timeout: T_NORMAL });
}

async function pivot(page: Page, mode: "view" | "table" | "snapshot") {
  await page.getByTestId("editor-open-perspective").click();
  await page.getByTestId(`editor-pivot-${mode}`).click();
}

/** The viewer's hosted table, visible columns, and row count once its view is ready. */
async function viewerState(page: Page, config?: Record<string, unknown>): Promise<{ table: string; columns: string[]; rows: number }> {
  await expect(page.getByTestId("tab-perspective")).toHaveAttribute("aria-selected", "true", { timeout: T_SHELL_BOOT });
  return page.evaluate(async (restore) => {
    const deadline = Date.now() + 20_000;
    let last: unknown = null;
    while (Date.now() < deadline) {
      try {
        const el = document.querySelector("perspective-viewer") as any;
        if (restore) await el.restore(restore);
        const saved = await el.save();
        const rows = await (await el.getView()).num_rows();
        return { table: String(saved.table), columns: (saved.columns ?? []).filter(Boolean).map(String), rows: Number(rows) };
      } catch (error) {
        last = error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw new Error(`viewer never became ready: ${String(last)}`);
  }, config ?? null);
}

/**
 * Which settings the viewer offers, once its settings panel has rendered.
 * Split By is shown only when the serving handler advertises split_by —
 * materialized sources do, live ones cannot (a data-dependent PIVOT cannot be
 * stored in a view).
 */
async function settingsOffered(page: Page): Promise<{ groupBy: boolean; splitBy: boolean }> {
  return page.evaluate(() => {
    const el = document.querySelector("perspective-viewer") as any;
    const has = (root: any, id: string): boolean =>
      [...root.querySelectorAll("*")].some((node: any) => node.id === id || (node.shadowRoot && has(node.shadowRoot, id)));
    const root = el?.shadowRoot ?? el;
    return { groupBy: root ? has(root, "group_by") : false, splitBy: root ? has(root, "split_by") : false };
  });
}

async function scratchSources(page: Page): Promise<string[]> {
  const result = await shellQuery(page, `
    SELECT 'view ' || view_name AS source FROM duckdb_views() WHERE temporary AND view_name LIKE '\\_\\_cupola\\_pivot\\_%' ESCAPE '\\'
    UNION ALL
    SELECT 'table ' || table_name FROM duckdb_tables() WHERE temporary AND table_name LIKE '\\_\\_cupola\\_pivot\\_%' ESCAPE '\\'
    ORDER BY 1`);
  expect(result.ok, result.error).toBe(true);
  return (result.rows ?? []).map((row) => String(row.source).replace(/_\d+$/, ""));
}

test("a live view pivots with SQL against the query and sees new rows", async ({ page }) => {
  test.setTimeout(60_000);
  await runInEditor(page, QUERY);
  await pivot(page, "view");

  const flat = await viewerState(page);
  expect(flat.table).toMatch(/^temp\.main\.__cupola_pivot_\d+$/);
  expect(flat.rows).toBe(10);
  // Starts with just the first column, like the sidebar and snapshot paths.
  expect(flat.columns).toEqual(["id"]);
  expect(await scratchSources(page)).toEqual(["view __cupola_pivot"]);
  // Served live: no row identity, so split_by is not offered.
  await expect.poll(async () => (await settingsOffered(page)).groupBy).toBe(true);
  expect((await settingsOffered(page)).splitBy).toBe(false);

  // Grouping is computed by DuckDB: a rollup total plus one row per parity.
  expect((await viewerState(page, { group_by: ["parity"], columns: ["id"] })).rows).toBe(3);

  // Nothing was copied, so rows added after pivoting appear in the next view
  // Perspective builds. (Re-applying an identical config reuses the view.)
  expect((await shellQuery(page, "INSERT INTO memory.main.pivot_probe SELECT i, 'new' FROM range(10, 15) t(i)")).ok).toBe(true);
  expect((await viewerState(page, { group_by: ["parity"], columns: ["parity"] })).rows).toBe(4);
});

test("a table pivot holds the rows from when it was made", async ({ page }) => {
  test.setTimeout(60_000);
  await runInEditor(page, QUERY);
  await pivot(page, "table");

  expect((await viewerState(page)).rows).toBe(10);
  expect(await scratchSources(page)).toEqual(["table __cupola_pivot"]);
  expect((await shellQuery(page, "INSERT INTO memory.main.pivot_probe SELECT i, 'new' FROM range(10, 15) t(i)")).ok).toBe(true);
  expect((await viewerState(page, { group_by: ["parity"], columns: ["parity"] })).rows).toBe(3);

  // Served materialized: a TEMP TABLE has a rowid, so split_by is offered and
  // works with a group_by and without one (which numbers rows by rowid).
  await expect.poll(async () => (await settingsOffered(page)).splitBy).toBe(true);
  const split = await page.evaluate(async () => {
    const el = document.querySelector("perspective-viewer") as any;
    const run = async (config: Record<string, unknown>) => {
      await el.restore(config);
      const view = await el.getView();
      return { rows: Number(await view.num_rows()), paths: ((await view.column_paths()) as string[]).filter((path) => path.includes("|")).sort() };
    };
    return {
      grouped: await run({ group_by: ["id"], split_by: ["parity"], columns: ["id"] }),
      flat: await run({ group_by: [], split_by: ["parity"], columns: ["id"] }),
    };
  });
  // A rollup total plus one row per id: the table kept its 10 rows.
  expect(split.grouped).toEqual({ rows: 11, paths: ["even|id", "odd|id"] });
  expect(split.flat).toEqual({ rows: 10, paths: ["even|id", "odd|id"] });
});

test("each pivot replaces the previous scratch source", async ({ page }) => {
  test.setTimeout(90_000);
  await runInEditor(page, QUERY);
  await pivot(page, "view");
  const first = await viewerState(page);

  await openEditor(page);
  await pivot(page, "table");
  const second = await viewerState(page);
  expect(second.table).not.toBe(first.table);
  expect(await scratchSources(page)).toEqual(["table __cupola_pivot"]);

  await openEditor(page);
  await pivot(page, "snapshot");
  await expect(page.locator("perspective-viewer")).toBeAttached({ timeout: T_SHELL_BOOT });
  await expect.poll(() => scratchSources(page), { timeout: T_NORMAL }).toEqual([]);
});

test("a statement that cannot be wrapped explains itself and stays in the editor", async ({ page }) => {
  test.setTimeout(60_000);
  await runInEditor(page, "DESCRIBE memory.main.pivot_probe");
  await pivot(page, "view");

  await expect(page.getByTestId("editor-pivot-error")).toContainText("can't be pivoted as a live view");
  await expect(page.getByTestId("editor-pivot-error")).toContainText("Snapshot works for any result");
  await expect(page.getByTestId("tab-editor")).toHaveAttribute("aria-selected", "true");
  expect(await scratchSources(page)).toEqual([]);
});

test("Run in Perspective opens a query without running it in the editor", async ({ page }) => {
  test.setTimeout(60_000);
  await openEditor(page);
  await typeInEditor(page, QUERY);
  await page.getByTestId("editor-run-perspective").click();
  await page.getByTestId("editor-run-perspective-view").click();

  const opened = await viewerState(page);
  expect(opened.table).toMatch(/^temp\.main\.__cupola_pivot_\d+$/);
  expect(opened.rows).toBe(10);
  expect(opened.columns).toEqual(["id"]);

  // The editor never executed the query, so it holds no result to buffer.
  await openEditor(page);
  await expect(page.getByText("Run a query to see results here.")).toBeVisible();
  await expect(page.getByTestId("editor-open-perspective")).toHaveCount(0);
});

test("Run in Perspective explains a statement it cannot wrap", async ({ page }) => {
  test.setTimeout(60_000);
  await openEditor(page);
  await typeInEditor(page, "DESCRIBE memory.main.pivot_probe");
  await page.getByTestId("editor-run-perspective").click();
  await page.getByTestId("editor-run-perspective-table").click();

  // No result grid is on screen, and the error still shows.
  await expect(page.getByTestId("editor-pivot-error")).toContainText("can't be pivoted as a table");
  await expect(page.getByTestId("tab-editor")).toHaveAttribute("aria-selected", "true");
});

test("column names keep their underscores through a live view", async ({ page }) => {
  test.setTimeout(60_000);
  const created = await shellQuery(page, `CREATE OR REPLACE TABLE memory.main.sales_probe AS
    SELECT i AS order_id,
           CASE WHEN i % 2 = 0 THEN 'north_east' ELSE 'south_west' END AS region_name,
           i * 1.5 AS total_sales
      FROM range(12) t(i)`);
  expect(created.ok, created.error).toBe(true);
  await openEditor(page);
  await typeInEditor(page, "SELECT * FROM memory.main.sales_probe");
  await page.getByTestId("editor-run-perspective").click();
  await page.getByTestId("editor-run-perspective-view").click();

  // Names pass through as written; the virtual server used to show order-id.
  expect((await viewerState(page)).columns).toEqual(["order_id"]);
  const grouped = await page.evaluate(async () => {
    const el = document.querySelector("perspective-viewer") as any;
    const schema = await (await el.getTable()).schema();
    await el.restore({ group_by: ["region_name"], columns: ["total_sales"] });
    return { schema: Object.keys(schema), rows: Number(await (await el.getView()).num_rows()) };
  });
  expect(grouped.schema.sort()).toEqual(["order_id", "region_name", "total_sales"]);
  // A rollup total plus one row per region.
  expect(grouped.rows).toBe(3);
});
