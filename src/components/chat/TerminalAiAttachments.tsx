import { useEffect, useRef } from 'react';
import { Paperclip } from 'lucide-react';
import { terminal } from '../../lib/shell-bridge';
import { AI_ATTACHMENT_ACCEPT, AI_ATTACHMENT_HELP, validateAttachmentBatch } from '../../lib/ai/attachments';
import { useAiAttachments } from '../../lib/ai/use-attachments';
import { AttachmentList } from './AttachmentList';

export function TerminalAiAttachments() {
  const files = useAiAttachments();
  const latest = useRef(files); latest.current = files;
  const picker = useRef<HTMLInputElement>(null);
  useEffect(() => {
    terminal.addAiAttachmentFiles = selected => { void latest.current.addFiles(selected); };
    terminal.clearAiAttachments = () => latest.current.clear();
    terminal.takeAiAttachments = () => {
      const draft = latest.current;
      if (draft.busy) throw new Error('Files are still being prepared. Wait for them to finish, then send your request again.');
      if (draft.items.some(item => item.error)) throw new Error('Remove files with errors before sending your AI request.');
      validateAttachmentBatch(draft.attachments);
      const attachments = draft.attachments;
      draft.clear();
      return attachments;
    };
    return () => { terminal.addAiAttachmentFiles = null; terminal.takeAiAttachments = null; terminal.clearAiAttachments = null; };
  }, []);
  return <div className="shrink-0 border-t border-border bg-background px-3 py-2 text-xs text-muted-foreground">
    <div className="flex items-center gap-2"><button type="button" onClick={() => picker.current?.click()} title={AI_ATTACHMENT_HELP} aria-label="Attach files for terminal AI" className="flex shrink-0 items-center gap-1 rounded border px-2 py-1 hover:text-primary"><Paperclip aria-hidden="true" className="size-3.5" />Attach files</button><span>Files go with your next request in <code>.ai</code> mode. Drop files here or in the terminal.</span></div>
    <input ref={picker} type="file" multiple hidden accept={AI_ATTACHMENT_ACCEPT} aria-label="Files to attach to terminal AI" onChange={event => { void files.addFiles(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ''; }} />
    <AttachmentList files={files.items} onRemove={files.remove} />
    {files.error && <p role="alert" className="text-destructive">{files.error}</p>}
  </div>;
}
