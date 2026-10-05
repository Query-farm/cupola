import { test, expect, type Locator, type Page } from '@playwright/test';
import { APP_ORIGIN, BASE, SERVICE_URL, waitForShellBridge } from './helpers';

async function openNotebook(page: Page) {
  await page.goto(`${APP_ORIGIN}${BASE}notebooks?service=${encodeURIComponent(SERVICE_URL)}`);
  await expect(page.getByTestId('notebook-library')).toBeVisible({
    timeout: 30_000,
  });
  await waitForShellBridge(page, 30_000);
  await page.getByRole('button', { name: 'New notebook', exact: true }).click();
  await expect(page.getByTestId('notebook-workspace')).toBeVisible();
}
async function sql(cell: Locator, source: string) {
  const editor = cell.locator('.cm-content');
  await editor.fill(source);
}
const SAMPLE = "SELECT * FROM (VALUES ('Jan', 10), ('Feb', 20)) AS sales(month, revenue)";

test('runs SQL, configures charts without querying, preserves stale results and saves/reopens', async ({
  page,
}) => {
  await openNotebook(page);
  const workspace = page.getByTestId('notebook-workspace');
  await page.getByRole('textbox', { name: 'Notebook title', exact: true }).fill('Revenue investigation');
  const cell = page.getByTestId('notebook-cell').first();
  await sql(cell, SAMPLE);
  await cell.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(cell.getByText(/2 returned rows/)).toBeVisible({
    timeout: 20_000,
  });
  await cell.getByRole('button', { name: '+ Chart', exact: true }).click();
  await expect(cell.getByTestId('notebook-chart').locator('canvas,svg').first()).toBeVisible({
    timeout: 15_000,
  });
  for (const format of ['png', 'svg']) {
    await cell.getByRole('button', { name: 'Download chart', exact: true }).click();
    const downloaded = page.waitForEvent('download');
    await page.getByTestId(`chart-download-${format}`).click();
    expect((await downloaded).suggestedFilename()).toMatch(new RegExp(`\\.${format}$`));
  }
  await cell.getByRole('textbox', { name: 'Chart name', exact: true }).fill('Revenue by month');
  await cell.getByRole('combobox', { name: 'Chart type', exact: true }).click();
  await page.getByRole('option', { name: 'line', exact: true }).click();
  await expect(cell.getByRole('tab', { name: 'Revenue by month' })).toBeVisible();
  await cell.getByRole('tab', { name: 'Revenue by month', exact: true }).focus();
  await cell.getByRole('tab', { name: 'Revenue by month', exact: true }).press('ArrowLeft');
  await expect(cell.getByRole('tab', { name: 'Table', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await cell.getByRole('button', { name: 'Tall', exact: true }).click();
  await expect(cell.getByTestId('notebook-table-viewport')).toHaveCSS('height', '1200px');
  await cell.getByRole('tab', { name: 'Revenue by month', exact: true }).click();
  const ran = await cell.getByText(/2 returned rows/).textContent();
  await cell.getByRole('combobox', { name: 'Chart type', exact: true }).click();
  await page.getByRole('option', { name: 'bar', exact: true }).click();
  expect(await cell.getByText(/2 returned rows/).textContent()).toBe(ran);
  await sql(cell, SAMPLE.replace('revenue)', 'amount)'));
  await expect(cell.getByText('Stale output — run to update')).toBeVisible();
  await cell.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(cell.getByRole('alert')).toContainText('missing column “revenue”');
  await cell.getByRole('combobox', { name: 'Y column', exact: true }).click();
  await page.getByRole('option', { name: 'amount', exact: true }).click();
  await expect(cell.getByTestId('notebook-chart').locator('canvas,svg').first()).toBeVisible();
  await sql(cell, 'select nonexistent from missing_table');
  await cell.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(cell.getByText(/Previous result retained/)).toBeVisible();
  await expect(cell.getByText('Stale output — run to update')).toBeVisible();
  await expect(cell.getByTestId('notebook-chart').locator('canvas,svg').first()).toBeVisible();
  await page.getByRole('button', { name: '+ Markdown cell', exact: true }).click();
  const markdown = page.getByTestId('notebook-cell').last();
  await markdown.getByRole('textbox', { name: 'Markdown source' }).fill('## Findings\nRevenue increased.');
  await markdown.getByRole('button', { name: 'Preview Markdown' }).click();
  await expect(markdown.getByRole('heading', { name: 'Findings' })).toBeVisible();
  await workspace.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(workspace.getByText('Saved in this browser', { exact: true })).toBeVisible();
  await page.getByTestId('tab-editor').click();
  await page.getByTestId('tab-notebooks').click();
  await expect(cell.getByText(/Previous result retained/)).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('notebook-library')).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: /Revenue investigation.*2 cells/ }).click();
  await expect(page.getByRole('textbox', { name: 'Notebook title' })).toHaveValue('Revenue investigation');
  await expect(page.getByTestId('notebook-cell')).toHaveCount(2);
  await expect(page.getByText(/Not run ·/)).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Revenue by month' })).toBeVisible();
  await expect(cell.getByTestId('notebook-table-viewport')).toHaveCSS('height', '1200px');
  await cell.getByRole('button', { name: 'Compact', exact: true }).click();
  await expect(cell.getByTestId('notebook-table-viewport')).toHaveCSS('height', '288px');
});

