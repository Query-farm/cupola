import { useEffect, useState } from 'react';
import { ArrowLeft, History, Link, Download } from 'lucide-react';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import { EvidenceWorkspace } from '../evidence/EvidenceWorkspace';
import { decodeReport, encodeReport, publicParameters, reportLink } from '../../lib/reporting/body';
import { reportError } from '../../lib/reporting/client';
import { SaveController, type RecoveryDraft, type SaveState } from '../../lib/reporting/save-controller';
import type { FolderRecord, ReportResult, RevisionRow } from '../../lib/reporting/contracts.generated';
import type { EvidenceReport } from '../../lib/evidence/reports';
import { downloadDocumentFile } from '../../lib/saved-document-actions';
import { ResourceDialog, type ResourceAction, type ResourceValues } from './ResourceDialog';
import type { LibrarySession } from './ReportLibrary';
import type { ReportingWorkspaceProps } from './ReportingWorkspace';

interface OpenReport { record: ReportResult; report?: EvidenceReport; controller?: SaveController; bodyError?: string }
export function RemoteReport(props: ReportingWorkspaceProps & { session: LibrarySession; reportId: string; revisionId: string | null; recovery?: { key: string; value: RecoveryDraft }; onLeave: () => void; onOpen: (id: string) => void }) {
  const { session, reportId, revisionId, recovery } = props;
  const [opened, setOpened] = useState<OpenReport | null>(null), [save, setSave] = useState<SaveState | null>(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [generation, setGeneration] = useState(0), [editorGeneration, setEditorGeneration] = useState(0);
  const [folders, setFolders] = useState<FolderRecord[]>([]), [revisions, setRevisions] = useState<RevisionRow[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false), [shareOpen, setShareOpen] = useState(false), [sourceOpen, setSourceOpen] = useState(false);
  const [dialog, setDialog] = useState<{ action: ResourceAction; revision?: RevisionRow } | null>(null);
  useEffect(() => {
    const abort = new AbortController(); let controller: SaveController | undefined;
    setLoading(true); setError(''); setOpened(null); setSave(null);
    void session.client.call('get_report', { report_id: reportId, revision_id: revisionId }, abort.signal).then(record => {
      if (abort.signal.aborted) return;
      let report: EvidenceReport;
      try { report = decodeReport(record, props.serviceUrl, props.workspaceId); }
      catch (e) { setOpened({ record, bodyError: reportError(e) }); return; }
      const canEdit = session.info.writable && !revisionId && record.allowed_actions.includes('edit');
      if (canEdit) {
        controller = new SaveController(session.client, session.scope, record, report, session.info, recovery);
        controller.onChange = setSave; setSave(controller.state);
        if (recovery) report = controller.current.report;
      }
      setOpened({ record, report, controller });
    }).catch(e => { if (!abort.signal.aborted) setError(reportError(e)); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => { abort.abort(); controller?.dispose(); };
  }, [session.client, reportId, revisionId, generation]);
  const record = save?.record ?? opened?.record;
  const controller = opened?.controller;
  const pending = controller?.dirty ?? false;
  const managementPending = Boolean(session.journal.pending);
  const blocked = busy || pending || managementPending;
  const can = (action: string) => Boolean(session.info.writable && record?.allowed_actions.includes(action));
  useEffect(() => {
    if (!record) return;
    const abort = new AbortController();
    void Promise.all([session.client.call('list_revisions', { report_id: reportId }, abort.signal), session.client.call('list_folders', {}, abort.signal)])
      .then(([history, folders]) => { if (!abort.signal.aborted) { setRevisions(history); setFolders(folders); } })
      .catch(e => { if (!abort.signal.aborted) setError(reportError(e)); });
    return () => abort.abort();
  }, [session.client, reportId, record?.version]);
  async function attempt(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); } catch (e) { setError(reportError(e)); } finally { setBusy(false); }
  }
  async function refreshRecord() {
    const next = await session.client.call('get_report', { report_id: reportId, revision_id: revisionId });
    if (controller) controller.updateRecord(next); else setOpened(old => old ? { ...old, record: next } : null);
  }
  async function copy(report: EvidenceReport) {
    const { envelope, body } = encodeReport({ ...report, title: `${report.title} (copy)` }, controller?.current.metadata ?? { description: record?.envelope?.description ?? '', tags: record?.envelope?.tags ?? [], dataSources: record?.envelope?.data_sources ?? [] }, session.info);
    const result = await session.journal.run('create_report', { envelope, body, folder_id: null, message: `Copied from ${reportId}` });
    props.onOpen(result.report_id);
  }
  async function apply(values: ResourceValues) {
    if (!record) return;
    if (dialog?.action === 'metadata' && controller && opened?.report) {
      const next = { ...controller.current.report, title: values.name };
      controller.capture(next, { description: values.description, tags: values.tags });
      controller.stage(next, { kind: 'edit', label: 'Updated report details' });
      setOpened({ ...opened, report: next }); setEditorGeneration(n => n + 1); return;
    }
    const base = { report_id: reportId, expected_version: record.version };
    if (dialog?.action === 'move') await session.journal.run('move_report', { ...base, folder_id: values.folderId });
    else if (dialog?.action === 'ownership') { await session.journal.run('set_ownership', { ...base, ownership: values.ownership }); props.onLeave(); return; }
    else if (dialog?.action === 'delete') { await session.journal.run('delete_report', base); props.onLeave(); return; }
    else if (dialog?.action === 'redact' && dialog.revision) await session.journal.run('redact_revision', { ...base, revision_id: dialog.revision.revision_id, reason: values.reason });
    await refreshRecord();
  }
  async function restore(revision: RevisionRow) {
    if (!controller || !opened) return;
    const old = await session.client.call('get_report', { report_id: reportId, revision_id: revision.revision_id });
    const report = decodeReport(old, props.serviceUrl, props.workspaceId);
    controller.capture(report, { description: old.envelope?.description ?? '', tags: old.envelope?.tags ?? [], dataSources: old.envelope?.data_sources ?? [] });
    controller.stage(report, { kind: 'restore', label: `Restored revision ${revision.revision_number}` });
    setOpened({ ...opened, report }); setEditorGeneration(n => n + 1); setHistoryOpen(false);
  }
  function downloadBody() {
    if (!record?.body) return;
    const url = URL.createObjectURL(new Blob([record.body.slice().buffer], { type: 'application/octet-stream' }));
    const a = document.createElement('a'); a.href = url; a.download = `${reportId}-${record.revision_served}.bin`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const historyContent = <div className="space-y-3 py-3 text-sm"><p className="text-muted-foreground">Worker revisions are immutable. Restoring creates a new revision; redaction leaves an audit entry.</p>{revisions.map(revision => <article key={revision.revision_id} className="space-y-2 rounded border p-3">
    <div className="flex flex-wrap items-center gap-2"><strong>Revision {String(revision.revision_number)}</strong><span>{revision.kind}</span>{record?.head_revision_id === revision.revision_id && <span>· current head</span>}{record?.published_revision_id === revision.revision_id && <span>· published</span>}</div>
    <p className="text-xs text-muted-foreground">{revision.author.display_name || revision.author.id} · {new Date(revision.created_at).toLocaleString()}</p>
    <p>{revision.message}</p>
    {revision.redacted_at ? <p>Redacted: {revision.redaction_reason}</p> : <div className="flex flex-wrap gap-2">
      {controller && <Button size="sm" variant="outline" disabled={blocked || revision.revision_id === record?.head_revision_id} onClick={() => void attempt(() => restore(revision))}>Restore revision {String(revision.revision_number)}</Button>}
      <Button size="sm" variant="ghost" onClick={() => void attempt(async () => { await navigator.clipboard.writeText(reportLink(session.client.url, reportId, revision.revision_id)); setNotice('Revision link copied. Recipients need worker access.'); })}>Copy revision link</Button>
      {can('redact') && <Button size="sm" variant="ghost" disabled={blocked || revision.revision_id === record?.head_revision_id || revision.revision_id === record?.published_revision_id} onClick={() => setDialog({ action: 'redact', revision })}>Redact revision {String(revision.revision_number)}…</Button>}
    </div>}
  </article>)}</div>;
  return <section className="flex h-full min-h-0 flex-col" aria-label="Worker report">
    <header className="flex shrink-0 flex-wrap items-center gap-2 border-b px-5 py-2 text-sm">
      <Button variant="ghost" size="sm" onClick={props.onLeave}><ArrowLeft />Library</Button><span className="text-muted-foreground">Saved in {session.info.display_name}</span>
      {record && <><span>Revision {String(record.revision_number)}{revisionId ? ' · pinned view' : ''} · {record.published_revision_id ? 'Published' : 'Unpublished'}</span>
        {opened?.report && <Button variant="ghost" size="sm" onClick={() => setSourceOpen(true)}>View source</Button>}
        {revisionId && <Button variant="ghost" size="sm" onClick={() => props.onOpen(reportId)}>Open current report</Button>}
        <Button variant="outline" size="sm" onClick={() => setHistoryOpen(true)}><History />History</Button>
        <Button variant="outline" size="sm" onClick={() => setShareOpen(true)}><Link />Share link</Button>
        {controller && <Button variant="ghost" size="sm" disabled={blocked} onClick={() => setDialog({ action: 'metadata' })}>Report details</Button>}
        {can('publish') && <><Button variant="outline" size="sm" disabled={blocked || record.published_revision_id === record.revision_served} onClick={() => void attempt(async () => { await session.journal.run('publish', { report_id: reportId, revision_id: record.revision_served, expected_published_revision_id: record.published_revision_id }); await refreshRecord(); })}>Publish revision</Button>{record.published_revision_id && <Button variant="ghost" size="sm" disabled={blocked} onClick={() => void attempt(async () => { await session.journal.run('publish', { report_id: reportId, revision_id: null, expected_published_revision_id: record.published_revision_id }); await refreshRecord(); })}>Unpublish</Button>}</>}
        {props.onTransferReport && !record.redacted && <Button variant="outline" size="sm" disabled={blocked} onClick={() => props.onTransferReport?.({ kind: 'worker', url: session.client.url, record }, false)}>Copy to…</Button>}{props.onTransferReport && !revisionId && can('delete') && <Button variant="outline" size="sm" disabled={blocked} onClick={() => props.onTransferReport?.({ kind: 'worker', url: session.client.url, record }, true)}>Move to…</Button>}
        {can('move') && <Button variant="ghost" size="sm" disabled={blocked} onClick={() => setDialog({ action: 'move' })}>Move</Button>}
        {can('transfer_ownership') && <Button variant="ghost" size="sm" disabled={blocked} onClick={() => setDialog({ action: 'ownership' })}>Ownership</Button>}
        {can('delete') && <Button variant="ghost" size="sm" disabled={blocked} onClick={() => setDialog({ action: 'delete' })}>Delete</Button>}
      </>}
    </header>
    {loading && <p role="status" className="p-5">Opening worker report…</p>}
    {error && <div role="alert" className="flex flex-wrap items-center gap-3 p-3 text-sm text-destructive"><span>{error}</span><Button variant="outline" disabled={busy} onClick={() => { if (!pending || confirm('Your draft will remain in recovery. Load the current worker version?')) setGeneration(n => n + 1); }}>Reload from worker</Button></div>}
    {notice && <p role="status" className="px-5 py-2 text-sm">{notice}</p>}
    {managementPending && <div className="flex flex-wrap items-center gap-2 border-b p-3 text-sm"><p>A management change is awaiting confirmation.</p><Button disabled={busy} onClick={() => void attempt(async () => { const method = session.journal.pending?.method; await session.journal.retry(); if (method === 'delete_report' || method === 'set_ownership') props.onLeave(); else await refreshRecord(); })}>Retry pending change</Button><Button variant="ghost" onClick={props.onLeave}>Review in library</Button></div>}
    {controller && (save?.status === 'error' || save?.status === 'conflict') && <div className="space-y-2 border-b border-amber-400 bg-amber-50/30 p-3 text-sm dark:bg-amber-950/20" role="alert">
      <p>{save.message}</p><p>Your draft is kept on this device. Reloading retains it under the library’s recovery drafts.</p>
      <div className="flex flex-wrap gap-2"><Button disabled={busy || save.status === 'conflict'} onClick={() => void controller.retry()}>Retry save</Button><Button variant="outline" disabled={busy} onClick={() => setGeneration(n => n + 1)}>Load latest from worker</Button><Button variant="outline" disabled={busy || managementPending || !session.info.root_allowed_actions.includes('create_report')} onClick={() => void attempt(() => copy(controller.current.report))}>Save draft as a copy</Button><Button variant="ghost" onClick={() => downloadDocumentFile(JSON.stringify(controller.current.report, null, 2), 'report-draft.json')}>Export draft</Button></div>
    </div>}
    {opened?.bodyError && <div className="space-y-3 p-5"><p role="alert">{opened.bodyError}</p>{record?.body && <Button variant="outline" onClick={downloadBody}><Download />Download original body</Button>}</div>}
    {opened?.report && <div className="min-h-0 flex-1"><EvidenceWorkspace key={editorGeneration} {...props} remote={{
      report: opened.report, canEdit: Boolean(controller), status: controller ? save?.message ?? 'Saved to worker' : 'Read-only worker revision', pending,
      onDraft: report => controller?.capture(report), onSave: (report, meta) => controller?.stage(report, meta),
      onLeave: props.onLeave, onCopy: report => void attempt(() => copy(report)), historyContent,
    }} /></div>}
    {record && <div className="shrink-0 border-t px-5 py-2 text-xs text-muted-foreground">Owner: {record.ownership.owner_ref.kind} / {record.ownership.owner_ref.display_name || record.ownership.owner_ref.id}{record.ownership.parent_owner_ref && <> · Parent: {record.ownership.parent_owner_ref.kind} / {record.ownership.parent_owner_ref.display_name || record.ownership.parent_owner_ref.id}</>} · Author: {record.created_by.display_name || record.created_by.id}</div>}
    <Dialog open={sourceOpen} onOpenChange={setSourceOpen}><DialogContent className="max-h-[85vh] overflow-auto sm:max-w-3xl"><DialogHeader><DialogTitle>Report source</DialogTitle><DialogDescription>Source inspection does not execute queries.</DialogDescription></DialogHeader><h3>Setup SQL</h3><pre className="overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">{opened?.report?.setupSql || "No setup SQL"}</pre><h3>Document</h3><pre className="overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">{opened?.report?.source}</pre></DialogContent></Dialog>
    <Dialog open={historyOpen} onOpenChange={setHistoryOpen}><DialogContent className="max-h-[85vh] overflow-auto sm:max-w-2xl"><DialogHeader><DialogTitle>Report history</DialogTitle><DialogDescription>History visible to your account on this worker.</DialogDescription></DialogHeader>{historyContent}</DialogContent></Dialog>
    <Dialog open={shareOpen} onOpenChange={setShareOpen}><DialogContent className="sm:max-w-xl"><DialogHeader><DialogTitle>Share report link</DialogTitle><DialogDescription>Recipients use their own worker and data access. This link contains no credentials. Publication and folder access follow the worker’s policy.</DialogDescription></DialogHeader><input className="w-full rounded border bg-background p-2 text-xs" aria-label="Report link" readOnly value={reportLink(session.client.url, reportId, revisionId ?? undefined)} onFocus={e => e.target.select()} /><Button onClick={() => void attempt(async () => { await navigator.clipboard.writeText(reportLink(session.client.url, reportId, revisionId ?? undefined)); setNotice('Report link copied.'); setShareOpen(false); })}>Copy link</Button></DialogContent></Dialog>
    {dialog && record && <ResourceDialog {...dialog} resource={record} folders={folders} libraryName={session.info.display_name} rootActions={session.info.root_allowed_actions} writable={session.info.writable} onClose={() => setDialog(null)} onApply={apply} />}
    {opened?.report && publicParameters(opened.report).localControls.length > 0 && <p className="shrink-0 px-5 py-1 text-xs text-muted-foreground">Cupola-only controls: {publicParameters(opened.report).localControls.join(', ')}. Their definitions are preserved in the report body; they are not exposed as protocol parameters.</p>}
  </section>;
}
