import { useEffect, useState } from 'react';
import { Check, Copy, Link } from 'lucide-react';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import { ReportNotice } from './ReportNotice';
import type { ReportResult } from '../../lib/reporting/contracts.generated';
import { reportLink } from '../../lib/reporting/body';
import { reportError } from '../../lib/reporting/client';

export function WorkerReportSharing({ record, url, pinned, blocked, canPublish, onPublish, onClose }: {
  record: ReportResult; url: string; pinned: boolean; blocked: boolean; canPublish: boolean;
  onPublish: (revision: string | null) => Promise<void>; onClose: () => void;
}) {
  const [specific, setSpecific] = useState(pinned), [copied, setCopied] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [confirmUnpublish, setConfirmUnpublish] = useState(false);
  const link = reportLink(url, record.report_id, specific ? record.revision_served : undefined);
  useEffect(() => { setCopied(false); }, [link]);
  async function publish(revision: string | null) {
    if (blocked || busy) return;
    setBusy(true); setError('');
    try { await onPublish(revision); setConfirmUnpublish(false); } catch (e) { setError(reportError(e)); } finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent className="sm:max-w-lg">
    <DialogHeader><DialogTitle>Share report</DialogTitle><DialogDescription>Share with people who have access to this report library. Copying a link does not change access.</DialogDescription></DialogHeader>
    <section className="space-y-3"><label className="block space-y-1 text-sm"><span>Link to</span><select aria-label="Link to" value={specific ? 'version' : 'latest'} onChange={e => { setSpecific(e.target.value === 'version'); setCopied(false); }} className="w-full rounded border bg-background p-2 [appearance:auto]"><option value="latest">Latest available version</option><option value="version">This version ({String(record.revision_number)})</option></select></label>
      <p className="text-xs text-muted-foreground">{specific ? 'This link stays on the selected saved version.' : 'The library determines which version each recipient can see.'}</p>
      <input aria-label="Report link" readOnly value={link} onFocus={e => e.target.select()} className="w-full rounded border bg-background p-2 text-xs" />
      <Button onClick={async () => { try { await navigator.clipboard.writeText(link); setCopied(true); } catch (e) { setError(reportError(e)); } }}>{copied ? <Check /> : <Copy />}{copied ? 'Link copied' : 'Copy link'}</Button>
    </section>
    {canPublish && <section aria-label="Report publishing" className="space-y-3 border-t pt-4 text-sm"><h3 className="flex items-center gap-2 font-medium"><Link className="size-4" />Publishing</h3>
      <p>{!record.published_revision_id ? 'This report has not been published.' : record.published_revision_id === record.revision_served ? 'This saved version is published.' : 'A different saved version is published.'} Publish a saved version when it is ready for readers. Library permissions still apply.</p>
      {blocked && <ReportNotice title="Changes are pending">Finish saving or resolve pending changes before publishing.</ReportNotice>}
      <div className="flex flex-wrap gap-2"><Button disabled={blocked || busy || record.published_revision_id === record.revision_served} onClick={() => void publish(record.revision_served)}>{busy ? 'Updating…' : pinned ? 'Publish this version' : 'Publish changes'}</Button>
        {record.published_revision_id && <Button variant="ghost" disabled={blocked || busy} onClick={() => setConfirmUnpublish(true)}>Unpublish…</Button>}</div>
      {confirmUnpublish && <ReportNotice title="Remove the published version?" action={<div className="flex gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirmUnpublish(false)}>Cancel</Button><Button size="sm" disabled={blocked || busy} onClick={() => void publish(null)}>Unpublish report</Button></div>}>Saved versions and history remain. People who rely on the published version may lose access.</ReportNotice>}
    </section>}
    {error && <ReportNotice kind="error" title="Could not share or publish">{error}</ReportNotice>}
  </DialogContent></Dialog>;
}