test('cell operations, undo, run changed and notebook export/import', async ({ page }) => {
  await openNotebook(page);
  const first = page.getByTestId('notebook-cell').first();
  await sql(first, 'select 1 as first_value');
  await first.getByRole('button', { name: 'Duplicate', exact: true }).click();
  const second = page.getByTestId('notebook-cell').nth(1);
  await sql(second, 'select 2 as second_value');
  await second.getByRole('textbox', { name: 'Cell name' }).fill('Second');
  await second.getByRole('button', { name: 'Move cell up' }).click();
  await expect(first.getByRole('textbox', { name: 'Cell name' })).toHaveValue('Second');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(second.getByRole('textbox', { name: 'Cell name' })).toHaveValue('Second');
  await second.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByTestId('notebook-cell')).toHaveCount(1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByTestId('notebook-cell')).toHaveCount(2);
  await page.getByRole('button', { name: 'Run all', exact: true }).click();
  await expect(page.getByText(/1 returned rows/)).toHaveCount(2, {
    timeout: 20_000,
  });
  await expect(page.getByRole('button', { name: 'Run changed' })).toBeDisabled();
  await sql(second, 'select 3 as third_value');
  await page.getByRole('button', { name: 'Run changed' }).click();
  await expect(second.getByText('Stale output — run to update')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Run changed' })).toBeDisabled();
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('notebook-workspace').getByRole('button', { name: 'Export', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.notebook\.json$/);
  const path = await download.path();
  await page.getByRole('button', { name: 'Notebooks', exact: true }).click();
  await page.getByLabel('Import notebook file').setInputFiles(path!);
  await expect(page.getByTestId('notebook-workspace')).toBeVisible();
  await expect(page.getByTestId('notebook-cell')).toHaveCount(2);
  await expect(page.getByText(/Not run ·/)).toHaveCount(2);
});

test('run all stops on errors and cancellation leaves the engine usable', async ({ page }) => {
  await openNotebook(page);
  const first = page.getByTestId('notebook-cell').first();
  await sql(first, 'select * from absent_table');
  await page.getByRole('button', { name: '+ SQL cell', exact: true }).click();
  const second = page.getByTestId('notebook-cell').nth(1);
  await sql(second, 'select 42 as answer');
  await page.getByRole('button', { name: 'Run all', exact: true }).click();
  await expect(first.getByRole('alert')).toContainText('absent_table', {
    timeout: 20_000,
  });
  await expect(second.getByText(/Not run ·/)).toBeVisible();
  await sql(first, 'WITH rows AS (SELECT 1) DELETE FROM absent_table');
  await first.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(first.getByRole('alert')).toContainText('Notebook cells accept one SELECT query');
  // Engine cancellation is also asserted at unit level; this exercises the actual shared worker.
  await sql(first, 'SELECT count(*) FROM cupola_test.edge.slow_rows(100000, 2000)');
  await first.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(first.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  // Let validation finish and a slow server chunk begin; cancelling only the
  // readiness wait would not prove that the worker's active query is interrupted.
  await page.waitForTimeout(2500);
  await first.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(first.getByText('Query cancelled.')).toBeVisible({
    timeout: 10_000,
  });
  await second.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(second.getByText(/1 returned rows/)).toBeVisible({
    timeout: 15_000,
  });
});

test('storage conflicts preserve the other tab’s version and offer export', async ({ page }) => {
  await openNotebook(page);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find((key) => key.startsWith('cupola.notebook.v1:'))!;
    const doc = JSON.parse(localStorage.getItem(key)!);
    doc.title = 'Another tab';
    localStorage.setItem(key, JSON.stringify(doc));
  });
  await page.getByRole('textbox', { name: 'Notebook title' }).fill('My edits');
  await expect(page.getByTestId('notebook-workspace').getByRole('alert')).toContainText('another tab');
  expect(
    await page.evaluate(
      () =>
        JSON.parse(
          localStorage.getItem(
            Object.keys(localStorage).find((key) => key.startsWith('cupola.notebook.v1:'))!,
          )!,
        ).title,
    ),
  ).toBe('Another tab');
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Discard local edits…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Discard unsaved edits?' });
  await expect(dialog.getByRole('button', { name: 'Keep editing' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page.getByRole('textbox', { name: 'Notebook title' })).toHaveValue('My edits');
  await page.getByRole('button', { name: 'Discard local edits…', exact: true }).click();
  await dialog.getByRole('button', { name: 'Discard and return' }).click();
  await expect(
    page.getByTestId('notebook-library').getByRole('button', { name: /Another tab.*1 cells/ }),
  ).toBeVisible();
});

function stream(tool?: { name: string; input: unknown }) {
  return [
    {
      type: 'message_start',
      message: { id: 'mock-notebook', usage: { input_tokens: 100 } },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: tool
        ? { type: 'tool_use', id: 'proposal', name: tool.name }
        : { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: tool
        ? { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) }
        : { type: 'text_delta', text: 'Review the proposed notebook below.' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: tool ? 'tool_use' : 'end_turn' },
      usage: { output_tokens: 30 },
    },
    { type: 'message_stop' },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
}
test('AI stages an editable notebook, applies without executing, and supports undo', async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      'vgi-frontend-settings',
      JSON.stringify({
        anthropicApiKey: 'test-key',
        aiModel: 'claude-sonnet-4-6',
      }),
    ),
  );
  let calls = 0;
  await page.route('https://api.anthropic.com/v1/messages', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body:
        calls++ === 0
          ? stream({
              name: 'propose_notebook_edit',
              input: {
                edit_json: JSON.stringify({
                  summary: 'Add a sample analysis',
                  title: 'AI analysis',
                  cells: [
                    {
                      id: 'ai-sql',
                      type: 'sql',
                      title: 'Sample',
                      source: 'select 42 as answer',
                      collapsed: false,
                      charts: [],
                    },
                    {
                      id: 'ai-note',
                      type: 'markdown',
                      title: 'Explanation',
                      source: 'A sample query.',
                      collapsed: false,
                    },
                  ],
                }),
              },
            })
          : stream(),
    }),
  );
  await openNotebook(page);
  await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
  const agent = page.getByRole('complementary', { name: 'Notebook assistant' });
  await agent.getByRole('textbox', { name: 'Chat message input' }).fill('Add a sample analysis');
  await agent.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(agent.getByRole('button', { name: 'Apply changes' })).toBeEnabled({ timeout: 15_000 });
  await expect(page.getByTestId('notebook-cell')).toHaveCount(1);
  await agent.getByRole('button', { name: 'Apply changes' }).click();
  await expect(page.getByRole('textbox', { name: 'Notebook title' })).toHaveValue('AI analysis');
  await expect(page.getByTestId('notebook-cell')).toHaveCount(2);
  await expect(page.getByText(/Not run ·/)).toBeVisible();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Notebook title' })).toHaveValue('Untitled notebook');
  await expect(page.getByTestId('notebook-cell')).toHaveCount(1);
});

