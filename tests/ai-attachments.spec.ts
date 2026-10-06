import { test, expect, type Locator, type Page } from '@playwright/test';
import { APP_ORIGIN, BASE, SERVICE_URL, gotoApp, openEditor, openShell, waitForShellBridge } from './helpers';

const reference = { name: 'reference.csv', mimeType: 'text/csv', buffer: Buffer.from('region,revenue\nEast,42') };
function response() {
  const events = [
    { type: 'message_start', message: { id: 'attachment-test', usage: { input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Attachment received.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ];
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}
async function mock(page: Page, failFirst = false) {
  const requests: any[] = [];
  await page.route('https://api.anthropic.com/v1/messages', async route => {
    requests.push(route.request().postDataJSON());
    if (failFirst && requests.length === 1) await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Test interruption' } }) });
    else await route.fulfill({ status: 200, contentType: 'text/event-stream', body: response() });
  });
  return requests;
}
async function attachAndSend(panel: Locator) {
  await panel.getByLabel('Files to attach to AI message').setInputFiles(reference);
  await expect(panel.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: 'Send message', exact: true }).click();
}
function expectReference(request: any) {
  const documents = request.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []).filter((block: any) => block.type === 'document');
  expect(documents).toContainEqual({ type: 'document', title: 'reference.csv', source: { type: 'text', media_type: 'text/plain', data: 'region,revenue\nEast,42' } });
}
async function terminalText(page: Page) {
  return page.evaluate(() => {
    const buffer = (window as any).__bridge.shellTerm.buffer.active;
    return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) ?? '').join('\n');
  });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('vgi-frontend-settings', JSON.stringify({ anthropicApiKey: 'test-key-not-real', aiModel: 'claude-sonnet-4-6', aiQueryMode: 'unrestricted-sql', aiTelemetry: false })));
});

for (const surface of ['Ask AI', 'editor'] as const) {
  test(`${surface} sends native images and reference files dropped into the panel`, async ({ page }) => {
    const requests = await mock(page);
    await gotoApp(page); await waitForShellBridge(page);
    let panel: Locator;
    if (surface === 'editor') { await openEditor(page); await page.getByTestId('editor-ask-ai').click(); panel = page.getByTestId('editor-ai-panel'); }
    else { await page.getByTestId('tab-askai').click(); panel = page.locator('[data-ai-drop-zone]').filter({ has: page.getByRole('textbox', { name: 'Chat message input' }) }); }
    const png = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 2; return canvas.toDataURL('image/png').split(',')[1]; });
    await panel.evaluate((node, base64) => {
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
      const transfer = new DataTransfer(); transfer.items.add(new File([bytes], 'chart.png', { type: 'image/png' }));
      node.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    }, png);
    await attachAndSend(panel);
    await expect(panel.getByText('Attachment received.', { exact: true })).toBeVisible();
    expectReference(requests[0]);
    expect(requests[0].messages.at(-1).content).toContainEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } });
    await expect(panel.getByText('chart.png', { exact: true })).toHaveCount(1);
    await expect(panel.getByText('reference.csv', { exact: true })).toHaveCount(1);
  });
}

test('notebook assistant sends file-only requests', async ({ page }) => {
  const requests = await mock(page);
  await page.goto(`${APP_ORIGIN}${BASE}notebooks?service=${encodeURIComponent(SERVICE_URL)}`);
  await expect(page.getByTestId('notebook-library')).toBeVisible({ timeout: 30_000 });
  await waitForShellBridge(page, 30_000);
  await page.getByTestId('notebook-library').getByRole('button', { name: 'New notebook', exact: true }).click();
  await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Notebook assistant' });
  await attachAndSend(panel);
  await expect(panel.getByText('Attachment received.', { exact: true })).toBeVisible();
  expectReference(requests[0]);
});

test('report assistant retains the file when retrying an interrupted request', async ({ page }) => {
  const requests = await mock(page, true);
  await page.goto(`${APP_ORIGIN}${BASE}evidence/reports?service=${encodeURIComponent(SERVICE_URL)}`);
  const panel = page.getByTestId('evidence-panel');
  await panel.getByRole('button', { name: 'New report', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Update preview', exact: true })).toBeEnabled({ timeout: 30_000 });
  await attachAndSend(panel);
  await panel.getByRole('button', { name: 'Retry request', exact: true }).click();
  await expect(panel.getByText('Attachment received.', { exact: true })).toBeVisible();
  expectReference(requests[0]); expectReference(requests[1]);
  await expect(panel.getByText('reference.csv', { exact: true })).toHaveCount(1);
});

test('terminal attaches the draft to its next AI request', async ({ page }) => {
  const requests = await mock(page);
  await gotoApp(page); await waitForShellBridge(page); await openShell(page);
  await page.getByLabel('Files to attach to terminal AI').setInputFiles(reference);
  await expect(page.getByText('Preparing…')).toHaveCount(0);
  await page.evaluate(() => (window as any).__bridge.runQuery('.ai'));
  await expect.poll(() => terminalText(page), { timeout: 15_000 }).toContain('Entering AI mode');
  await page.evaluate(() => (window as any).__bridge.runQuery('Analyze the attached file'));
  await expect.poll(() => requests.length).toBe(1);
  expectReference(requests[0]);
  await expect.poll(() => terminalText(page)).toContain('Attachment received.');
});
