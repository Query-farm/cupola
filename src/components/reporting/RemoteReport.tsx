import { resetDocumentDraft, documentDraftScope, documentBinding } from '../../lib/reporting/documents';
import { LibraryDocumentOpener } from './LibraryDocumentOpener';
import { documentKind } from '../../lib/reporting/object-adapter';
import { documentLink, portableBody, portableContext } from '../../lib/reporting/documents';
import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from '../ui/button';
import { ReportPage, useReportPage } from './ReportPage';
import { EvidenceWorkspace } from '../evidence/EvidenceWorkspace';
import { decodeReport, encodeReport, reportLink } from '../../lib/reporting/body';
import { reportError } from '../../lib/reporting/client';
import { SaveController, type RecoveryDraft, type SaveState } from '../../lib/reporting/save-controller';
import type { FolderRecord, ReportResult, RevisionRow } from '../../lib/reporting/contracts.generated';
import type { EvidenceReport } from '../../lib/evidence/reports';
import { downloadDocumentFile } from '../../lib/saved-document-actions';
import { ResourceDialog, folderPath, type ResourceAction, type ResourceValues } from './ResourceDialog';
import type { LibrarySession } from './ReportLibrary';
import type { ReportingWorkspaceProps } from './ReportingWorkspace';
import { WorkerReportHistory } from './WorkerReportHistory';
import { ReportHeader } from './ReportHeader';
import { reportAction, type ReportAction } from './ReportActionMenu';
import { ReportDetailsPage } from './ReportDetailsPage';
import { WorkerReportSharing } from './WorkerReportSharing';
import { ReportSchedulesPage } from './ReportSchedulesPage';
import { OwnershipPage } from './OwnershipPage';
import { useTransferSource } from '../../lib/reporting/transfer-source';

