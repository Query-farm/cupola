/**
 * The editor's Stop button cancels a running query.
 *
 * Fixture: `cupola_test.edge.slow_rows(rows, delay_ms)` sleeps `delay_ms` on
 * the server before each 1,000-row chunk, and each chunk is one HTTP exchange.
 * 100,000 rows at 2s a chunk would take about 200s to finish, so every bound
 * below is far from what an uncancelled scan would take.
 *
 * Requires `test-worker/run.sh`; skips when the `cupola_test` catalog is not attached.
 */
import { test, expect, type Page } from "@playwright/test";
import { gotoApp, openEditor, shellQuery, typeInEditor, waitForShellBridge, T_NORMAL } from "./helpers";

const DELAY_MS = 2_000;

test.beforeEach(async ({ page }) => {
  await gotoApp(page);
  await waitForShellBridge(page);
});

async function requireTestCatalog(page: Page): Promise<void> {
  const catalog = await shellQuery(page, "SELECT DISTINCT catalog_name FROM information_schema.schemata WHERE catalog_name = 'cupola_test'");
  test.skip(!catalog.rows?.length, "cupola_test is not attached — start test-worker/run.sh");
}

async function runInEditor(page: Page, sql: string): Promise<void> {
  await typeInEditor(page, sql);
  await page.getByTestId("editor-run").click();
}

/** Start the slow scan, let it reach its chunk loop, press Stop. Returns when Stop was pressed. */
async function startAndStopSlowScan(page: Page): Promise<number> {
  await openEditor(page);
  await runInEditor(page, `SELECT count(*) AS n FROM cupola_test.edge.slow_rows(100000, ${DELAY_MS})`);
  const stop = page.getByTestId("editor-stop");
  await expect(stop).toBeVisible({ timeout: T_NORMAL });
  // Past ATTACH/bind and into the chunk loop, with a chunk request in flight.
  await page.waitForTimeout(DELAY_MS + 500);
  await expect(stop).toBeVisible();
  const stoppedAt = Date.now();
  await stop.click();
  return stoppedAt;
}

test("Stop releases the editor at once", async ({ page }) => {
  await requireTestCatalog(page);
  await startAndStopSlowScan(page);
  await expect(page.getByTestId("editor-cancelled")).toBeVisible({ timeout: 1_000 });
  await expect(page.getByTestId("editor-run")).toBeVisible();
  await expect(page.getByTestId("editor-stop")).toBeHidden();
});

test("the engine is free again within one in-flight chunk of Stop", async ({ page }) => {
  // A cancel sent as a message is read only between polls, and one poll can run
  // a slow scan to the end: a 20-chunk scan stopped after one chunk held the next
  // query for 38s. Stop now sets the connection's interrupt flag in wasm memory
  // (haybarn-wasm's `getInterruptHandle`), which the engine sees mid-poll.
  test.setTimeout(60_000);
  await requireTestCatalog(page);
  const interrupts = await page.evaluate(() => (window as any).__bridge.interruptsRunningQueries);
  test.skip(!interrupts, "needs a haybarn-wasm build with getInterruptHandle (threads build)");
  const stoppedAt = await startAndStopSlowScan(page);
  await expect(page.getByTestId("editor-cancelled")).toBeVisible({ timeout: 1_000 });

  await runInEditor(page, "SELECT 4242 AS after_cancel");
  await expect(page.getByRole("cell", { name: "4242", exact: true })).toBeVisible({ timeout: DELAY_MS * 3 });
  expect(Date.now() - stoppedAt).toBeLessThan(DELAY_MS * 3);
});

test("a failed statement inside BEGIN keeps its error and the engine's threads", async ({ page }) => {
  // On builds without the interrupt flag, cancellable queries run at
  // `SET threads = 1` and restore the setting afterwards. In an aborted transaction DuckDB refuses even SET, so a restore
  // on the shared connection threw "Current transaction is aborted", replacing
  // the statement's own error and leaving the engine on one thread.
  const before = await shellQuery(page, "SELECT current_setting('threads') AS t");
  const threads = Number(before.rows?.[0]?.t);
  await openEditor(page);
  await runInEditor(page, "BEGIN");
  await expect(page.getByTestId("editor-running")).toBeHidden({ timeout: T_NORMAL });
  await expect(page.getByText("Query failed")).toBeHidden();
  await runInEditor(page, "SELECT 'not a number'::INTEGER");
  await expect(page.getByText("Query failed")).toBeVisible({ timeout: T_NORMAL });
  await expect(page.getByText(/Could not convert string/)).toBeVisible();
  await runInEditor(page, "ROLLBACK");
  await expect(page.getByTestId("editor-running")).toBeHidden({ timeout: T_NORMAL });
  await expect(page.getByText("Query failed")).toBeHidden();

  const after = await shellQuery(page, "SELECT current_setting('threads') AS t");
  expect(Number(after.rows?.[0]?.t)).toBe(threads);
});
