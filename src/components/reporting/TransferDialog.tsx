import { useEffect, useState } from 'react';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { ReportClient, reportError } from '../../lib/reporting/client';
import type { FolderRecord } from '../../lib/reporting/contracts.generated';
import type { ReportLocation } from '../../lib/reporting/locations';
import { prepareTransfer, resumeTransfer, type TransferJob, type TransferSource } from '../../lib/reporting/transfers';
import { ReportStorageTree } from './ReportStorageTree';
import { ReportNotice } from './ReportNotice';

export function TransferDialog({ source, move, locations, scope, serviceUrl, workspaceId, onClose, onComplete }: {
  source: TransferSource; move: boolean; locations: ReportLocation[]; scope: string; serviceUrl: string; workspaceId?: string;
  onClose: () => void; onComplete: (job: TransferJob) => void;
}) {
  const [destination, setDestination] = useState(source.kind === 'worker' ? 'local' : locations.find(l => l.info?.writable)?.url ?? 'local');
  const [folderId, setFolderId] = useState(''), [folders, setFolders] = useState<FolderRecord[]>([]);
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [job, setJob] = useState<TransferJob | null>(null);
  const target = locations.find(l => l.url === destination);
  useEffect(() => {
    setFolders([]); setError('');
    if (destination === 'local') { setLoading(false); return; }
    const abort = new AbortController(); setLoading(true);
    void new ReportClient(destination).call('list_folders', {}, abort.signal).then(rows => { if (!abort.signal.aborted) setFolders(rows); })
      .catch(e => { if (!abort.signal.aborted) setError(reportError(e)); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [destination]);
  const writable = destination === 'local' || Boolean(target?.info?.writable && (folderId ? folders.find(f => f.folder_id === folderId)?.allowed_actions : target.info.root_allowed_actions)?.includes('create_report'));
  const sameStore = source.kind === 'local' ? destination === 'local' : source.url === destination;
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent className="sm:max-w-lg">
    <DialogHeader><DialogTitle>{move ? 'Move report' : 'Copy report'}</DialogTitle><DialogDescription>
      {sameStore && move ? 'Move this report to another folder in this location. Its history stays with it.'
        : move ? 'Save the current definition at the destination, then remove the original after the copy is confirmed. History and publication are not transferred; the destination starts as a private draft with its own owner.'
        : 'Copy the current definition. The original and its history stay here. The destination starts as a private draft with its own owner.'}
    </DialogDescription></DialogHeader>
    <form className="space-y-4" onSubmit={async e => {
      e.preventDefault(); setBusy(true); setError('');
      try {
        const pending = job ?? await prepareTransfer(source, { url: destination === 'local' ? null : destination, folderId: folderId || null, name: destination === 'local' ? 'On this device' : target?.name ?? 'Report storage' }, move, { scope, serviceUrl, workspaceId });
        setJob(pending);
        onComplete(await resumeTransfer(pending));
      } catch (e) { setError(reportError(e)); } finally { setBusy(false); }
    }}>
      <div className="space-y-2"><p className="text-sm font-medium">Save in</p><div className="max-h-72 overflow-auto rounded border p-2"><ReportStorageTree picker locations={locations} scope={scope} location={destination} folderId={folderId || null} disabled={busy || Boolean(job)} onSelect={(url, folder) => { setDestination(url); setFolderId(folder ?? ''); }} /></div></div>
      {loading && <p role="status" className="text-sm">Loading folders…</p>}
      {!writable && !loading && <ReportNotice kind="permission" title="Read-only destination">Choose a writable folder or On this device.</ReportNotice>}
      {error && <ReportNotice kind="error" title="Transfer not confirmed">{error}{job && ' The transfer is saved for retry. Your original is kept until the destination is confirmed.'}</ReportNotice>}
      <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={onClose}>{job ? 'Close; retry later' : 'Cancel'}</Button><Button type="submit" disabled={busy || loading || !writable}>{busy ? 'Transferring…' : job ? 'Retry transfer' : move ? 'Move report' : 'Copy report'}</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>;
}
