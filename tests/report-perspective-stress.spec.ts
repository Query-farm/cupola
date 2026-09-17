/**
 * Report Perspective blocks over a large dataset.
 *
 * A 400,000-row dataset behind a Perspective block used to kill the tab: every
 * dataset run re-serialized the whole result, materialized it as JS row objects
 * the block never reads, and loaded another copy into Perspective without ever
 * freeing the previous one (its `delete()` failed against the viewer's live
 * View and the error was swallowed). This drives that path against the
 * `cupola_test` catalog served by `test-worker/` and asserts each re-run
 * replaces the Perspective table instead of stacking a new one.
 *
 * Requires `test-worker/run.sh`; skips when that catalog is not attached.
 */
import { test, expect, type Page } from "@playwright/test";
import { gotoApp, shellQuery, waitForShellBridge, T_NORMAL } from "./helpers";

const ROWS = 400_000;
const LOAD_TIMEOUT = 120_000;

test.beforeEach(async ({ page }) => {
  await gotoApp(page);
  await waitForShellBridge(page);
  await page.keyboard.press("Escape");
});

/** Names of the static-snapshot tables Perspective is hosting, and the row
 *  count of the one the block's viewer is bound to. */
async function perspectiveState(page: Page): Promise<{ tables: string[]; rows: number } | null> {
  return page.evaluate(async () => {
    const viewer = document.querySelector('[data-testid="report-block-pivot"] perspective-viewer') as any;
    if (!viewer?.getClient) return null;
    try {
      const client = await viewer.getClient();
      const names: string[] = await client.get_hosted_table_names();
      const table = await viewer.getTable();
      return { tables: names.filter((name) => name.startsWith("cupola-static-")), rows: Number(await table.size()) };
    } catch {
      // Between snapshots the viewer is ejected and has no client or table.
      return null;
    }
  });
}

test("re-running a large Perspective dataset replaces its table instead of leaking one", async ({ page }) => {
  test.setTimeout(LOAD_TIMEOUT * 4);
  const schemas = await shellQuery(page, "SELECT DISTINCT catalog_name FROM information_schema.schemata WHERE catalog_name = 'cupola_test'");
  test.skip(!schemas.rows?.length, "cupola_test is not attached — start test-worker/run.sh");

  await page.getByTestId("tab-reports").click();
  await expect(page.getByTestId("reports-workspace")).toBeVisible({ timeout: T_NORMAL });
  const now = Date.now();
  const report = {
    schemaVersion: 1,
    id: "perspective-stress",
    title: "Perspective stress",
    createdAt: now,
    updatedAt: now,
    revision: 1,
    requiredSources: [],
    parameters: [],
    datasets: [{ id: "orders", name: "Orders", sql: "SELECT * FROM cupola_test.large.orders_400k" }],
    blocks: [{ id: "pivot", type: "perspective", datasetId: "orders", title: "All orders", layout: { x: 0, y: 0, w: 12, h: 8 } }],
  };
  await page.locator('input[type="file"]').setInputFiles({
    name: "stress.cupola-report.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(report)),
  });

  const run = page.getByTestId("reports-run");
  const seen = new Set<string>();
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0 || !(await page.locator('[data-testid="report-block-pivot"] perspective-viewer').count())) await run.click();
    await expect.poll(async () => {
      const state = await perspectiveState(page);
      return state && state.tables.length === 1 && !seen.has(state.tables[0]) ? state.rows : null;
    }, { timeout: LOAD_TIMEOUT, intervals: [500] }).toBe(ROWS);
    const state = (await perspectiveState(page))!;
    // Exactly one snapshot alive: the previous run's table was really freed.
    expect(state.tables).toHaveLength(1);
    seen.add(state.tables[0]);
  }
  expect(seen.size).toBe(3);
});