test('AI cannot overwrite edits made while a proposal is being generated', async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      'vgi-frontend-settings',
      JSON.stringify({
        anthropicApiKey: 'test-key',
        aiModel: 'claude-sonnet-4-6',
      }),
    ),
  );
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  await page.route('https://api.anthropic.com/v1/messages', async (route) => {
    const first = calls++ === 0;
    if (first) await ready;
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: first
        ? stream({
            name: 'propose_notebook_edit',
            input: {
              edit_json: JSON.stringify({
                summary: 'AI rename',
                title: 'AI title',
                cells: [],
              }),
            },
          })
        : stream(),
    });
  });
  await openNotebook(page);
  await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
  const agent = page.getByRole('complementary', { name: 'Notebook assistant' });
  await agent.getByRole('textbox', { name: 'Chat message input' }).fill('Rename this notebook');
  await agent.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(agent.getByRole('button', { name: 'Stop generation' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Notebook title', exact: true }).fill('My newer title');
  release();
  await expect(agent.getByText('The notebook has changed. Ask for an updated proposal.')).toBeVisible({
    timeout: 15_000,
  });
  await expect(agent.getByRole('button', { name: 'Stop generation' })).toHaveCount(0);
  await expect(agent.getByRole('button', { name: 'Apply changes' })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: 'Notebook title', exact: true })).toHaveValue(
    'My newer title',
  );
});

