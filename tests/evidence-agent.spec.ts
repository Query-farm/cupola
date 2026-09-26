import { evidencePath } from './helpers';
import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 1500, height: 1100 } });
function stream(tool?: { name: string; input: unknown }) {
  const events = [
    { type: 'message_start', message: { id: 'mock-message', usage: { input_tokens: 100 } } },
    { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: `tool-${tool.name}`, name: tool.name } : { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } : { type: 'text_delta', text: 'Review the proposed changes below.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 50 } },
    { type: 'message_stop' },
  ];
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

test('report agent grounds tools, reviews edits, protects newer drafts and shares the preview engine', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem('vgi-frontend-settings', JSON.stringify({ anthropicApiKey: 'test-key-not-real', aiModel: 'claude-sonnet-4-6' }));
  });
  const requests: any[] = [];
  const source = '# Agent weather overview\n\n```sql summary\nSELECT 24 AS temperature\n```\n\n{% table data="summary" /%}\n';
  await page.route('https://api.anthropic.com/v1/messages', async route => {
    const body = route.request().postDataJSON(); requests.push(body);
    const count = requests.length;
    let tool;
    if (count === 1) tool = { name: 'list_components', input: {} };
    if (count === 2) tool = { name: 'get_component', input: { name: 'table' } };
    if (count === 3 || count === 5 || count === 7) tool = { name: 'propose_report_edit', input: { summary: 'Add a concise temperature overview', changes: { title: 'Agent overview', source } } };
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: stream(tool) });
  });
  await page.goto(evidencePath('evidence/reports'));
  const panel = page.getByTestId('evidence-panel');
  await panel.getByRole('button', { name: 'New report', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Update preview', exact: true })).toBeEnabled({ timeout: 90_000 });
  await page.evaluate(() => { (window as any).__agentWorker = (window as any).__bridge.worker; });
  await expect(panel.getByRole('tab', { name: 'Chat', exact: true })).toHaveAttribute('aria-selected', 'true');
  await panel.getByRole('tab', { name: 'Code', exact: true }).click();
  const original = await panel.getByRole('textbox', { name: 'Evidence source', exact: true }).innerText();
  await panel.getByRole('tab', { name: 'Chat', exact: true }).click();
  const input = panel.getByRole('textbox', { name: 'Chat message input' });
  await input.fill('Add a temperature overview'); await input.press('Enter');
  const review = panel.getByRole('log').getByRole('region', { name: 'Proposed report changes' }).last();
  await expect(review).toBeVisible({ timeout: 30_000 });
  await expect(review.getByRole('button', { name: 'Apply and preview' })).toBeEnabled();
  expect(requests[0].tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(['get_report', 'list_components', 'get_component', 'propose_report_edit', 'compile_semantic_query', 'list_catalogs']));
  const referenceResult = requests[2].messages.at(-1).content[0].content;
  expect(referenceResult).toContain('attributes');
  expect(referenceResult).toContain('examples');
  expect(referenceResult).toContain('data');
  // Proposals do not mutate the source; code and AI tabs retain the conversation.
  await panel.getByRole('tab', { name: 'Code', exact: true }).click();
  await expect(panel.getByRole('textbox', { name: 'Evidence source', exact: true })).toHaveText(original, { useInnerText: true });
  await panel.getByRole('textbox', { name: 'Report title' }).fill('Manual edit');
  await panel.getByRole('tab', { name: 'Chat', exact: true }).click();
  await expect(review).toContainText('Your draft changed');
  await expect(review.getByRole('button', { name: 'Apply and preview' })).toBeDisabled();
  await review.getByRole('button', { name: 'Discard', exact: true }).click();
  await input.fill('Revise against my current draft'); await input.press('Enter');
  await expect(review.getByRole('button', { name: 'Apply and preview' })).toBeEnabled();
  expect(JSON.stringify(requests[4].messages)).toContain('Manual edit');
  await review.getByRole('button', { name: 'Apply and preview' }).click();
  await expect(panel.getByRole('textbox', { name: 'Report title' })).toHaveValue('Agent overview');
  await expect(review).toContainText('Applied to draft');
  await expect(panel.getByTestId('evidence-document')).toContainText('Agent weather overview', { timeout: 30_000 });
  await expect(panel.getByTestId('evidence-document')).toContainText('24');
  await panel.getByRole('button', { name: 'View report', exact: true }).click();
  await panel.getByRole('button', { name: 'Edit report', exact: true }).click();
  await expect(panel.getByRole('log')).toContainText('Revise against my current draft');
  await input.fill('undo that change'); await input.press('Enter');
  await expect(panel.getByRole('log')).toContainText('Undone. I restored the previous draft');
  await expect(panel.getByTestId('evidence-document')).toContainText('My report', { timeout: 30_000 });
  expect(requests).toHaveLength(6);
  await expect(panel.getByRole('textbox', { name: 'Report title' })).toHaveValue('Manual edit');
  await input.fill('Try that edit again'); await input.press('Enter');
  await expect(review.getByRole('button', { name: 'Apply and preview' })).toBeEnabled();
  await review.getByRole('button', { name: 'Discard', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__agentWorker === (window as any).__bridge.worker)).toBe(true);
  expect(errors).toEqual([]);
});

