import { useEffect, useState } from 'react';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { ReportClient, reportError } from '../../lib/reporting/client';
import { MutationJournal } from '../../lib/reporting/journal';
import { documentKind } from '../../lib/reporting/object-adapter';
import type { ReportSummary, ReportRow } from '../../lib/reporting/contracts.generated';

/** Sidebar deletion uses the same durable journal as the worker's contents page. */
export function DeleteWorkerDocumentDialog({ url, record, libraryName, onClose, onDeleted }: {
  url: string; record: ReportSummary | ReportRow; libraryName: string; onClose: () => void; onDeleted: (authScope: string) => void;
}) {
  const [journal, setJournal] = useState<MutationJournal | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const kind = documentKind(record);
  useEffect(() => {
    let cancelled = false;
    const client = new ReportClient(url);
    void client.recoveryScope().then(scope => {
      if (!cancelled) setJournal(new MutationJournal(client, scope, 'library'));
    }).catch(e => { if (!cancelled) setError(reportError(e)); });
    return () => { cancelled = true; };
  }, [url]);
  const pending = journal?.pending;
  const retry = pending?.method === 'delete_report' && pending.input.report_id === record.report_id;
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent>
    <DialogHeader><DialogTitle>Delete {kind}?</DialogTitle><DialogDescription>
      Delete “{('title' in record ? record.title : record.envelope?.title) ?? 'this document'}” from {libraryName}?
      {kind !== 'report' && ' Open editor drafts will stay on this device.'}
    </DialogDescription></DialogHeader>
    <form className="space-y-4" onSubmit={async event => {
      event.preventDefault(); if (!journal || busy || pending && !retry) return;
      setBusy(true); setError('');
      try {
        if (retry) await journal.retry();
        else await journal.run('delete_report', { report_id: record.report_id, expected_version: record.version });
        onDeleted(journal.scope);
      } catch (e) { setError(reportError(e)); } finally { setBusy(false); }
    }}>
      {pending && <p role="status" className="text-sm">{retry ? 'Deletion is not confirmed. Retry checks the original request without deleting another version.' : 'Another library change is awaiting confirmation. Open this worker’s library to resolve it first.'}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter><Button variant="outline" type="button" disabled={busy} onClick={onClose}>{pending ? 'Close' : 'Cancel'}</Button><Button variant="destructive" type="submit" disabled={busy || !journal || Boolean(pending && !retry)}>{busy ? 'Deleting…' : retry ? 'Retry delete' : 'Delete'}</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>;
}