interface OpenReport { recoveryOnly?: boolean; record: ReportResult; report?: EvidenceReport; controller?: SaveController; bodyError?: string }
export function RemoteReport(props: ReportingWorkspaceProps & { session: LibrarySession; reportId: string; revisionId: string | null; recovery?: { key: string; value: RecoveryDraft }; onLeave: () => void; onOpen: (id: string, revisionId?: string) => void }) {
  const { session, reportId, revisionId, recovery } = props;
  const [opened, setOpened] = useState<OpenReport | null>(null), [save, setSave] = useState<SaveState | null>(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [documentDirty, setDocumentDirty] = useState(false);
  useEffect(() => {
    const changed = (event: Event) => { const detail = (event as CustomEvent).detail; if (detail.url === session.client.url && detail.id === reportId) { setDocumentDirty(detail.dirty); setOpened(previous => previous && detail.record.revision_number >= previous.record.revision_number && detail.record.version >= previous.record.version ? { ...previous, record: detail.record } : previous); } };
    const newer = (event: Event) => { const detail = (event as CustomEvent).detail; if (detail.url === session.client.url && detail.record.report_id === reportId) setOpened(previous => previous ? { ...previous, record: detail.record } : previous); };
    window.addEventListener("cupola:document-edit-state", changed); window.addEventListener('cupola:document-newer-version', newer);
    window.dispatchEvent(new Event('cupola:request-document-edit-state'));
    return () => { window.removeEventListener("cupola:document-edit-state", changed); window.removeEventListener('cupola:document-newer-version', newer); };
  }, [session.client.url, reportId]);
  const [generation, setGeneration] = useState(0), [editorGeneration, setEditorGeneration] = useState(0);
  const [folders, setFolders] = useState<FolderRecord[]>([]), [revisions, setRevisions] = useState<RevisionRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true), [historyError, setHistoryError] = useState(''), [historyReload, setHistoryReload] = useState(0);
  const [page, showPage] = useReportPage();
  const [dialog, setDialog] = useState<{ action: ResourceAction; revision?: RevisionRow } | null>(null);
  useEffect(() => {
    const abort = new AbortController(); let controller: SaveController | undefined;
    setLoading(true); setError(''); setOpened(null); setSave(null);
    void session.client.call('get_report', { report_id: reportId, revision_id: revisionId }, abort.signal).then(record => {
      if (abort.signal.aborted) return;
      if (['query', 'notebook'].includes(documentKind(record))) { setOpened({ record }); return; }
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
    }).catch(e => { if (!abort.signal.aborted) {
      setError(reportError(e));
      for (const kind of ['query', 'notebook'] as const) {
        let recovered;
        try { recovered = documentBinding(documentDraftScope(session.client.url, reportId, revisionId, session.scope), kind, reportId); } catch { continue; }
        if (recovered) { setOpened({ record: { ...recovered.record, allowed_actions: [] }, recoveryOnly: true }); setNotice('Local recovery draft. Save a copy on this device or in a library where you have access.'); break; }
      }
    } }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => { abort.abort(); controller?.dispose(); };
  }, [session.client, reportId, revisionId, generation]);
  const record = save?.record ?? opened?.record;
  const controller = opened?.controller;
  const pending = (controller?.dirty ?? false) || documentDirty;
  const managementPending = Boolean(session.journal.pending);
  const blocked = busy || pending || managementPending;
  useTransferSource(props.workspaceId ?? props.serviceUrl, session.client.url, reportId, () => {
    if (blocked || controller?.dirty || !record) throw new Error('Finish saving this report and resolve any pending changes before moving it.');
    if (revisionId) throw new Error('Open the current version of this report before moving it.');
    return { kind: 'worker', url: session.client.url, record };
  });
  const can = (action: string) => Boolean(session.info.writable && record?.allowed_actions.includes(action));
  useEffect(() => {
    if (!record) return;
    const abort = new AbortController();
    setHistoryLoading(true); setHistoryError('');
    void session.client.call('list_revisions', { report_id: reportId }, abort.signal)
      .then(history => { if (!abort.signal.aborted) setRevisions(history); })
      .catch(e => { if (!abort.signal.aborted) { setRevisions([]); setHistoryError(reportError(e)); } })
      .finally(() => { if (!abort.signal.aborted) setHistoryLoading(false); });
    void session.client.call('list_folders', {}, abort.signal)
      .then(folders => { if (!abort.signal.aborted) setFolders(folders); })
      .catch(e => { if (!abort.signal.aborted) setError(reportError(e)); });
    return () => abort.abort();
  }, [session.client, reportId, record?.version, historyReload]);
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
    else if (dialog?.action === 'delete') { await session.journal.run('delete_report', base); props.onLeave(); return; }
    else if (dialog?.action === 'redact' && dialog.revision) await session.journal.run('redact_revision', { ...base, revision_id: dialog.revision.revision_id, reason: values.reason });
    await refreshRecord();
  }
  async function restore(revision: RevisionRow) {
    if (!opened) return;
    const old = await session.client.call('get_report', { report_id: reportId, revision_id: revision.revision_id });
    if (!controller) {
      if (!record || !old.envelope || !old.body) throw new Error('This revision cannot be restored.');
      await session.journal.run('commit_revision', { report_id: reportId, expected_revision_id: record.head_revision_id, envelope: old.envelope, body: old.body, kind: 'restore', message: `Restored revision ${revision.revision_number}` });
      resetDocumentDraft(session.client.url, reportId, documentKind(record) as 'query' | 'notebook', session.scope); showPage(null); setGeneration(n => n + 1); return;
    }
    const report = decodeReport(old, props.serviceUrl, props.workspaceId);
    controller.capture(report, { description: old.envelope?.description ?? '', tags: old.envelope?.tags ?? [], dataSources: old.envelope?.data_sources ?? [] });
    controller.stage(report, { kind: 'restore', label: `Restored revision ${revision.revision_number}` });
    showPage(null); setOpened({ ...opened, report }); setEditorGeneration(n => n + 1);
  }
  function downloadBody() {
    if (!record?.body) return;
    const url = URL.createObjectURL(new Blob([record.body.slice().buffer], { type: 'application/octet-stream' }));
    const a = document.createElement('a'); a.href = url; a.download = `${reportId}-${record.revision_served}.bin`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const historyContent = <WorkerReportHistory client={session.client} reportId={reportId} revisions={revisions} headId={record?.head_revision_id} publishedId={record?.published_revision_id} pinnedId={revisionId}
    blocked={blocked} loading={historyLoading} error={historyError} onRetry={() => setHistoryReload(n => n + 1)}
    onView={id => { if (!blocked) props.onOpen(reportId, id); }}
    onCopyLink={revision => void attempt(async () => { await navigator.clipboard.writeText(reportLink(session.client.url, reportId, revision.revision_id)); setNotice('Revision link copied. Recipients need worker access.'); })}
    onRestore={controller || (can('edit') && record && documentKind(record) !== 'report') ? revision => void attempt(() => restore(revision)) : undefined}
    onRedact={can('redact') ? revision => setDialog({ action: 'redact', revision }) : undefined} />;
  const reportFolder = folders.find(f => f.folder_id === record?.folder_id);
  const reportLocation = [session.info.display_name, reportFolder ? folderPath(reportFolder, folders) : record?.folder_id ? 'Folder' : ''].filter(Boolean).join(' / ');
  const reportActions: ReportAction[] = record ? [
    ...(!opened?.report ? [reportAction('history', () => { setHistoryReload(n => n + 1); showPage('history'); })] : []),
    ...(!opened?.report && record.body ? [{ ...reportAction('export', downloadBody), label: 'Download original document' }] : []),
    reportAction('details', () => showPage('details')),
    ...(!record.redacted && documentKind(record) === 'report' ? [reportAction('schedules', () => showPage('schedules'), blocked)] : []),
    ...(can('transfer_ownership') ? [reportAction('ownership', () => showPage('ownership'), blocked)] : []),
    ...(props.onTransferReport && !record.redacted ? [...(documentKind(record) === 'report' ? [reportAction('copy', () => props.onTransferReport?.({ kind: 'worker', url: session.client.url, record }, false), blocked)] : []),
      ...(!revisionId && (can('move') || can('delete')) ? [reportAction('move', () => props.onTransferReport?.({ kind: 'worker', url: session.client.url, record }, true), blocked)] : [])] : []),
    ...(can('delete') ? [reportAction('delete', () => setDialog({ action: 'delete' }), blocked)] : []),
  ] : [];
  return <section className="flex h-full min-h-0 flex-col" aria-label="Worker report">
    {!opened?.report && !page && (!record || record.redacted || opened?.bodyError || !['query', 'notebook'].includes(documentKind(record))) && <ReportHeader title={record?.envelope?.title ?? 'Opening document…'} location={reportLocation} onBack={props.onLeave} actions={reportActions}>{record && <Button size="sm" variant="outline" onClick={() => showPage('share')}>Share</Button>}</ReportHeader>}
    {loading && <p role="status" className="p-5">Opening worker report…</p>}
    {error && <div role="alert" className="flex flex-wrap items-center gap-3 p-3 text-sm text-destructive"><span>{error}</span><Button variant="outline" disabled={busy} onClick={() => { if (!pending || confirm('Your draft will remain in recovery. Load the current worker version?')) setGeneration(n => n + 1); }}>Reload from worker</Button></div>}
    {notice && <p role="status" className="px-5 py-2 text-sm">{notice}</p>}
    {managementPending && <div className="flex flex-wrap items-center gap-2 border-b p-3 text-sm"><p>A management change is awaiting confirmation.</p><Button disabled={busy} onClick={() => void attempt(async () => { const method = session.journal.pending?.method; await session.journal.retry(); if (method === 'delete_report' || method === 'set_ownership') props.onLeave(); else await refreshRecord(); })}>Retry pending change</Button><Button variant="ghost" onClick={props.onLeave}>Review in library</Button></div>}
    {controller && (save?.status === 'error' || save?.status === 'conflict') && <div className="space-y-2 border-b border-amber-400 bg-amber-50/30 p-3 text-sm dark:bg-amber-950/20" role="alert">
      <p>{save.message}</p><p>Your draft is kept on this device. Reloading retains it under the library’s recovery drafts.</p>
      <div className="flex flex-wrap gap-2"><Button disabled={busy || save.status === 'conflict'} onClick={() => void controller.retry()}>Retry save</Button><Button variant="outline" disabled={busy} onClick={() => setGeneration(n => n + 1)}>Load latest from worker</Button><Button variant="outline" disabled={busy || managementPending || !session.info.root_allowed_actions.includes('create_report')} onClick={() => void attempt(() => copy(controller.current.report))}>Save draft as a copy</Button><Button variant="ghost" onClick={() => downloadDocumentFile(JSON.stringify(controller.current.report, null, 2), 'report-draft.json')}>Export draft</Button></div>
    </div>}
    {opened?.bodyError && <div className="space-y-3 p-5"><p role="alert">{opened.bodyError}</p>{record?.body && <Button variant="outline" onClick={downloadBody}><Download />Download original body</Button>}</div>}
    {record && !record.redacted && !page && ['notebook', 'query'].includes(documentKind(record)) && <LibraryDocumentOpener key={`${record.report_id}:${revisionId ?? 'head'}:${generation}`} record={record} libraryUrl={session.client.url} authScope={session.scope} recoveryOnly={opened?.recoveryOnly} pinned={Boolean(revisionId)} />}
    {opened?.report && <div className="min-h-0 flex-1" hidden={page === 'details' || page === 'share' || page === 'ownership' || page === 'schedules'}><EvidenceWorkspace key={editorGeneration} {...props} remote={{
      report: opened.report, canEdit: Boolean(controller), status: !controller ? 'Read only' : save?.status === 'error' || save?.status === 'conflict' ? 'Not saved' : pending ? 'Saving…' : 'Saved', pending: Boolean(blocked),
      location: reportLocation, actions: reportActions, onShare: () => showPage('share'), onHistoryOpen: () => setHistoryReload(n => n + 1),
      versionLabel: revisionId ? `Version ${record?.revision_number}` : controller ? record?.published_revision_id ? record.published_revision_id === record.head_revision_id ? 'Published' : 'Unpublished changes' : 'Draft' : undefined,
      onOpenCurrent: revisionId ? () => props.onOpen(reportId) : undefined,
      publishAction: !revisionId && can('publish') && record?.published_revision_id !== record?.head_revision_id ? { disabled: blocked, onClick: () => showPage('share') } : undefined,
      onDraft: report => controller?.capture(report), onSave: (report, meta) => controller?.stage(report, meta),
      onLeave: props.onLeave, onCopy: report => void attempt(() => copy(report)), historyContent,
    }} /></div>}
    {page === 'schedules' && record && documentKind(record) !== 'report' && <ReportPage title="Scheduling is for reports" onBack={() => showPage(null)}><p>Queries and notebooks can be saved and shared. To schedule emailed results, create a report using this query.</p></ReportPage>}
    {page === 'schedules' && record && documentKind(record) === 'report' && <ReportSchedulesPage report={record} reportClient={session.client} catalogs={props.catalogs} workspaceId={props.workspaceId} pinned={Boolean(revisionId)} onBack={() => showPage(null)} />}
    {page === 'details' && record && <ReportDetailsPage documentLabel={record && documentKind(record) !== 'report' ? documentKind(record) : 'report'} key={String(record.version)} initial={{ name: record.envelope?.title ?? '', description: record.envelope?.description ?? '', tags: record.envelope?.tags ?? [] }} location={reportLocation} blocked={blocked}
      onClose={() => showPage(null)} onSave={!revisionId && !opened?.recoveryOnly && can('edit') && record.envelope && record.body ? async values => {
        if (!controller) {
          if (blocked) throw new Error('Finish saving before changing document details.');
          await session.journal.run('commit_revision', { report_id: reportId, expected_revision_id: record.head_revision_id, envelope: { ...record.envelope!, title: values.name, description: values.description, tags: values.tags }, body: record.body!, message: 'Updated document details' });
          resetDocumentDraft(session.client.url, reportId, documentKind(record) as 'query' | 'notebook', session.scope); setGeneration(n => n + 1); showPage(null); return;
        }
        if (blocked || !opened?.report) throw new Error('Finish saving before changing report details.');
        const next = { ...controller.current.report, title: values.name };
        controller.capture(next, { description: values.description, tags: values.tags }); controller.stage(next, { kind: 'edit', label: 'Updated report details' });
        setOpened({ ...opened, report: next }); setEditorGeneration(n => n + 1);
      } : undefined}
      identity={<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2"><dt className="text-muted-foreground">Created by</dt><dd>{record.created_by.display_name || record.created_by.id}</dd><dt className="text-muted-foreground">Owner</dt><dd>{record.ownership.owner_ref.display_name || record.ownership.owner_ref.id}</dd>{record.ownership.parent_owner_ref && <><dt className="text-muted-foreground">Parent owner</dt><dd>{record.ownership.parent_owner_ref.display_name || record.ownership.parent_owner_ref.id}</dd></>}<dt className="text-muted-foreground">Saved version</dt><dd>{String(record.revision_number)}</dd></dl>}
      onTransferOwnership={can('transfer_ownership') ? () => showPage('ownership') : undefined} />}
    {page === 'share' && record && <WorkerReportSharing record={record} url={session.client.url} pinned={Boolean(revisionId)} blocked={blocked} canPublish={can('publish')} onClose={() => showPage(null)} onPublish={async revision => {
      if (blocked) throw new Error('Finish saving before publishing.');
      setBusy(true); try { await session.journal.run('publish', { report_id: reportId, revision_id: revision, expected_published_revision_id: record.published_revision_id }); await refreshRecord(); } finally { setBusy(false); }
    }} />}
    {page === 'history' && !opened?.report && <ReportPage title="Version history" backLabel="Back to document" description={record?.envelope?.title} onBack={() => showPage(null)}>{historyContent}</ReportPage>}
    {page === 'ownership' && record && <OwnershipPage client={session.client} resourceKind="report" resourceId={reportId} name={record.envelope?.title ?? 'Report'} current={record.ownership} blocked={blocked || !can('transfer_ownership')} onBack={() => showPage(null)} onApply={async ownership => {
      setBusy(true); try { await session.journal.run('set_ownership', { report_id: reportId, expected_version: record.version, ownership }); props.onLeave(); } finally { setBusy(false); }
    }} />}
    {dialog && record && <ResourceDialog {...dialog} resource={record} folders={folders} libraryName={session.info.display_name} rootActions={session.info.root_allowed_actions} writable={session.info.writable} onClose={() => setDialog(null)} onApply={apply} />}
  </section>;
}
