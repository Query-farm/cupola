import { test, expect, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { utils, write } from 'xlsx';
import { APP_ORIGIN, BASE, SERVICE_URL, gotoApp, openEditor, openShell, waitForShellBridge } from './helpers';

// Explicit opt-in: these tests make billable requests. Never record browser
// traces, videos, screenshots, or storage state containing the supplied key.
// CUPOLA_AI_LIVE_KEY_FILE=/path/to/key bunx playwright test tests/ai-attachments-live.spec.ts --workers=1
const keyFile = process.env.CUPOLA_AI_LIVE_KEY_FILE;
const model = process.env.CUPOLA_AI_LIVE_MODEL || 'claude-haiku-4-5-20251001';
test.skip(!keyFile, 'Set CUPOLA_AI_LIVE_KEY_FILE to run live Claude attachment tests.');
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.setTimeout(120_000);

type Upload = { name: string; mimeType: string; buffer: Buffer };
type LiveResponse = { status: number; text: string; inputTokens: number; outputTokens: number; tools: string[] };
const observations = new WeakMap<Page, { requests: any[]; responses: Promise<LiveResponse>[] }>();
const token = (label: string) => `${label}-${randomBytes(4).toString('hex')}`;
const csv = (code: string): Upload => ({ name: 'reference.csv', mimeType: 'text/csv', buffer: Buffer.from(`region,verification_code\nEast,${code}`) });

function pdf(code: string): Upload {
  const content = `BT /F1 24 Tf 72 720 Td (Verification code: ${code}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let data = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(data));
    data += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(data);
  data += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return { name: 'reference.pdf', mimeType: 'application/pdf', buffer: Buffer.from(data) };
}

function workbook(format: 'xlsx' | 'xls' | 'ods', codes: string[]): Upload {
  const book = utils.book_new();
  codes.forEach((code, index) => utils.book_append_sheet(book, utils.aoa_to_sheet([['verification_code'], [code]]), `Sheet${index + 1}`));
  return { name: `reference.${format}`, mimeType: 'application/octet-stream', buffer: Buffer.from(write(book, { type: 'buffer', bookType: format })) };
}

async function image(page: Page, format: 'png' | 'jpeg' | 'webp', code: string): Promise<Upload> {
  const data = await page.evaluate(({ format, code }) => {
    const canvas = document.createElement('canvas');
    canvas.width = 700; canvas.height = 160;
    const context = canvas.getContext('2d')!;
    context.fillStyle = 'white'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = 'black'; context.font = 'bold 36px sans-serif'; context.fillText(code, 24, 90);
    return canvas.toDataURL(`image/${format}`).split(',')[1];
  }, { format, code });
  return { name: `reference.${format}`, mimeType: `image/${format}`, buffer: Buffer.from(data, 'base64') };
}

function observe(page: Page) {
  const record = { requests: [] as any[], responses: [] as Promise<LiveResponse>[] };
  observations.set(page, record);
  page.on('request', request => {
    if (request.url() === 'https://api.anthropic.com/v1/messages' && request.method() === 'POST') record.requests.push(request.postDataJSON());
  });
  page.on('response', response => {
    if (response.url() !== 'https://api.anthropic.com/v1/messages' || response.request().method() !== 'POST') return;
    record.responses.push((async () => {
      const body = await response.text();
      let text = '', inputTokens = 0, outputTokens = 0;
      const tools: string[] = [];
      for (const line of body.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const event = JSON.parse(line.slice(6));
        if (event.delta?.type === 'text_delta') text += event.delta.text;
        if (event.type === 'message_start') {
          const usage = event.message.usage;
          inputTokens += (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
        }
        if (event.type === 'message_delta') outputTokens = event.usage?.output_tokens ?? outputTokens;
        if (event.content_block?.type === 'tool_use') tools.push(event.content_block.name);
      }
      return { status: response.status(), text, inputTokens, outputTokens, tools };
    })().catch(() => ({ status: response.status(), text: '', inputTokens: 0, outputTokens: 0, tools: [] })));
  });
  return record;
}

async function drop(panel: Locator, file: Upload) {
  await panel.evaluate((node, file) => {
    const bytes = Uint8Array.from(atob(file.base64), character => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], file.name, { type: file.mimeType }));
    node.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, { name: file.name, mimeType: file.mimeType, base64: file.buffer.toString('base64') });
}

async function send(panel: Locator, text = '') {
  if (text) await panel.getByRole('textbox', { name: 'Chat message input' }).fill(text);
  const button = panel.getByRole('button', { name: 'Send message', exact: true });
  await expect(button).toBeEnabled({ timeout: 20_000 });
  await button.click();
}

async function readCodes(page: Page, panel: Locator, codes: string[], after = 0) {
  const record = observations.get(page)!;
  await expect.poll(() => record.responses.length, { timeout: 60_000 }).toBeGreaterThan(after);
  // A file-only request can legitimately read notebook context before answering.
  // Wait for all tool rounds, rather than checking just the first HTTP response.
  await expect(panel.getByRole('button', { name: 'Stop generation', exact: true })).toHaveCount(0, { timeout: 60_000 });
  const responses = await Promise.all(record.responses.slice(after));
  expect(responses.length).toBeGreaterThan(0);
  for (const response of responses) expect(response.status).toBe(200);
  const text = responses.map(response => response.text).join('\n');
  for (const code of codes) {
    expect(text).toContain(code);
    await expect(panel.getByText(code, { exact: false }).first()).toBeVisible({ timeout: 10_000 });
  }
}

const request = 'Read the uploaded files as reference material. Reply with every verification code found inside them, including each worksheet and image. Copy the codes exactly. Do not use tools or modify anything.';

test.beforeEach(async ({ page }) => {
  const key = readFileSync(keyFile!, 'utf8').trim();
  if (!key) throw new Error('The live API key file is empty.');
  await page.addInitScript(({ key, model }) => {
    localStorage.setItem('vgi-frontend-settings', JSON.stringify({ anthropicApiKey: key, aiModel: model, aiQueryMode: 'unrestricted-sql', aiMaxTokens: 1024, aiMaxToolRounds: 3, aiTelemetry: false }));
    (window as any).__cupolaAiDebug = false;
  }, { key, model });
  observe(page);
});

test.afterEach(async ({ page }, info) => {
  const responses = await Promise.all(observations.get(page)?.responses ?? []);
  console.log(JSON.stringify({ liveTest: info.title, model, status: info.status, requests: responses.length, httpStatuses: responses.map(response => response.status), inputTokens: responses.reduce((sum, response) => sum + response.inputTokens, 0), outputTokens: responses.reduce((sum, response) => sum + response.outputTokens, 0) }));
});

test('live Ask AI reads all document forms and retains attachments in history', async ({ page }) => {
  await gotoApp(page); await waitForShellBridge(page);
  await page.getByTestId('tab-askai').click();
  const panel = page.locator('[data-ai-drop-zone]').filter({ has: page.getByRole('textbox', { name: 'Chat message input' }) });
  const textCodes = ['CSV', 'JSON', 'MARKDOWN', 'SQL', 'UTF16'].map(token);
  const sheetCodes = ['XLSX1', 'XLSX2', 'XLS1', 'XLS2', 'ODS1', 'ODS2'].map(token);
  const pdfCode = token('PDF'), pngCode = token('PNG');
  const files: Upload[] = [
    csv(textCodes[0]),
    { name: 'reference.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ verification_code: textCodes[1] })) },
    { name: 'reference.md', mimeType: 'text/markdown', buffer: Buffer.from(`# Reference\nVerification code: ${textCodes[2]}`) },
    { name: 'reference.sql', mimeType: 'text/plain', buffer: Buffer.from(`-- Verification code: ${textCodes[3]}\nSELECT 42;`) },
    { name: 'utf16.txt', mimeType: 'text/plain', buffer: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`Verification code: ${textCodes[4]}`, 'utf16le')]) },
    workbook('xlsx', sheetCodes.slice(0, 2)), workbook('xls', sheetCodes.slice(2, 4)), workbook('ods', sheetCodes.slice(4, 6)), pdf(pdfCode),
  ];
  await panel.getByLabel('Files to attach to AI message').setInputFiles(files);
  await drop(panel, await image(page, 'png', pngCode));
  await send(panel, request);
  const codes = [...textCodes, ...sheetCodes, pdfCode, pngCode];
  await readCodes(page, panel, codes);
  const record = observations.get(page)!;
  const previous = record.responses.length;
  await send(panel, 'Read the previously attached PDF and both sheets of the previously attached XLSX again. Reply with their three verification codes only, without tools.');
  await readCodes(page, panel, [pdfCode, ...sheetCodes.slice(0, 2)], previous);
  expect(record.requests.at(-1).messages[0].content.filter((block: any) => block.type === 'document')).toHaveLength(9);
});