test('AI reads the notebook, updates existing SQL and appends Markdown, then persists and undoes', async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      'vgi-frontend-settings',
      JSON.stringify({
        anthropicApiKey: 'test-key',
        aiModel: 'claude-sonnet-4-6',
      }),
    ),
  );
  let calls = 0;
  await page.route('https://api.anthropic.com/v1/messages', async (route) => {
    const call = calls++;
    let body = stream();
    if (call === 0) body = stream({ name: 'get_notebook', input: {} });
    if (call === 1) {
      const messages = route.request().postDataJSON().messages;
      const context = JSON.parse(messages.at(-1).content[0].content);
      body = stream({
        name: 'propose_notebook_edit',
        input: {
          edit_json: JSON.stringify({
            summary: 'Update query and add notes',
            title: context.document.title,
            cells: [
              { ...context.document.cells[0], source: 'select 42 as answer' },
              {
                id: 'appended-notes',
                type: 'markdown',
                title: 'Findings',
                source: '## Answer\nThe answer is 42.',
                collapsed: false,
              },
            ],
          }),
        },
      });
    }
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body,
    });
  });
  await openNotebook(page);
  await sql(page.getByTestId('notebook-cell').first(), 'select 1');
  await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
  const agent = page.getByRole('complementary', { name: 'Notebook assistant' });
  await agent.getByRole('textbox', { name: 'Chat message input' }).fill('Update query and add notes');
  await agent.getByRole('textbox', { name: 'Chat message input' }).press('Enter');
  await expect(agent.getByRole('button', { name: 'Apply changes' })).toBeEnabled({ timeout: 15_000 });
  await agent.getByRole('button', { name: 'Apply changes' }).click();
  await expect(page.getByTestId('notebook-cell')).toHaveCount(2);
  await expect(agent.getByText(/Changes applied · 2 cells/)).toBeVisible();
  await expect(page.getByTestId('notebook-cell').first().locator('.cm-content')).toHaveText(
    'select 42 as answer',
  );
  await expect(page.getByRole('heading', { name: 'Answer', exact: true })).toBeVisible();
  await expect(page.getByText('Saved in this browser', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByTestId('notebook-cell')).toHaveCount(1);
  await expect(page.getByTestId('notebook-cell').first().locator('.cm-content')).toHaveText('select 1');
  const tool = agent.getByTestId('tool-call-details-get_notebook');
  await expect(tool).toContainText('Reading notebook');
  await tool.locator('summary').click();
  await expect(tool.getByText('Result', { exact: true })).toBeVisible();
  await expect(agent.getByTestId('tool-call-details-propose_notebook_edit')).toContainText(
    'Preparing notebook changes',
  );
  await agent.getByRole('button', { name: 'Close Ask AI panel' }).click();
  await expect(agent).toBeHidden();
  await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
  await expect(tool).toBeVisible();
  await agent.getByRole('button', { name: 'New', exact: true }).click();
  await expect(agent.getByTestId('tool-call-details-get_notebook')).toHaveCount(0);
  await expect(agent.getByRole('log')).toContainText('Ask for a new analysis');
  await expect(page.getByTestId('notebook-cell').first().locator('.cm-content')).toHaveText('select 1');
});

