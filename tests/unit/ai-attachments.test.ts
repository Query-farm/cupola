import { describe, expect, test } from 'bun:test';
import { utils, write } from 'xlsx';
import { attachmentSummaries, MAX_AI_REQUEST_BYTES, MAX_ATTACHMENT_BYTES, prepareAiAttachment, queuedMessageContent, serializeAiRequest, userMessageContent, validateAttachmentBatch, type AiAttachment } from '../../src/lib/ai/attachments';
import { sanitizeConversation } from '../../src/lib/ai-history';
import { serializeInputMessages } from '../../src/lib/ai-telemetry';
import { pruneCarriedToolImages } from '../../src/lib/query-results';
import type { MessageParam } from '../../src/lib/ai-agent';

const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='), ch => ch.charCodeAt(0));

describe('AI attachments', () => {
  test('text/data files become named document blocks with complete content', async () => {
    const file = await prepareAiAttachment(new File(['region,revenue\nEast,42'], 'sales.csv', { type: 'text/csv' }));
    expect(file.block).toEqual({ type: 'document', title: 'sales.csv', source: { type: 'text', media_type: 'text/plain', data: 'region,revenue\nEast,42' } });
    expect(attachmentSummaries([file])).toEqual([{ id: file.id, name: 'sales.csv', size: file.size }]);
    expect(JSON.stringify(attachmentSummaries([file]))).not.toContain('East');
  });

  test('supports UTF-16 text with a BOM', async () => {
    const file = await prepareAiAttachment(new File([new Uint8Array([255, 254, 104, 0, 105, 0])], 'notes.txt'));
    expect(file.block.source.data).toBe('hi');
  });

  test('PNG and PDF bytes pass through losslessly as native content blocks', async () => {
    const image = await prepareAiAttachment(new File([png], 'chart.png'));
    const pdf = await prepareAiAttachment(new File(['%PDF-1.7\nexample'], 'guide.pdf'));
    expect(image.block.type).toBe('image');
    expect(image.block.source.media_type).toBe('image/png');
    expect(atob(image.block.source.data)).toBe(String.fromCharCode(...png));
    expect(pdf.block.type).toBe('document');
    expect(atob(pdf.block.source.data)).toBe('%PDF-1.7\nexample');
  });

  test('reads every workbook sheet as labeled CSV', async () => {
    const book = utils.book_new();
    utils.book_append_sheet(book, utils.aoa_to_sheet([['Region', 'Revenue'], ['East', 42]]), 'Sales');
    utils.book_append_sheet(book, utils.aoa_to_sheet([['Cost'], [12]]), 'Costs');
    const file = await prepareAiAttachment(new File([write(book, { type: 'array', bookType: 'xlsx' })], 'budget.xlsx'));
    expect(file.block.source.data).toContain('Sheet: Sales\nRegion,Revenue\nEast,42');
    expect(file.block.source.data).toContain('Sheet: Costs\nCost\n12');
  });

  test('rejects oversized workbook sheets rather than silently truncating', async () => {
    const book = utils.book_new();
    utils.book_append_sheet(book, utils.aoa_to_sheet(Array.from({ length: 10_002 }, (_, i) => [i])), 'Large');
    expect(prepareAiAttachment(new File([write(book, { type: 'array', bookType: 'xlsx' })], 'large.xlsx'))).rejects.toThrow('10,000 rows');
  });

  test('rejects unsupported, empty, mislabeled, binary, and oversized content', async () => {
    expect(prepareAiAttachment(new File(['content'], 'archive.zip'))).rejects.toThrow('Unsupported');
    expect(prepareAiAttachment(new File([], 'empty.txt'))).rejects.toThrow('empty');
    expect(prepareAiAttachment(new File(['not an image'], 'image.png'))).rejects.toThrow('image format');
    expect(prepareAiAttachment(new File(['not a PDF'], 'file.pdf'))).rejects.toThrow('valid PDF');
    expect(prepareAiAttachment(new File([new Uint8Array([0, 1, 2])], 'binary.txt'))).rejects.toThrow('binary');
    expect(prepareAiAttachment(new File([new Uint8Array([255])], 'invalid.txt'))).rejects.toThrow('valid UTF');
    expect(prepareAiAttachment(new File(['x'.repeat(200_001)], 'long.txt'))).rejects.toThrow('200,000');
    expect(prepareAiAttachment(new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], 'large.pdf'))).rejects.toThrow('10 MB');
  });

  test('limits file count and combined bytes', () => {
    expect(() => validateAttachmentBatch(Array.from({ length: 11 }, () => ({ size: 1 })))).toThrow('10 files');
    expect(() => validateAttachmentBatch([{ size: MAX_ATTACHMENT_BYTES }, { size: MAX_ATTACHMENT_BYTES }, { size: 1 }])).toThrow('20 MB');
  });

  test('request limits count encoded UTF-8 bytes and include history', () => {
    expect(serializeAiRequest({ messages: ['hello'] })).toBe('{"messages":["hello"]}');
    expect(() => serializeAiRequest({ messages: ['é'.repeat(MAX_AI_REQUEST_BYTES / 2)] })).toThrow('new conversation');
  });

  test('keeps attachments through history repair, follow-ups, and chart-image pruning', async () => {
    const document = await prepareAiAttachment(new File(['reference'], 'guide.md'));
    const image = await prepareAiAttachment(new File([png], 'diagram.png'));
    const messages: MessageParam[] = [
      { role: 'user', content: 'Earlier request' },
      { role: 'user', content: userMessageContent('Use these', [document, image]) },
    ];
    sanitizeConversation(messages);
    pruneCarriedToolImages(messages);
    expect(messages).toHaveLength(1);
    const blocks = messages[0].content;
    expect(blocks).toContainEqual(document.block);
    expect(blocks).toContainEqual(image.block);
    expect((blocks as any[]).at(-1).text).toBe('Use these');
    expect(queuedMessageContent([{ text: 'Also use this', attachments: [image] }])).toContainEqual(image.block);
    expect(userMessageContent('Plain text')).toBe('Plain text');
  });

  test('telemetry elides all attachment payloads, including extracted text', () => {
    const files: AiAttachment[] = [
      { id: '1', name: 'private.txt', size: 10, block: { type: 'document', title: 'private.txt', source: { type: 'text', media_type: 'text/plain', data: 'PRIVATE_TEXT_CONTENT' } } },
      { id: '2', name: 'private.pdf', size: 10, block: { type: 'document', title: 'private.pdf', source: { type: 'base64', media_type: 'application/pdf', data: 'PRIVATE_PDF_CONTENT' } } },
      { id: '3', name: 'private.png', size: 10, block: { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'PRIVATE_IMAGE_CONTENT' } } },
    ];
    const telemetry = serializeInputMessages([{ role: 'user', content: userMessageContent('Analyze these', files) }]);
    expect(telemetry).not.toContain('PRIVATE_');
    expect(telemetry).toContain('contents elided');
    expect(telemetry).toContain('Analyze these');
  });
});
