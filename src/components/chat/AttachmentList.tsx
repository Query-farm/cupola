import { FileText, Loader2, X } from 'lucide-react';
import type { AttachmentSummary } from '../../lib/ai/attachments';
import type { AttachmentItem } from '../../lib/ai/use-attachments';

export function AttachmentList({ files, onRemove }: { files: readonly (AttachmentSummary | AttachmentItem)[]; onRemove?: (id: string) => void }) {
  if (!files.length) return null;
  return <ul aria-label="Attached files" className="flex flex-wrap gap-2 py-2">
    {files.map(file => {
      const pending = onRemove && !('attachment' in file && file.attachment) && !('error' in file && file.error);
      const error = 'error' in file ? file.error : undefined;
      return <li key={file.id} className={`flex min-w-0 max-w-full items-center gap-2 rounded-md border px-2 py-1 text-xs ${error ? 'border-destructive/40 text-destructive' : 'border-current/20'}`}>
        {pending ? <Loader2 aria-hidden="true" className="size-3.5 shrink-0 animate-spin" /> : <FileText aria-hidden="true" className="size-3.5 shrink-0" />}
        <span className="min-w-0"><span className="block truncate" title={file.name}>{file.name}</span><span className="block opacity-70" role={error ? 'alert' : undefined}>{error || (pending ? 'Preparing…' : file.size < 1024 * 1024 ? `${Math.ceil(file.size / 1024)} KB` : `${(file.size / (1024 * 1024)).toFixed(1)} MB`)}</span></span>
        {onRemove && <button type="button" onClick={() => onRemove(file.id)} aria-label={`Remove ${file.name}`} className="shrink-0 rounded p-1 hover:bg-muted"><X aria-hidden="true" className="size-3.5" /></button>}
      </li>;
    })}
  </ul>;
}
