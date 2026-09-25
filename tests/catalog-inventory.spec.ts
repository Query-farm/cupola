import { test, expect, type Page } from '@playwright/test';
import { gotoApp, openEditor, typeInEditor, waitForShellBridge, SERVICE_URL, shellQuery } from './helpers';

async function inventory(page: Page): Promise<any[]> {
  return page.evaluate(async () => {
    const path = '/src/lib/catalog-store.ts';
    return (await import(path)).catalogInventory.current();
  });
}
async function listedCatalogs(page: Page): Promise<any[]> {
  return page.evaluate(async () => {
    const path = '/src/lib/evidence/agent-data-tools.ts';
    const { executeReportDataTool } = await import(path);
    // A stale caller's empty list must not hide attachments from discovery.
    const result = await executeReportDataTool('list_catalogs', {}, [], {}, 'unrestricted-sql');
    return JSON.parse(result).catalogs;
  });
}
const sidebar = (page: Page) => page.getByTestId('catalog-sidebar');
const literal = (s: string) => `'${s.replaceAll("'", "''")}'`;

test.beforeEach(async ({ page }) => {
  await gotoApp(page);
  await waitForShellBridge(page);
  await expect.poll(async () => (await inventory(page)).some(c => c.catalogName === 'memory')).toBe(true);
});

test('editor batches discover native catalogs, schema changes, and primary detach', async ({ page }) => {
  const primary = (await inventory(page)).find(c => c.primary).catalogName;
  await openEditor(page);
  await typeInEditor(page, `-- A batch with a final SELECT must still refresh metadata.\nATTACH ':memory:' AS "local data"; CREATE TABLE "local data".main.items(id INTEGER PRIMARY KEY); SELECT 1`);
  await page.locator('.cm-content').press('ControlOrMeta+a');
  await page.getByTestId('editor-run').click();
  await expect(sidebar(page).getByText('local data', { exact: true })).toBeVisible();
  const catalog = (await inventory(page)).find(c => c.catalogName === 'local data');
  expect(catalog.databaseType).toBe('duckdb');
  expect(catalog.metadataError).toBeUndefined();
  expect(catalog.schemas.find((s: any) => s.info.name === 'main').tables[0].primary_key_constraints).toEqual([[0]]);
  expect((await listedCatalogs(page)).find(c => c.catalog === 'local data').type).toBe('duckdb');
  await shellQuery(page, `USE memory; DETACH "${primary.replaceAll('"', '""')}"`);
  await expect.poll(async () => (await listedCatalogs(page)).map(c => c.catalog)).not.toContain(primary);
  await expect(sidebar(page).getByText(primary, { exact: true })).toHaveCount(0);
  await shellQuery(page, 'DETACH "local data"');
  await expect(sidebar(page).getByText('local data', { exact: true })).toHaveCount(0);
});

test('shell attachments preserve VGI metadata and share discovery with reporting and Ask AI', async ({ page }) => {
  const primary = (await inventory(page)).find(c => c.primary);
  await page.getByTestId('tab-shell').click();
  await page.evaluate(sql => (window as any).__bridge.runQuery(sql), `/* second worker */ ATTACH ${literal(primary.catalogName)} AS second_worker (TYPE vgi, LOCATION ${literal(SERVICE_URL)});`);
  await expect(sidebar(page).getByText('second_worker', { exact: true })).toBeVisible({ timeout: 15000 });
  const catalogs = await inventory(page);
  const second = catalogs.find(c => c.catalogName === 'second_worker');
  expect(second.metadataError).toBeUndefined();
  expect(second.catalogTags).toEqual(primary.catalogTags);
  expect(second.schemas.map((s: any) => s.info.name)).toEqual(primary.schemas.map((s: any) => s.info.name));
  const listed = await listedCatalogs(page);
  expect(listed.find(c => c.catalog === 'second_worker')).toMatchObject({ type: 'vgi', primary: false });
  const askAI = await page.evaluate(async () => {
    const storePath = '/src/lib/catalog-store.ts', aiPath = '/src/lib/ai-agent.ts';
    const { sessionCatalogs } = await import(storePath);
    const { executeListCatalogs, executeListTables } = await import(aiPath);
    const catalogs = await sessionCatalogs([]);
    return { catalogs: JSON.parse(executeListCatalogs(catalogs)).catalogs, ambiguous: JSON.parse(executeListTables(catalogs, {})) };
  });
  expect(askAI.catalogs).toEqual(listed);
  expect(askAI.ambiguous.error).toContain('Catalog is required');
  await page.evaluate(() => (window as any).__bridge.runQuery('DETACH second_worker;'));
  await expect(sidebar(page).getByText('second_worker', { exact: true })).toHaveCount(0);
});

