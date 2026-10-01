/**
 * A report pivot's Perspective snapshot is freed on every refresh.
 *
 * `viewer.load(client)` takes no ownership of a Table, so each snapshot must be deleted by
 * cupola, and deleting one while the viewer still holds a View fails for good (see
 * `loadPerspective` / `releasePerspective` in DuckDBShell.tsx). When that went wrong, every
 * re-run stacked another full copy in the renderer until the tab died. This refreshes a report
 * with a pivot several times and asserts exactly one `cupola-static-*` table is alive each time,
 * and that it is a new one.
 *
 * Requires `test-worker/run.sh`; skips when the `cupola_test` catalog is not attached.
 */
import { test, expect, type Page } from '@playwright/test';
import { APP_ORIGIN, BASE, SERVICE_URL, gotoApp, shellQuery, waitForShellBridge } from './helpers';

const ROWS = 1_000;

async function perspectiveState(page: Page): Promise<{ tables: string[]; rows: number } | null> {
  return page.evaluate(async () => {
    const viewer = document.querySelector('[data-testid="evidence-pivot"] perspective-viewer') as any;
    if (!viewer?.getClient) return null;
    try {
      const client = await viewer.getClient();
      const names: string[] = await client.get_hosted_table_names();
      const table = await viewer.getTable();
      return { tables: names.filter(name => name.startsWith('cupola-static-')), rows: Number(await table.size()) };
    } catch {
      // Between snapshots the viewer is ejected and has no client or table.
      return null;
    }
  });
}

test('refreshing a report replaces its pivot table instead of leaking one', async ({ page }) => {
  test.setTimeout(180_000);
  await gotoApp(page);
  await waitForShellBridge(page);
  const catalog = await shellQuery(page, "SELECT DISTINCT catalog_name FROM information_schema.schemata WHERE catalog_name = 'cupola_test'");
  test.skip(!catalog.rows?.length, 'cupola_test is not attached — start test-worker/run.sh');

  const report = {
    version: 1, id: 'pivot-release', title: 'Pivot release', serviceUrl: SERVICE_URL, setupSql: '', parameters: [], values: {}, createdAt: 1, updatedAt: 1,
    source: '# Pivot release\n\n```sql orders\nSELECT * FROM cupola_test.small.orders_1k\n```\n\n{% table data="orders" /%}',
    pivots: [{ id: 'pivot', title: 'Orders pivot', datasetId: 'query:orders' }],
  };
  await page.evaluate(saved => localStorage.setItem(`cupola.evidence.report.v2:${encodeURIComponent(saved.serviceUrl)}:${saved.id}`, JSON.stringify(saved)), report);
  await page.goto(`${APP_ORIGIN}${BASE}reports?${new URLSearchParams({ service: SERVICE_URL, evidence_report: report.id })}`);
  const panel = page.getByTestId('evidence-panel');

  const seen = new Set<string>();
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await panel.getByRole('button', { name: 'Refresh report' }).click();
    await expect.poll(async () => {
      const state = await perspectiveState(page);
      return state && state.tables.length === 1 && !seen.has(state.tables[0]) ? state.rows : null;
    }, { timeout: 60_000, intervals: [500] }).toBe(ROWS);
    const state = (await perspectiveState(page))!;
    // Exactly one snapshot alive: the previous refresh's table was really freed.
    expect(state.tables).toHaveLength(1);
    seen.add(state.tables[0]);
  }
  expect(seen.size).toBe(3);
});
