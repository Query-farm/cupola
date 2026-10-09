import { test, expect, type Page } from '@playwright/test';
import { gotoApp, waitForShellBridge, shellQuery, APP_ORIGIN, T_SHELL_BOOT } from './helpers';
import { withExtensions } from './extensions';

// Boots with the base extensions plus the one this spec exercises (tests/extensions.ts).
test.use({ storageState: withExtensions('grainlift') });

// Grainlift databases (https://github.com/Query-farm/duckdb-grainlift) attach
// through the `grainlift` community extension loaded at shell boot, and must
// show up in the catalog like any other attached database.
//
// Needs a Grainlift gateway whose CORS origin allows the app, e.g. from
// Query-farm/duckdb-grainlift:
//   scripts/test-server.sh 8484 http://localhost:4321
//   GRAINLIFT_URI=grainlift+http://127.0.0.1:8484 bun run test:e2e tests/grainlift.spec.ts
const GRAINLIFT_URI = process.env.GRAINLIFT_URI;
const GRAINLIFT_TOKEN = process.env.GRAINLIFT_TOKEN ?? 'grainlift-test-token';
const GRAINLIFT_TARGET = process.env.GRAINLIFT_TARGET ?? 'sqlite';

test.skip(!GRAINLIFT_URI, `set GRAINLIFT_URI to a Grainlift gateway allowing CORS from ${APP_ORIGIN}`);

const literal = (s: string) => `'${s.replaceAll("'", "''")}'`;
const sidebar = (page: Page) => page.getByTestId('catalog-sidebar');

async function inventory(page: Page): Promise<any[]> {
  return page.evaluate(async () => {
    const path = '/src/lib/catalog-store.ts';
    return (await import(path)).catalogInventory.current();
  });
}

test('grainlift databases attach and appear in the catalog', async ({ page }) => {
  await gotoApp(page);
  await waitForShellBridge(page);
  await expect.poll(() => page.evaluate(async () => {
    const path = '/src/lib/duckdb-engine.ts';
    return (await import(path)).hasExtension('grainlift');
  }), { timeout: T_SHELL_BOOT }).toBe(true);

  // A fresh SQLite file on the gateway, so the test owns its contents.
  const remote = `/tmp/cupola_grainlift_${Date.now()}.db`;
  const attach = await shellQuery(page,
    `ATTACH ${literal(GRAINLIFT_URI!)} AS gl (TYPE grainlift, target ${literal(GRAINLIFT_TARGET)}, ` +
    `bearer_token ${literal(GRAINLIFT_TOKEN)}, remote_uri ${literal(remote)})`);
  expect(attach.error).toBeUndefined();
  const create = await shellQuery(page, 'CREATE TABLE gl.main.items AS SELECT range AS id FROM range(5)');
  expect(create.error).toBeUndefined();

  await expect(sidebar(page).getByText('gl', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect.poll(async () => {
    const gl = (await inventory(page)).find(c => c.catalogName === 'gl');
    return gl && {
      type: gl.databaseType,
      error: gl.metadataError ?? null,
      tables: gl.schemas.find((s: any) => s.info.name === 'main')?.tables.map((t: any) => t.name),
    };
  }).toEqual({ type: 'grainlift', error: null, tables: ['items'] });

  const count = await shellQuery(page, 'SELECT count(*)::INTEGER AS n FROM gl.main.items');
  expect(count.rows).toEqual([{ n: 5 }]);
  await shellQuery(page, 'DETACH gl');
  await expect(sidebar(page).getByText('gl', { exact: true })).toHaveCount(0);
});