test('live editor reads JPEG and WebP images and accepts GIF', async ({ page }) => {
  await gotoApp(page); await waitForShellBridge(page); await openEditor(page);
  await page.getByTestId('editor-ask-ai').click();
  const panel = page.getByTestId('editor-ai-panel');
  const codes = ['JPEG', 'WEBP', 'EDITORCSV'].map(token);
  await drop(panel, await image(page, 'jpeg', codes[0]));
  await drop(panel, await image(page, 'webp', codes[1]));
  await panel.getByLabel('Files to attach to AI message').setInputFiles([
    csv(codes[2]),
    { name: 'reference.gif', mimeType: 'image/gif', buffer: Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64') },
  ]);
  await send(panel, request);
  await readCodes(page, panel, codes);
  const images = observations.get(page)!.requests[0].messages.at(-1).content.filter((block: any) => block.type === 'image');
  expect(images.map((block: any) => block.source.media_type).sort()).toEqual(['image/gif', 'image/jpeg', 'image/webp']);
});

test('live notebook reads a file-only request', async ({ page }) => {
  await page.goto(`${APP_ORIGIN}${BASE}notebooks?service=${encodeURIComponent(SERVICE_URL)}`);
  await expect(page.getByTestId('notebook-library')).toBeVisible({ timeout: 30_000 });
  await waitForShellBridge(page, 30_000);
  await page.getByTestId('notebook-library').getByRole('button', { name: 'New notebook', exact: true }).click();
  await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Notebook assistant' });
  const code = token('NOTEBOOK');
  await panel.getByLabel('Files to attach to AI message').setInputFiles(csv(code));
  await send(panel);
  await readCodes(page, panel, [code]);
});

test('live report assistant reads a dropped PDF', async ({ page }) => {
  await page.goto(`${APP_ORIGIN}${BASE}evidence/reports?service=${encodeURIComponent(SERVICE_URL)}`);
  const panel = page.getByTestId('evidence-panel');
  await panel.getByRole('button', { name: 'New report', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Update preview', exact: true })).toBeEnabled({ timeout: 30_000 });
  const code = token('REPORTPDF');
  await drop(panel.locator('[data-ai-drop-zone]'), pdf(code));
  await send(panel, request);
  await readCodes(page, panel, [code]);
});

test('live terminal reads a pasted CSV in its next AI request', async ({ page }) => {
  await gotoApp(page); await waitForShellBridge(page); await openShell(page);
  const code = token('TERMINAL');
  await page.locator('.xterm').evaluate((node, content) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([content], 'reference.csv', { type: 'text/csv' }));
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, csv(code).buffer.toString());
  await expect(page.getByText('reference.csv', { exact: true })).toBeVisible();
  await expect(page.getByText('Preparing…')).toHaveCount(0);
  await page.evaluate(() => (window as any).__bridge.runQuery('.ai'));
  const terminalText = () => page.evaluate(() => {
    const buffer = (window as any).__bridge.shellTerm.buffer.active;
    return Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true) ?? '').join('\n');
  });
  await expect.poll(terminalText).toContain('Entering AI mode');
  await page.evaluate(request => (window as any).__bridge.runQuery(request), request);
  await expect.poll(terminalText, { timeout: 60_000 }).toContain(code);
  const responses = await Promise.all(observations.get(page)!.responses);
  expect(responses.length).toBeGreaterThan(0);
  for (const response of responses) expect(response.status).toBe(200);
  expect(responses.map(response => response.text).join('\n')).toContain(code);
});
