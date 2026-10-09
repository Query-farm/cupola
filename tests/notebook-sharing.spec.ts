import { test, expect, type Page, type Locator } from '@playwright/test';
import { APP_ORIGIN, BASE, SERVICE_URL, waitForShellBridge, shellQuery } from './helpers';

async function openNotebook(page: Page) {
  await page.goto(`${APP_ORIGIN}${BASE}notebooks?service=${encodeURIComponent(SERVICE_URL)}`);
  await waitForShellBridge(page, 30_000);
  await page.getByTestId('notebook-library').getByRole('button', { name: 'New notebook', exact: true }).click();
  return page.getByTestId('notebook-cell').first();
}
async function run(cell: Locator, sql: string) {
  await cell.locator('.cm-content').fill(sql);
  await cell.getByRole('button', { name: 'Run', exact: true }).click();
}
async function addCell(page: Page) {
  await page.getByRole('button', { name: /Insert cell at position/ }).last().click();
  await page.getByRole('menuitem', { name: 'SQL cell', exact: true }).click();
  return page.getByTestId('notebook-cell').last();
}
async function action(page: Page, name: string) {
  await page.getByRole('button', { name: 'Notebook actions', exact: true }).click();
  await page.getByRole('menuitem', { name, exact: true }).click();
}

test('multiple connections on one WASM database isolate temporary tables and close cleanly', async ({ page }) => {
  await openNotebook(page);
  const checks = await page.evaluate(async () => {
    const bridge = (window as any).__bridge;
    await bridge.attached;
    const a = await bridge.openConnection();
    const b = await bridge.openConnection();
    const ok = async (connection: typeof a, sql: string, params?: unknown[]) => {
      const result = params ? await connection.queryPrepared(sql, params) : await connection.query(sql);
      if (!result.ok) throw new Error(result.error);
    };
    try {
      await ok(a, 'CREATE TABLE memory.main.shared_connection_probe AS SELECT 7 AS n');
      await ok(b, "SELECT CASE WHEN n = 7 THEN true ELSE error('not shared') END FROM memory.main.shared_connection_probe");
      await ok(a, 'CREATE TEMP TABLE same_name AS SELECT ?::INTEGER AS n', [11]);
      const hidden = !(await b.query('SELECT * FROM temp.main.same_name')).ok;
      await ok(b, 'CREATE TEMP TABLE same_name AS SELECT 22 AS n');
      await ok(a, "SELECT CASE WHEN n = 11 THEN true ELSE error('wrong A') END FROM same_name");
      await ok(b, "SELECT CASE WHEN n = 22 THEN true ELSE error('wrong B') END FROM same_name");
      await ok(a, "SET VARIABLE notebook_value = 'A'");
      await ok(b, "SET VARIABLE notebook_value = 'B'");
      await ok(a, "SELECT CASE WHEN getvariable('notebook_value') = 'A' THEN true ELSE error('variable leaked') END");
      await ok(a, 'SELECT * FROM cupola_test.small.regions LIMIT 1');
      await ok(b, 'SELECT * FROM cupola_test.small.regions LIMIT 1');
      await a.close();
      let closedRejected = false;
      try { await a.query('SELECT 1'); } catch { closedRejected = true; }
      const fresh = await bridge.openConnection();
      const gone = !(await fresh.query('SELECT * FROM temp.main.same_name')).ok;
      await fresh.close();
      await ok(b, "SELECT CASE WHEN n = 22 THEN true ELSE error('B was cleared') END FROM same_name");
      return { hidden, gone, closedRejected, shellHidden: !(await bridge.query('SELECT * FROM temp.main.same_name')).ok };
    } finally {
      await a.close();
      await b.close();
      await bridge.query('DROP TABLE IF EXISTS memory.main.shared_connection_probe');
    }
  });
  expect(checks).toEqual({ hidden: true, gone: true, closedRejected: true, shellHidden: true });
});