test('agent explains missing credentials without issuing a request', async ({ page }) => {
  let requests = 0;
  await page.route('https://api.anthropic.com/v1/messages', route => { requests++; return route.abort(); });
  await page.goto(evidencePath('evidence/reports'));
  const panel = page.getByTestId('evidence-panel');
  await panel.getByRole('button', { name: 'New report', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Update preview', exact: true })).toBeEnabled({ timeout: 90_000 });
  await panel.getByRole('tab', { name: 'Chat', exact: true }).click();
  await panel.getByRole('textbox', { name: 'Chat message input' }).fill('Improve this');
  await panel.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('Anthropic API key');
  expect(requests).toBe(0);
});

test('stopping an agent request leaves the draft and shared engine intact; API failures are visible', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('vgi-frontend-settings', JSON.stringify({ anthropicApiKey: 'test-key-not-real', aiModel: 'claude-sonnet-4-6' })));
  let release: () => void = () => {};
  let requested = false;
  await page.route('https://api.anthropic.com/v1/messages', async route => {
    requested = true;
    await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { type: 'authentication_error', message: 'Invalid test API key' } }) }).catch(() => {});
  });
  await page.goto(evidencePath('evidence/reports'));
  const panel = page.getByTestId('evidence-panel');
  await panel.getByRole('button', { name: 'New report', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Update preview', exact: true })).toBeEnabled({ timeout: 90_000 });
  await panel.getByRole('tab', { name: 'Chat', exact: true }).click();
  const input = panel.getByRole('textbox', { name: 'Chat message input' });
  await input.fill('Rewrite this report'); await input.press('Enter');
  await expect.poll(() => requested).toBe(true);
  await panel.getByRole('button', { name: 'Stop generation' }).click();
  release();
  await expect(panel.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
  await expect(panel).toContainText('Generation stopped');
  await expect(panel.getByRole('textbox', { name: 'Report title' })).toHaveValue('Untitled report');
  await page.unroute('https://api.anthropic.com/v1/messages');
  await page.route('https://api.anthropic.com/v1/messages', route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { type: 'authentication_error', message: 'Invalid test API key' } }) }));
  await input.fill('Try again'); await input.press('Enter');
  await expect(panel.getByRole('alert')).toContainText(/401|Invalid.*API key|authentication/i);
  await expect(panel.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
});

test('asking about a pending proposal keeps it available in the conversation', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('vgi-frontend-settings', JSON.stringify({ anthropicApiKey: 'test-key-not-real', aiModel: 'claude-sonnet-4-6' })));
  let requests = 0;
  await page.route('https://api.anthropic.com/v1/messages', route => {
    requests++;
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body: stream(requests === 1 ? { name: 'propose_report_edit', input: { summary: 'Rename the report', changes: { title: 'Weather briefing' } } } : undefined) });
  });
  await page.goto(evidencePath('evidence/reports'));
  const panel = page.getByTestId('evidence-panel');
  await panel.getByRole('button', { name: 'New report', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Update preview', exact: true })).toBeEnabled({ timeout: 90_000 });
  const input = panel.getByRole('textbox', { name: 'Chat message input' });
  await input.fill('Rename the report'); await input.press('Enter');
  const proposal = panel.getByRole('log').getByRole('region', { name: 'Proposed report changes' });
  await expect(proposal.getByRole('button', { name: 'Apply and preview' })).toBeEnabled();
  await input.fill('Why did you choose that title?'); await input.press('Enter');
  await expect.poll(() => requests).toBe(3);
  await expect(proposal.getByRole('button', { name: 'Apply and preview' })).toBeEnabled();
  await expect(proposal).not.toContainText('Replaced by');
  await expect(panel.getByRole('log')).toContainText('Why did you choose that title?');
  await expect(panel.getByRole('textbox', { name: 'Report title' })).toHaveValue('Untitled report');
});

