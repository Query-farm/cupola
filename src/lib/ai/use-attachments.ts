import { useCallback, useEffect, useReducer, useRef } from 'react';
import { prepareAiAttachment, validateAttachmentBatch, type AiAttachment } from './attachments';

export interface AttachmentItem {
  id: string;
  name: string;
  size: number;
  attachment?: AiAttachment;
  error?: string;
}
interface Draft { items: AttachmentItem[]; error: string }

/** Keep preparation and unsent files with their conversation, including editor tab switches. */
export function useAiAttachments(conversationKey = 'default') {
  const drafts = useRef(new Map<string, Draft>());
  const [, render] = useReducer(value => value + 1, 0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const get = (key: string) => {
    let draft = drafts.current.get(key);
    if (!draft) { draft = { items: [], error: '' }; drafts.current.set(key, draft); }
    return draft;
  };
  const update = () => { if (mounted.current) render(); };
  const addFiles = useCallback(async (files: readonly File[]) => {
    const draft = get(conversationKey);
    if (!files.length) return;
    try { validateAttachmentBatch([...draft.items, ...files]); }
    catch (e) { draft.error = (e as Error).message; update(); return; }
    draft.error = '';
    const items: AttachmentItem[] = files.map(file => ({ id: crypto.randomUUID(), name: file.name, size: file.size }));
    draft.items.push(...items);
    update();
    await Promise.all(files.map(async (file, index) => {
      const item = items[index];
      try { item.attachment = await prepareAiAttachment(file); }
      catch (e) { item.error = e instanceof Error ? e.message : 'This file could not be read.'; }
      update();
    }));
  }, [conversationKey]);
  const draft = get(conversationKey);
  return {
    items: draft.items,
    error: draft.error,
    busy: draft.items.some(item => !item.attachment && !item.error),
    attachments: draft.items.flatMap(item => item.attachment ? [item.attachment] : []),
    addFiles,
    remove: (id: string) => { draft.items = draft.items.filter(item => item.id !== id); draft.error = ''; update(); },
    clear: () => { draft.items = []; draft.error = ''; update(); },
    restore: (files: readonly AiAttachment[]) => {
      const ids = new Set(draft.items.flatMap(item => item.attachment ? [item.attachment.id] : []));
      draft.items = [...files.filter(file => !ids.has(file.id)).map(file => ({ ...file, attachment: file })), ...draft.items];
      update();
    },
  };
}