test('queued cancellation and closing an active connection leave other connections usable', async ({ page }) => {
  await openNotebook(page);
  const checks = await page.evaluate(async () => {
    const bridge = (window as any).__bridge;
    const a = await bridge.openConnection();
    const b = await bridge.openConnection();
    try {
      const started = Promise.withResolvers<void>();
      const running = a.query('SELECT count(*) FROM cupola_test.edge.slow_rows(1, 1500)', { onStart: () => started.resolve() });
      await started.promise;
      const controller = new AbortController();
      const queued = b.query('SELECT 99', { signal: controller.signal }).then(() => false, () => true);
      controller.abort();
      const queuedCancelled = await queued;
      const otherSucceeded = (await running).ok;
      const slowStarted = Promise.withResolvers<void>();
      const slow = a.query('SELECT count(*) FROM cupola_test.edge.slow_rows(100000, 2000)', { onStart: () => slowStarted.resolve() }).then(() => false, () => true);
      await slowStarted.promise;
      await new Promise(resolve => setTimeout(resolve, 2500));
      await a.close();
      const activeCancelled = await slow;
      const bStillWorks = (await b.queryPrepared('SELECT ?::INTEGER', [42])).ok;
      const shellStillWorks = (await bridge.query('SELECT 1')).ok;
      return { queuedCancelled, otherSucceeded, activeCancelled, bStillWorks, shellStillWorks };
    } finally { await a.close(); await b.close(); }
  });
  expect(checks).toEqual({ queuedCancelled: true, otherSucceeded: true, activeCancelled: true, bStillWorks: true, shellStillWorks: true });
});