test('slow and interrupted requests show progress and can retry without losing the conversation', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('vgi-frontend-settings', JSON.stringify({ anthropicApiKey: 'test-key-not-real', aiModel: 'claude-sonnet-4-6' })));
  const requests: any[] = [];
  let release: () => void = () => {};
  await page.route('https://api.anthropic.com/v1/messages', async route => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) {
      await new Promise<void>(resolve => { release = resolve; });
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: stream().split('event: message_delta')[0] });
    }
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body: stream(requests.length === 2 ? { name: 'propose_report_edit', input: { summary: 'Rename report', changes: { title: 'Retry succeeded' } } } : undefined) });
  });
  await page.goto(evidencePath('evidence/reports'));
  const panel = page.getByTestId('evidence-panel');
  await panel.getByRole('button', { name: 'New report', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Update preview', exact: true })).toBeEnabled({ timeout: 90_000 });
  const input = panel.getByRole('textbox', { name: 'Chat message input' });
  await input.fill('Please rename this report'); await input.press('Enter');
  await expect.poll(() => requests.length).toBe(1);
  const progress = panel.getByRole('status', { name: 'Agent progress' });
  await expect(progress).toContainText('Waiting for the AI service');
  await expect(progress).toContainText('unchanged until you apply');
  await expect(progress).toContainText(/\d+s/);
  await expect(progress.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
  release();
  const error = panel.getByRole('alert');
  await expect(error).toContainText('connection to the AI service was interrupted');
  await expect(error).toContainText('has not applied any changes');
  await expect(panel.getByRole('log')).toContainText('Review the proposed changes below.');
  await panel.getByRole('textbox', { name: 'Report title' }).fill('Manual update before retry');
  await error.getByRole('button', { name: 'Retry request' }).click();
  const proposal = panel.getByRole('region', { name: 'Proposed report changes' });
  await expect(proposal.getByRole('button', { name: 'Apply and preview' })).toBeEnabled();
  expect(JSON.stringify(requests[1].messages)).toContain('Manual update before retry');
  expect(requests[1].messages.filter((m: any) => m.role === 'user')).toHaveLength(1);
  await expect(panel.getByRole('log').getByText('Please rename this report', { exact: true })).toHaveCount(1);
  await expect(panel.getByTestId('tool-call-details-propose_report_edit')).toBeVisible();
  await expect(panel.getByRole('textbox', { name: 'Report title' })).toHaveValue('Manual update before retry');
  await expect(panel.getByRole('alert')).toHaveCount(0);
});

test('keep-alives distinguish a live connection from waiting for output and stopping offers retry', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('vgi-frontend-settings', JSON.stringify({ anthropicApiKey: 'test-key-not-real', aiModel: 'claude-sonnet-4-6' }));
    const realFetch = window.fetch;
    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== 'https://api.anthropic.com/v1/messages') return realFetch(input, init);
      const encoder = new TextEncoder();
      const body = new ReadableStream({ start(controller) {
        const emit = (value: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
        emit({ type: 'message_start', message: { usage: { input_tokens: 1 } } });
        emit({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } });
        const timer = setInterval(() => emit({ type: 'ping' }), 10_000);
        init?.signal?.addEventListener('abort', () => { clearInterval(timer); controller.error(new DOMException('Aborted', 'AbortError')); });
      } });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof window.fetch;
  });
  await page.goto(evidencePath('evidence/reports'));
  const panel = page.getByTestId('evidence-panel');
  await panel.getByRole('button', { name: 'New report', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Update preview', exact: true })).toBeEnabled({ timeout: 90_000 });
  await page.clock.install();
  const input = panel.getByRole('textbox', { name: 'Chat message input' });
  await input.fill('Improve the layout'); await input.press('Enter');
  const progress = panel.getByRole('status', { name: 'Agent progress' });
  await expect(progress).toContainText('AI is processing');
  await page.clock.runFor(31_000);
  await expect(progress).toContainText('Connection active');
  await expect(progress).toContainText('taking longer than usual');
  await expect(progress).toContainText('No reply or proposed edit');
  await panel.getByRole('button', { name: 'Stop generation' }).click();
  await expect(panel.getByRole('button', { name: 'Retry request' })).toBeEnabled();
  await expect(panel.getByRole('textbox', { name: 'Report title' })).toHaveValue('Untitled report');
});
