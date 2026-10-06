import { useRef, useEffect, useImperativeHandle, useState, type KeyboardEvent, type Ref } from 'react';
import { Paperclip, SendHorizontal, Square } from 'lucide-react';
import { AI_ATTACHMENT_ACCEPT, AI_ATTACHMENT_HELP, validateAttachmentBatch, type AiAttachment } from '../../lib/ai/attachments';
import { useAiAttachments } from '../../lib/ai/use-attachments';
import { AttachmentList } from './AttachmentList';

interface Props {
  onSend: (message: string, attachments: AiAttachment[]) => void;
  onStop?: () => void;
  isLoading?: boolean;
  disabled?: boolean;
  placeholder?: string;
  focused?: boolean;
  queueWhileLoading?: boolean;
  /** Keep unsent text and files separate when the SQL editor switches documents. */
  conversationKey?: string;
  ref?: Ref<ChatInputHandle>;
}

export interface ChatInputHandle {
  restore: (text: string, attachments?: AiAttachment[]) => void;
  clear: () => void;
}

export function ChatInput({ onSend, onStop, isLoading, disabled, placeholder = 'Ask a question about your data...', focused, queueWhileLoading, conversationKey = 'default', ref: handle }: Props) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const files = useAiAttachments(conversationKey);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  const text = texts[conversationKey] ?? '';
  const queueing = Boolean(isLoading && queueWhileLoading);
  const locked = Boolean(disabled || (isLoading && !queueWhileLoading));
  const canSend = !locked && !files.busy && !files.items.some(item => item.error) && Boolean(text.trim() || files.attachments.length);
  const setText = (value: string) => setTexts(previous => ({ ...previous, [conversationKey]: value }));

  useImperativeHandle(handle, () => ({
    restore: (restored: string, attachments: AiAttachment[] = []) => {
      setTexts(previous => {
        const current = previous[conversationKey] ?? '';
        return { ...previous, [conversationKey]: restored ? current.trim() ? `${restored}\n\n${current}` : restored : current };
      });
      files.restore(attachments);
      textarea.current?.focus();
    },
    clear: () => { setText(''); files.clear(); setError(''); },
  }), [conversationKey, files.restore]);

  useEffect(() => { if (focused) textarea.current?.focus(); }, [focused, conversationKey]);
  useEffect(() => { setDragging(false); setError(''); }, [conversationKey]);
  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }, [text]);

  // Drops anywhere within the marked AI panel reach its composer. Catalog/text drags
  // retain their existing behavior.
  useEffect(() => {
    const boundary = root.current?.closest('[data-ai-drop-zone]') ?? root.current;
    if (!boundary) return;
    let depth = 0;
    const isFile = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
    const enter = (event: Event) => { if (isFile(event as DragEvent)) { depth++; if (!locked) setDragging(true); } };
    const leave = () => { if (--depth <= 0) { depth = 0; setDragging(false); } };
    const over = (event: Event) => { const e = event as DragEvent; if (isFile(e)) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = locked ? 'none' : 'copy'; } };
    const drop = (event: Event) => {
      const e = event as DragEvent;
      if (!isFile(e)) return;
      e.preventDefault(); e.stopPropagation(); depth = 0; setDragging(false);
      if (!locked) void files.addFiles(Array.from(e.dataTransfer?.files ?? []));
    };
    boundary.addEventListener('dragenter', enter);
    boundary.addEventListener('dragleave', leave);
    boundary.addEventListener('dragover', over);
    boundary.addEventListener('drop', drop);
    return () => {
      boundary.removeEventListener('dragenter', enter);
      boundary.removeEventListener('dragleave', leave);
      boundary.removeEventListener('dragover', over);
      boundary.removeEventListener('drop', drop);
    };
  }, [locked, files.addFiles]);

  const submit = () => {
    if (!canSend) return;
    try { validateAttachmentBatch(files.attachments); }
    catch (e) { setError((e as Error).message); return; }
    onSend(text.trim(), files.attachments);
    setText(''); files.clear(); setError('');
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); }
    if (event.key === 'Escape' && isLoading) { event.preventDefault(); onStop?.(); }
  };

  return <div ref={root} className={`border-t border-border bg-background px-6 py-3 ${dragging ? 'ring-2 ring-inset ring-primary' : ''}`}>
    <input ref={picker} type="file" accept={AI_ATTACHMENT_ACCEPT} multiple hidden aria-label="Files to attach to AI message" disabled={locked}
      onChange={event => { void files.addFiles(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ''; }} />
    <AttachmentList files={files.items} onRemove={files.remove} />
    {(error || files.error) && <p role="alert" className="mb-2 text-xs text-destructive">{error || files.error}</p>}
    {dragging && <p role="status" className="mb-2 text-xs text-primary">Drop files to attach to your message</p>}
    <div className="flex items-end gap-2 rounded-lg border border-border bg-card px-3 py-1.5 transition-colors focus-within:border-primary/40 focus-within:ring-1 focus-within:ring-primary/20">
      <button type="button" disabled={locked} onClick={() => picker.current?.click()} title={AI_ATTACHMENT_HELP} aria-label="Attach files" className="shrink-0 rounded-md p-2 text-muted-foreground hover:text-primary disabled:opacity-30"><Paperclip aria-hidden="true" className="size-4" /></button>
      <textarea ref={textarea} value={text} onInput={event => setText(event.currentTarget.value)}
        className="max-h-[120px] min-h-[36px] min-w-0 flex-1 resize-none bg-transparent py-1.5 text-sm outline-none placeholder:text-muted-foreground/50"
        placeholder={queueing ? 'Add to the request — the agent reads it after its current step' : placeholder}
        aria-label="Chat message input" rows={1} disabled={disabled} onKeyDown={handleKeyDown}
        onPaste={event => { const pasted = Array.from(event.clipboardData.files); if (pasted.length) { event.preventDefault(); if (!locked) void files.addFiles(pasted); } }} />
      {(!isLoading || (queueing && (text.trim() || files.items.length > 0))) && <button type="button" onClick={submit} disabled={!canSend}
        className="shrink-0 rounded-md bg-primary p-2 text-primary-foreground transition-colors hover:bg-accent disabled:opacity-30"
        title={queueing ? 'Send to the running agent (Enter)' : 'Send (Enter)'} aria-label={queueing ? 'Send message to the running agent' : 'Send message'}><SendHorizontal aria-hidden="true" className="size-4" /></button>}
      {isLoading && <button type="button" onClick={onStop} className="shrink-0 rounded-md bg-destructive/10 p-2 text-destructive transition-colors hover:bg-destructive/20" title="Stop (Escape)" aria-label="Stop generation"><Square aria-hidden="true" className="size-4" /></button>}
    </div>
    <p className="mt-1.5 text-center text-[10px] text-muted-foreground/60">{files.items.length ? 'Files are sent to your AI provider with this message.' : 'Attach or drop files · Enter to send · Shift+Enter for new line'}</p>
  </div>;
}