test('shared notebook chat supports multiline input and Escape cancellation', async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem('vgi-frontend-settings', JSON.stringify({ anthropicApiKey: 'test-key' })),
  );
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('https://api.anthropic.com/v1/messages', async (route) => {
    await ready;
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: stream() }).catch(() => {});
  });
  await openNotebook(page);
  await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
  const agent = page.getByRole('complementary', { name: 'Notebook assistant' });
  const input = agent.getByRole('textbox', { name: 'Chat message input' });
  await input.fill('Explain this notebook');
  await input.press('Shift+Enter');
  await expect(input).toHaveValue('Explain this notebook\n');
  await expect(agent.getByRole('button', { name: 'Stop generation' })).toHaveCount(0);
  await input.press('Enter');
  await expect(agent.getByRole('button', { name: 'Stop generation' })).toBeVisible();
  await expect(agent.getByRole('status', { name: 'Agent progress' })).toBeVisible();
  await expect(agent.getByRole('button', { name: 'New', exact: true })).toBeDisabled();
  await input.press('Escape');
  await expect(agent.getByRole('alert')).toContainText('Stopped. No proposed changes were applied.');
  await expect(agent.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
  await expect(agent.getByRole('status', { name: 'Agent progress' })).toHaveCount(0);
  await expect(page.getByTestId('notebook-cell')).toHaveCount(1);
  release();
});

test('notebook assistant shares resizing and persists its own width', async ({ page }) => {
  await openNotebook(page);
  await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
  const handle = page.getByRole('separator', { name: 'Resize notebook assistant' });
  const agent = page.getByRole('complementary', { name: 'Notebook assistant' });
  await expect(handle).toHaveAttribute('aria-valuenow', '384');
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 100, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(handle).toHaveAttribute('aria-valuenow', '484');
  await handle.press('ArrowLeft');
  await expect(handle).toHaveAttribute('aria-valuenow', '500');
  await expect(agent).toHaveCSS('width', '500px');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: /Untitled notebook.*1 cells/ }).click();
  await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
  await expect(handle).toHaveAttribute('aria-valuenow', '500');
  expect(await page.evaluate(() => localStorage.getItem('vgi-editor-ai-width'))).toBeNull();
  await page.setViewportSize({ width: 700, height: 1000 });
  await expect(handle).toBeHidden();
  expect(await agent.evaluate((el) => el.getBoundingClientRect().width)).toBeLessThanOrEqual(700);
});

test('notebook deletion uses a dialog with safe initial focus and cancellation', async ({ page }) => {
  await openNotebook(page);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Notebooks', exact: true }).click();
  const library = page.getByTestId('notebook-library');
  await library.getByRole('button', { name: 'Delete', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete notebook?' });
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await dialog.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(library.getByRole('button', { name: /Untitled notebook.*1 cells/ })).toBeVisible();
  await library.getByRole('button', { name: 'Delete', exact: true }).click();
  await dialog.getByRole('button', { name: 'Confirm delete', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(library.getByRole('heading', { name: 'Start an investigation' })).toBeVisible();
});
