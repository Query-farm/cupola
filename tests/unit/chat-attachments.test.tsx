import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { File as NodeFile } from 'node:buffer';
import { ChatInput, type ChatInputHandle } from '../../src/components/chat/ChatInput';
import { ChatMessageUser } from '../../src/components/chat/ChatMessageUser';
import type { AiAttachment } from '../../src/lib/ai/attachments';

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const textFile = (name = 'data.csv', text = 'a,b\n1,2') => new NodeFile([text], name, { type: 'text/csv' }) as unknown as File;
const attachment: AiAttachment = { id: 'restored', name: 'restored.txt', size: 10, block: { type: 'document', title: 'restored.txt', source: { type: 'text', media_type: 'text/plain', data: 'Reference' } } };

describe('attachment composer', () => {
  test('prepares picker files, sends a file-only message, and clears the draft', async () => {
    const sent: { text: string; files: AiAttachment[] }[] = [];
    const ui = render(<ChatInput onSend={(text, files) => sent.push({ text, files })} />);
    fireEvent.change(ui.getByLabelText('Files to attach to AI message'), { target: { files: [textFile()] } });
    await waitFor(() => expect((ui.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(ui.getByRole('button', { name: 'Send message' }));
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe('');
    expect(sent[0].files[0].block.source.data).toBe('a,b\n1,2');
    expect(ui.queryByText('data.csv')).toBeNull();
  });

  test('accepts a drop anywhere inside the AI panel and leaves text drags alone', async () => {
    const ui = render(<div data-ai-drop-zone data-testid="panel"><p>Conversation</p><ChatInput onSend={() => {}} /></div>);
    const transfer = { types: ['Files'], files: [textFile()], dropEffect: '' };
    fireEvent.drop(ui.getByText('Conversation'), { dataTransfer: transfer });
    await waitFor(() => expect(ui.getByText('data.csv')).toBeTruthy());
    expect(fireEvent.dragOver(ui.getByTestId('panel'), { dataTransfer: { types: ['text/plain'] } })).toBe(true);
  });

  test('invalid files block submission until removed', async () => {
    const ui = render(<ChatInput onSend={() => {}} />);
    fireEvent.input(ui.getByRole('textbox'), { target: { value: 'Analyze' } });
    fireEvent.change(ui.getByLabelText('Files to attach to AI message'), { target: { files: [textFile('archive.zip')] } });
    await waitFor(() => expect(ui.getByRole('alert').textContent).toContain('Unsupported'));
    expect((ui.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(ui.getByRole('button', { name: 'Remove archive.zip' }));
    expect((ui.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled).toBe(false);
  });

  test('disabled composers reject dropped files and submission', () => {
    let calls = 0;
    const ui = render(<ChatInput disabled onSend={() => { calls++; }} />);
    fireEvent.drop(ui.getByRole('textbox'), { dataTransfer: { types: ['Files'], files: [textFile()] } });
    fireEvent.click(ui.getByRole('button', { name: 'Send message' }));
    expect(ui.queryByText('data.csv')).toBeNull();
    expect(calls).toBe(0);
  });

  test('restores undelivered queued attachments alongside newer draft text', () => {
    const ref = createRef<ChatInputHandle>();
    const ui = render(<ChatInput ref={ref} onSend={() => {}} />);
    fireEvent.input(ui.getByRole('textbox'), { target: { value: 'Newer text' } });
    act(() => ref.current!.restore('Undelivered request', [attachment]));
    expect((ui.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Undelivered request\n\nNewer text');
    expect(ui.getByText('restored.txt')).toBeTruthy();
    act(() => ref.current!.clear());
    expect((ui.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
    expect(ui.queryByText('restored.txt')).toBeNull();
  });

  test('keeps text and files scoped to each editor document', async () => {
    const ui = render(<ChatInput conversationKey="one" onSend={() => {}} />);
    fireEvent.input(ui.getByRole('textbox'), { target: { value: 'First draft' } });
    await act(async () => {
      fireEvent.change(ui.getByLabelText('Files to attach to AI message'), { target: { files: [textFile()] } });
    });
    expect(ui.queryByText('Preparing…')).toBeNull();
    ui.rerender(<ChatInput conversationKey="two" onSend={() => {}} />);
    expect((ui.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
    expect(ui.queryByText('data.csv')).toBeNull();
    ui.rerender(<ChatInput conversationKey="one" onSend={() => {}} />);
    expect((ui.getByRole('textbox') as HTMLTextAreaElement).value).toBe('First draft');
    expect(ui.getByText('data.csv')).toBeTruthy();
  });

  test('clearing during file preparation cannot reintroduce the removed file', async () => {
    const ref = createRef<ChatInputHandle>();
    let release!: (bytes: ArrayBuffer) => void;
    const file = { name: 'slow.txt', size: 2, type: 'text/plain', arrayBuffer: () => new Promise<ArrayBuffer>(resolve => { release = resolve; }) } as File;
    const ui = render(<ChatInput ref={ref} onSend={() => {}} />);
    fireEvent.change(ui.getByLabelText('Files to attach to AI message'), { target: { files: [file] } });
    expect(ui.getByText('Preparing…')).toBeTruthy();
    act(() => ref.current!.clear());
    await act(async () => { release(new Uint8Array([104, 105]).buffer); });
    expect(ui.queryByText('slow.txt')).toBeNull();
  });

  test('queued file-only messages keep Stop available', () => {
    const ref = createRef<ChatInputHandle>();
    let delivered: AiAttachment[] = [];
    const ui = render(<ChatInput ref={ref} isLoading queueWhileLoading onSend={(_, files) => { delivered = files; }} />);
    act(() => ref.current!.restore('', [attachment]));
    expect(ui.getByRole('button', { name: 'Stop generation' })).toBeTruthy();
    fireEvent.click(ui.getByRole('button', { name: 'Send message to the running agent' }));
    expect(delivered).toEqual([attachment]);
  });

  test('sent messages show attachment names without revealing extracted contents', () => {
    const ui = render(<ChatMessageUser content="Analyze" attachments={[attachment]} />);
    expect(ui.getByText('restored.txt')).toBeTruthy();
    expect(ui.queryByText('Reference')).toBeNull();
  });
});
