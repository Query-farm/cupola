import { devices, expect, test } from '@playwright/test';
import { APP_URL, shellQuery, waitForShellBridge } from './helpers';
import { SHELL_EXTENSIONS } from '../src/lib/duckdb-engine';

// Run the real production extension list. Most UI tests intentionally load
// only the base extensions and cannot catch startup regressions like this.
// The iPhone profile uses desktop WebKit, not iOS. Run with --browser=chromium
// as a second engine check; neither run reproduces a physical iPhone's limits.
test.use({ ...devices['iPhone 13'], storageState: { cookies: [], origins: [] } });

test('iOS keeps COI, shared-memory cancellation, and every extension with a smaller startup pool', async ({ page }) => {
  test.setTimeout(90_000);
  const requests: string[] = [];
  page.on('request', request => requests.push(new URL(request.url()).pathname));
  await page.goto(`${APP_URL}&view=catalog`);
  await expect(page.getByTestId('mobile-navigation')).toBeVisible();
  // No user interaction: this is exactly the startup that crashed on a phone.
  await waitForShellBridge(page, 60_000);
  await page.evaluate(() => (window as any).__bridge.attached);
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  expect(requests.filter(path => /\/haybarn\/duckdb-.*\.wasm$/.test(path))).toEqual([
    expect.stringContaining('/haybarn/duckdb-coi.wasm'),
  ]);
  expect(requests).toContainEqual(expect.stringContaining('/haybarn/duckdb-browser-coi-mobile.worker.js'));
  expect(requests.some(path => path.includes('duckdb-eh') || path.includes('duckdb-browser-eh'))).toBe(false);
  expect(await page.evaluate(() => (window as any).__bridge.interruptsRunningQueries)).toBe(true);

  const extensions = await shellQuery(page, 'SELECT extension_name FROM duckdb_extensions() WHERE loaded');
  expect(extensions.ok, extensions.error).toBe(true);
  expect(extensions.rows?.map(row => row.extension_name)).toEqual(expect.arrayContaining(SHELL_EXTENSIONS.map(extension => extension.name)));

  const result = await shellQuery(page, `SELECT current_setting('threads')::INTEGER AS threads,
    current_setting('memory_limit') AS memory_limit, ST_AsText(ST_Point(1, 2)) AS point,
    json_extract_string('{"ready":"yes"}', '$.ready') AS ready`);
  expect(result.ok, result.error).toBe(true);
  expect(result.rows).toEqual([{ threads: 1, memory_limit: '244.1 MiB', point: 'POINT (1 2)', ready: 'yes' }]);
  const catalogs = await shellQuery(page, "SELECT count(*)::INTEGER AS n FROM information_schema.schemata WHERE catalog_name NOT IN ('memory', 'system', 'temp')");
  expect(catalogs.ok, catalogs.error).toBe(true);
  expect(Number(catalogs.rows?.[0]?.n)).toBeGreaterThan(0);

  // COI's shared interrupt flag must still cancel a running query promptly.
  const cancelled = await page.evaluate(async () => {
    const controller = new AbortController();
    const query = (window as any).__bridge.query('SELECT sum(sin(i::DOUBLE)) FROM range(10000000000) t(i)', { signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 100);
    try { await query; return false; } catch (error) { return error instanceof Error && error.name === 'AbortError'; }
    finally { clearTimeout(timer); }
  });
  expect(cancelled).toBe(true);
  expect((await shellQuery(page, 'SELECT 42 AS answer')).rows).toEqual([{ answer: 42 }]);
});