test('failed and cancelled replacements preserve the previous temporary table', async ({ page }) => {
  const first = await openNotebook(page);
  await run(first, 'CREATE OR REPLACE TEMP TABLE kept AS SELECT 42 AS n');
  await expect(first.getByRole('cell', { name: '42', exact: true })).toBeVisible();
  await run(first, "CREATE OR REPLACE TEMP TABLE kept AS SELECT error('replacement failed') AS n");
  await expect(first.getByRole('alert')).toContainText('replacement failed');
  const second = await addCell(page);
  await run(second, 'SELECT * FROM kept');
  await expect(second.getByRole('cell', { name: '42', exact: true })).toBeVisible();
  await run(first, 'CREATE OR REPLACE TEMP TABLE kept AS SELECT count(*) AS n FROM cupola_test.edge.slow_rows(100000, 2000)');
  await expect(first.getByText(/Reevaluating · Executing query/)).toBeVisible();
  await page.waitForTimeout(2500);
  await first.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(first.getByText('Cancelled', { exact: true })).toBeVisible();
  await second.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(second.getByText(/Result from run #5/)).toBeVisible();
  await expect(second.getByRole('cell', { name: '42', exact: true })).toBeVisible();
  await run(first, 'CREATE OR REPLACE TEMP TABLE kept AS SELECT n + 1 AS n FROM kept');
  await expect(first.getByRole('cell', { name: '43', exact: true })).toBeVisible();
});

test('cells share materialized rows, refresh downstream results and reset without changing SQL', async ({ page }) => {
  const first = await openNotebook(page);
  const setup = 'CREATE OR REPLACE TEMP TABLE totals AS SELECT 42 AS total';
  await run(first, setup);
  await expect(first.getByRole('cell', { name: '42', exact: true })).toBeVisible();
  expect((await shellQuery(page, 'SELECT * FROM temp.main.totals')).ok).toBe(false);
  const second = await addCell(page);
  await run(second, 'SELECT total + 1 AS answer FROM totals');
  await expect(second.getByRole('cell', { name: '43', exact: true })).toBeVisible();
  await first.locator('.cm-content').fill(setup.replace('42', '80'));
  await expect(second.getByText('Stale output — run to update')).toBeVisible();
  // Reading the old table must not make an unexecuted setup edit look current.
  await second.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(second.getByText(/Result from run #3/)).toBeVisible();
  await expect(second.getByRole('cell', { name: '43', exact: true })).toBeVisible();
  await expect(second.getByText('Stale output — run to update')).toBeVisible();
  await page.getByRole('button', { name: 'Run changed', exact: true }).click();
  await expect(second.getByRole('cell', { name: '81', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run changed', exact: true })).toBeDisabled();
  await first.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(second.getByText('Stale output — run to update')).toBeVisible();
  await expect(first.getByRole('button', { name: 'Run', exact: true })).toBeVisible();
  await action(page, 'Clear all outputs');
  await second.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(second.getByRole('cell', { name: '81', exact: true })).toBeVisible();
  await action(page, 'Reset session');
  await expect(page.getByText(/Session reset. Temporary tables and outputs cleared/)).toBeVisible();
  await expect(first.locator('.cm-content')).toHaveText(setup.replace('42', '80'));
  await second.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(second.getByRole('alert')).toContainText('totals');
  await page.getByRole('button', { name: 'Run all', exact: true }).click();
  await expect(second.getByRole('cell', { name: '81', exact: true })).toBeVisible();
  await run(second, 'CREATE OR REPLACE TEMP TABLE derived AS SELECT total + 1 AS answer FROM totals');
  await expect(second.getByRole('button', { name: 'Run', exact: true })).toBeVisible();
  const third = await addCell(page);
  await run(third, 'SELECT * FROM derived');
  await expect(third.getByRole('cell', { name: '81', exact: true })).toBeVisible();
  await first.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(second.getByText('Stale output — run to update')).toBeVisible();
  await third.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(third.getByRole('button', { name: 'Run', exact: true })).toBeVisible();
  await expect(third.getByText('Stale output — run to update')).toBeVisible();
  await page.getByRole('button', { name: 'Run changed', exact: true }).click();
  await expect(third.getByText('Stale output — run to update')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Run changed', exact: true })).toBeDisabled();
});

test('switching notebooks closes old sessions while switching workspace tabs keeps them', async ({ page }) => {
  const first = await openNotebook(page);
  await page.getByRole('textbox', { name: 'Notebook title', exact: true }).fill('Notebook A');
  await run(first, 'CREATE OR REPLACE TEMP TABLE shared_name AS SELECT 11 AS n');
  await expect(first.getByRole('cell', { name: '11', exact: true })).toBeVisible();
  await page.getByTestId('tab-editor').click();
  await page.getByTestId('tab-notebooks').click();
  const consumer = await addCell(page);
  await run(consumer, 'SELECT * FROM shared_name');
  await expect(consumer.getByRole('cell', { name: '11', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Notebooks', exact: true }).click();
  await page.getByTestId('notebook-library').getByRole('button', { name: 'New notebook', exact: true }).click();
  await run(first, 'SELECT * FROM temp.main.shared_name');
  await expect(first.getByRole('alert')).toContainText('shared_name');
  await run(first, 'CREATE OR REPLACE TEMP TABLE shared_name AS SELECT 22 AS n');
  await expect(first.getByRole('cell', { name: '22', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Notebooks', exact: true }).click();
  await page.getByTestId('notebook-library').getByRole('button', { name: /^Notebook A/ }).click();
  await consumer.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(consumer.getByRole('alert')).toContainText('shared_name');
  await page.getByRole('button', { name: 'Run all', exact: true }).click();
  await expect(consumer.getByRole('cell', { name: '11', exact: true })).toBeVisible();
  await page.reload();
  await waitForShellBridge(page, 30_000);
  await consumer.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(consumer.getByRole('alert')).toContainText('shared_name');
});

test('parameterized setup and Explain work without permitting writes to stored data', async ({ page }) => {
  const cell = await openNotebook(page);
  await page.getByRole('button', { name: 'Add parameters', exact: true }).click();
  const parameters = page.getByRole('dialog', { name: 'Notebook parameters', exact: true });
  await parameters.getByRole('button', { name: 'Add parameter', exact: true }).click();
  await parameters.getByLabel('Parameter 1 name', { exact: true }).fill('label');
  await parameters.getByLabel('Parameter 1 label', { exact: true }).fill('Label');
  await parameters.getByLabel('Parameter 1 default', { exact: true }).fill("O'Reilly");
  await parameters.getByRole('button', { name: 'Save parameters', exact: true }).click();
  await run(cell, 'CREATE OR REPLACE TEMP TABLE labels AS SELECT $label AS label');
  await expect(cell.getByRole('cell', { name: "O'Reilly", exact: true })).toBeVisible();
  await cell.locator('.cm-content').fill("CREATE OR REPLACE TEMP TABLE labels AS SELECT 'replaced' AS label");
  await cell.getByRole('button', { name: 'Run options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Explain query', exact: true }).click();
  const plan = page.getByRole('dialog', { name: 'Query plan', exact: true });
  await expect(plan).toContainText('physical_plan');
  await plan.press('Escape');
  const second = await addCell(page);
  await run(second, 'SELECT * FROM labels');
  await expect(second.getByRole('cell', { name: "O'Reilly", exact: true })).toBeVisible();
  await run(cell, 'CREATE TABLE memory.main.forbidden_notebook_table AS SELECT 1');
  await expect(cell.getByRole('alert')).toContainText('TEMP TABLE');
  expect((await shellQuery(page, 'SELECT * FROM memory.main.forbidden_notebook_table')).ok).toBe(false);
  await run(cell, 'CREATE OR REPLACE TEMP TABLE labels AS WITH t AS (SELECT 1) DELETE FROM labels');
  await expect(cell.getByRole('alert')).toContainText('one SELECT query');
  await second.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(second.getByText(/Result from run #6/)).toBeVisible();
  await expect(second.getByRole('cell', { name: "O'Reilly", exact: true })).toBeVisible();
});

function stream(tool?: { name: string; input: unknown }) {
  return [
    { type: 'message_start', message: { id: 'sharing', usage: { input_tokens: 100 } } },
    { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: 'sharing-tool', name: tool.name } : { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } : { type: 'text_delta', text: 'The notebook table contains 42.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 30 } },
    { type: 'message_stop' },
  ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

test('the notebook agent knows sharing, reads its session tables and cannot create them through tools', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('vgi-frontend-settings', JSON.stringify({ anthropicApiKey: 'test-key', aiModel: 'claude-sonnet-4-6' })));
  const requests: any[] = [];
  const tools = [
    { name: 'get_notebook', input: {} },
    { name: 'run_sql', input: { sql: 'SELECT n FROM agent_data' } },
    { name: 'run_sql', input: { sql: 'CREATE OR REPLACE TEMP TABLE agent_data AS SELECT 99 AS n' } },
  ];
  await page.route('https://api.anthropic.com/v1/messages', async route => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: stream(tools[requests.length - 1]) });
  });
  const cell = await openNotebook(page);
  await run(cell, 'CREATE OR REPLACE TEMP TABLE agent_data AS SELECT 42 AS n');
  await expect(cell.getByRole('cell', { name: '42', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
  const agent = page.getByRole('complementary', { name: 'Notebook assistant' });
  await agent.getByRole('textbox', { name: 'Chat message input' }).fill('Inspect the shared table');
  await agent.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(agent.getByText('The notebook table contains 42.', { exact: true })).toBeVisible();
  expect(JSON.stringify(requests[0].system)).toContain('CREATE OR REPLACE TEMP TABLE');
  const results = requests.at(-1).messages.flatMap((message: any) => Array.isArray(message.content) ? message.content.filter((block: any) => block.type === 'tool_result').map((block: any) => block.content) : []);
  expect(results).toHaveLength(3);
  expect(results[1]).toContain('42');
  expect(results[1]).not.toMatch(/^Error:/);
  expect(results[2]).toContain('Error:');
  await agent.getByRole('button', { name: 'Close Ask AI panel' }).click();
  const consumer = await addCell(page);
  await run(consumer, 'SELECT n FROM agent_data');
  await expect(consumer.getByRole('cell', { name: '42', exact: true })).toBeVisible();
  await action(page, 'Reset session');
  await expect(page.getByText(/Session reset/)).toBeVisible();
  await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
  await expect(agent.getByText('The notebook table contains 42.', { exact: true })).toHaveCount(0);
});
