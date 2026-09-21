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

/** The viewer's hosted table name and row count once its view is ready. */
async function viewerState(page: Page, config?: Record<string, unknown>): Promise<{ table: string; rows: number }> {
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
        return { table: String(saved.table), rows: Number(rows) };
      } catch (error) {
        last = error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw new Error(`viewer never became ready: ${String(last)}`);
  }, config ?? null);
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
  expect(await scratchSources(page)).toEqual(["view __cupola_pivot"]);

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