test('report setup and prepared queries refresh the same inventory', async ({ page }) => {
  await page.evaluate(async () => {
    const path = '/src/lib/evidence/query-run.ts';
    const { EvidenceQueryRun } = await import(path);
    const run = new EvidenceQueryRun();
    const result = await run.query("ATTACH ':memory:' AS report_source; CREATE TABLE report_source.main.metrics AS SELECT 42 AS value");
    if (!result.ok) throw new Error(result.error);
    const prepared = await run.query('CREATE TABLE report_source.main.bound AS SELECT ? AS value', [7]);
    if (!prepared.ok) throw new Error(prepared.error);
  });
  expect((await listedCatalogs(page)).map(c => c.catalog)).toContain('report_source');
  await expect(sidebar(page).getByText('report_source', { exact: true })).toBeVisible();
  const catalog = (await inventory(page)).find(c => c.catalogName === 'report_source');
  expect(catalog.schemas.find((s: any) => s.info.name === 'main').tables.map((t: any) => t.name)).toEqual(['bound', 'metrics']);
});

test('failed metadata remains visible and retry restores it', async ({ page }) => {
  await page.evaluate(async () => {
    const path = '/src/lib/shell-bridge.ts';
    const { engine } = await import(path);
    const query = engine.query;
    (window as any).__restoreQuery = () => { engine.query = query; };
    engine.query = (sql: string, options: any) => sql.includes('duckdb_tables()') && sql.includes("'broken'")
      ? Promise.resolve({ ok: false, error: 'Simulated metadata failure' }) : query(sql, options);
    await engine.query("ATTACH ':memory:' AS broken");
  });
  await expect(sidebar(page).getByText('broken', { exact: true })).toBeVisible();
  await expect(sidebar(page).getByRole('alert')).toContainText('broken: metadata unavailable');
  expect((await listedCatalogs(page)).find(c => c.catalog === 'broken').metadata_error).toContain('Simulated metadata failure');
  await page.evaluate(() => (window as any).__restoreQuery());
  await sidebar(page).getByRole('alert').getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(sidebar(page).getByRole('alert')).toHaveCount(0);
  expect((await listedCatalogs(page)).find(c => c.catalog === 'broken').metadata_error).toBeUndefined();
});

test('Ask AI discovers attachments and detachments between tools in the same turn', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('vgi-frontend-settings', JSON.stringify({ anthropicApiKey: 'test-key-not-real', aiModel: 'claude-sonnet-4-6', aiQueryMode: 'unrestricted-sql' })));
  await page.reload();
  await waitForShellBridge(page);
  const requests: any[] = [];
  const steps = [
    { name: 'run_sql', input: { sql: "ATTACH ':memory:' AS ai_source" } },
    { name: 'list_catalogs', input: {} },
    { name: 'run_sql', input: { sql: 'DETACH ai_source' } },
    { name: 'list_catalogs', input: {} },
  ];
  await page.route('https://api.anthropic.com/v1/messages', async route => {
    requests.push(route.request().postDataJSON());
    const tool = steps[requests.length - 1];
    const events = [
      { type: 'message_start', message: { id: `message-${requests.length}`, usage: { input_tokens: 100 } } },
      { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: `tool-${requests.length}`, name: tool.name } : { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } : { type: 'text_delta', text: 'Finished catalog check.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 30 } },
      { type: 'message_stop' },
    ];
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('') });
  });
  await page.getByTestId('tab-askai').click();
  const input = page.getByRole('textbox', { name: 'Chat message input' });
  await input.fill('Attach a local database, list catalogs, detach it and list catalogs again.');
  await input.press('Enter');
  await expect(page.getByText('Finished catalog check.', { exact: true })).toBeVisible({ timeout: 20000 });
  expect(requests).toHaveLength(5);
  const toolResult = (request: any) => JSON.parse(request.messages.at(-1).content.find((item: any) => item.type === 'tool_result').content);
  expect(toolResult(requests[2]).catalogs.map((c: any) => c.catalog)).toContain('ai_source');
  expect(toolResult(requests[4]).catalogs.map((c: any) => c.catalog)).not.toContain('ai_source');
  await expect(sidebar(page).getByText('ai_source', { exact: true })).toHaveCount(0);
});
