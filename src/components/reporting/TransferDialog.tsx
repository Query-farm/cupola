import { useEffect, useState } from 'react';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { ReportClient, reportError } from '../../lib/reporting/client';
import type { FolderRecord } from '../../lib/reporting/contracts.generated';
import { locationLabel, type ReportLocation } from '../../lib/reporting/locations';
import { localFolderPath, localLibrary } from '../../lib/reporting/local-library';
import { prepareTransfer, resumeTransfer, type TransferJob, type TransferSource } from '../../lib/reporting/transfers';
import { folderPath } from './ResourceDialog';

const selectClass = 'block w-full min-w-0 rounded-md border border-input bg-background p-2 text-sm [appearance:auto]';
export function TransferDialog({ source, move, locations, scope, serviceUrl, workspaceId, onClose, onComplete }: {
  source: TransferSource; move: boolean; locations: ReportLocation[]; scope: string; serviceUrl: string; workspaceId?: string;
  onClose: () => void; onComplete: (job: TransferJob) => void;
}) {
  const [destination, setDestination] = useState(source.kind === 'worker' ? 'local' : locations.find(l => l.info?.writable)?.url ?? 'local');
  const [folderId, setFolderId] = useState(''), [folders, setFolders] = useState<FolderRecord[]>([]);
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [job, setJob] = useState<TransferJob | null>(null);
  const target = locations.find(l => l.url === destination);
  const localFolders = localLibrary(scope).folders;
  useEffect(() => {
    setFolders([]); setFolderId(''); setError('');
    if (destination === 'local') { setLoading(false); return; }
    const abort = new AbortController(); setLoading(true);
    void new ReportClient(destination).call('list_folders', {}, abort.signal).then(setFolders)
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
      <label className="block text-sm">Save in<select aria-label="Save in" className={selectClass} disabled={busy || Boolean(job)} value={destination} onChange={e => setDestination(e.target.value)}>
        <option value="local">On this device</option>
        {locations.filter(l => l.info).map(l => <option key={l.url} value={l.url}>{locationLabel(l, locations)}{!l.info?.writable ? ' (read-only)' : ''}</option>)}
      </select></label>
      <label className="block text-sm">Destination folder<select aria-label="Destination folder" className={selectClass} value={folderId} disabled={busy || loading || Boolean(job)} onChange={e => setFolderId(e.target.value)}>
        <option value="">Library root{destination !== 'local' && !target?.info?.root_allowed_actions.includes('create_report') ? ' (read-only)' : ''}</option>
        {destination === 'local' ? localFolders.map(f => <option key={f.id} value={f.id}>{localFolderPath(f.id, localFolders)}</option>)
          : folders.filter(f => f.allowed_actions.includes('create_report')).map(f => <option key={f.folder_id} value={f.folder_id}>{folderPath(f, folders)}</option>)}
      </select></label>
      {loading && <p role="status" className="text-sm">Loading folders…</p>}
      {!writable && !loading && <p className="text-sm text-muted-foreground">You cannot save here with your current access. Choose a writable folder or On this device.</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}{job && ' The transfer is saved for retry. Your original is kept until the destination is confirmed.'}</p>}
      <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={onClose}>{job ? 'Close; retry later' : 'Cancel'}</Button><Button type="submit" disabled={busy || loading || !writable}>{busy ? 'Transferring…' : job ? 'Retry transfer' : move ? 'Move report' : 'Copy report'}</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>;
}
