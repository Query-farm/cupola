import { useEffect, useMemo, useRef, useState } from 'react';
import { FolderOpen, Plus, RefreshCw, MoreHorizontal } from 'lucide-react';
import { Button, buttonVariants } from '../ui/button';
import { Input } from '../ui/input';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { ReportClient, reportError, type Input as RpcInput, type Method, type Output } from '../../lib/reporting/client';
import type { FolderRecord, ReportResult, ReportRow, ReportsInfo } from '../../lib/reporting/contracts.generated';
import { MutationJournal } from '../../lib/reporting/journal';
import { recoveryDrafts, type RecoveryDraft } from '../../lib/reporting/save-controller';
import { encodeReport } from '../../lib/reporting/body';
import { listEvidenceReports, type EvidenceReport } from '../../lib/evidence/reports';
import { newEvidenceReport } from '../../lib/evidence/templates';
import { parseReportFile } from '../../lib/evidence/report-file';
import { downloadDocumentFile } from '../../lib/saved-document-actions';
import { ResourceDialog, folderPath, type ResourceAction, type ResourceValues } from './ResourceDialog';
import { RemoteReport } from './RemoteReport';
import type { ReportingWorkspaceProps } from './ReportingWorkspace';
import { ReportFileList, type ReportFileItem } from './ReportFileList';
import { ReportNotice } from './ReportNotice';
import { ReportActionMenu, reportAction } from './ReportActionMenu';
import { ReportDetailsDialog } from './ReportDetailsDialog';
import { REPORT_ROUTE_CHANGED, REPORT_LIBRARY_CHANGED } from '../../lib/reporting/navigation';

export interface LibrarySession { client: ReportClient; info: ReportsInfo; scope: string; journal: MutationJournal }
export function ReportLibrary(props: ReportingWorkspaceProps & { libraryUrl: string; onAllReports: () => void }) {
  const client = useMemo(() => new ReportClient(props.libraryUrl), [props.libraryUrl]);
  const [session, setSession] = useState<LibrarySession | null>(null);
  const [folderId, setFolderId] = useState<string | null>(() => new URLSearchParams(location.search).get('report_folder'));
  const [selected, setSelected] = useState(() => ({ id: new URLSearchParams(location.search).get('report_id'), revision: new URLSearchParams(location.search).get('report_revision') }));
  const [folders, setFolders] = useState<FolderRecord[]>([]), [reports, setReports] = useState<ReportRow[]>([]);
  const [query, setQuery] = useState(''), [publishedOnly, setPublishedOnly] = useState(false), [ownedByMe, setOwnedByMe] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [dialog, setDialog] = useState<{ action: ResourceAction; resource?: FolderRecord | ReportRow } | null>(null);
  const [drafts, setDrafts] = useState<Array<{ key: string; value: RecoveryDraft }>>([]);
  const [details, setDetails] = useState<ReportRow | null>(null);
  const [recovery, setRecovery] = useState<{ key: string; value: RecoveryDraft } | undefined>();
  const file = useRef<HTMLInputElement>(null);
  const [localReports, setLocalReports] = useState<EvidenceReport[]>([]);
  const revision = useRef(0);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true); setError('');
    void Promise.all([client.call('get_report_service_info', {}, abort.signal), client.recoveryScope()]).then(([info, scope]) => {
      if (!abort.signal.aborted) {
        if (info.protocol_version.split('.')[0] !== '1') throw new Error(`Unsupported reporting version: ${info.protocol_version}`);
        setSession({ client, info, scope, journal: new MutationJournal(client, scope, 'library') });
      }
    }).catch(e => { if (!abort.signal.aborted) { setError(reportError(e)); setLoading(false); } });
    return () => abort.abort();
  }, [client, generation]);
  useEffect(() => {
    if (!session || selected.id) return;
    const abort = new AbortController(), current = ++revision.current;
    setLoading(true); setError(''); setReports([]); setFolders([]);
    const timer = setTimeout(() => void Promise.all([
      client.call('list_folders', {}, abort.signal),
      client.call('list_reports', { folder_id: folderId, recursive: Boolean(query), query, published_only: publishedOnly, owned_by_me: ownedByMe }, abort.signal),
      folderId ? client.call('get_folder', { folder_id: folderId }, abort.signal) : Promise.resolve(null),
    ]).then(([allFolders, rows, parent]) => {
      if (abort.signal.aborted || current !== revision.current) return;
      setFolders(parent && !allFolders.some(f => f.folder_id === parent.folder_id) ? [...allFolders, parent] : allFolders); setReports(rows);
      setDrafts(recoveryDrafts(session.scope));
      setLocalReports(listEvidenceReports(props.workspaceId ?? props.serviceUrl));
    }).catch(e => { if (!abort.signal.aborted) setError(reportError(e)); }).finally(() => { if (!abort.signal.aborted) setLoading(false); }), query ? 200 : 0);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [session, folderId, selected.id, query, publishedOnly, ownedByMe]);
  useEffect(() => {
    const pop = () => { const search = new URLSearchParams(location.search); setFolderId(search.get('report_folder')); setSelected({ id: search.get('report_id'), revision: search.get('report_revision') }); setRecovery(undefined); };
    window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop);
  }, []);
  function navigate(id: string | null, folder = folderId, pinned: string | null = null) {
    const url = new URL(location.href);
    for (const key of [...url.searchParams.keys()]) if (key.startsWith('p.')) url.searchParams.delete(key);
    if (id) url.searchParams.set('report_id', id); else url.searchParams.delete('report_id');
    if (folder) url.searchParams.set('report_folder', folder); else url.searchParams.delete('report_folder');
    if (pinned) url.searchParams.set('report_revision', pinned); else url.searchParams.delete('report_revision');
    history.pushState({}, '', url); window.dispatchEvent(new Event(REPORT_ROUTE_CHANGED)); setFolderId(folder); setSelected({ id, revision: pinned }); setRecovery(undefined); setError('');
  }
  async function mutate<M extends Method>(method: M, input: Omit<RpcInput<M>, 'request_id'>): Promise<Output<M>> {
    if (!session) throw new Error('The report library is not connected.');
    setBusy(true); setError('');
    try { const result = await session.journal.run(method, input); setGeneration(n => n + 1); return result; }
    catch (e) { setError(reportError(e)); throw e; }
    finally { setBusy(false); }
  }
  async function create(report: EvidenceReport, imported = false) {
    if (!session) return;
    const { envelope, body } = encodeReport(report, { description: '', tags: [] }, session.info);
    const result = await mutate('create_report', { envelope, body, folder_id: folderId, message: imported ? 'Imported into Cupola; source history remains in the original file or browser.' : '' });
    navigate(result.report_id);
  }
  async function apply(values: ResourceValues) {
    const target = dialog?.resource, action = dialog?.action;
    if (action === 'folder') await mutate('create_folder', { name: values.name, parent_folder_id: values.folderId });
    else if (target && 'name' in target) {
      const base = { folder_id: target.folder_id, expected_version: target.version };
      if (action === 'delete') await mutate('delete_folder', base);
      else if (action === 'ownership') await mutate('set_folder_ownership', { ...base, ownership: values.ownership });
      else await mutate('update_folder', { ...base, name: values.name, parent_folder_id: values.folderId });
    } else if (target) {
      const base = { report_id: target.report_id, expected_version: target.version };
      if (action === 'delete') await mutate('delete_report', base);
      else if (action === 'move') await mutate('move_report', { ...base, folder_id: values.folderId });
      else if (action === 'ownership') await mutate('set_ownership', { ...base, ownership: values.ownership });
    }
  }
  async function retry() {
    if (!session) return;
    setBusy(true); setError('');
    const pending = session.journal.pending;
    try {
      const result = await session.journal.retry(); setGeneration(n => n + 1);
      if (pending?.method === 'create_report') navigate((result as ReportResult).report_id);
      else setNotice('The worker confirmed the pending change.');
    } catch (e) { setError(reportError(e)); } finally { setBusy(false); }
  }
  const parent = folders.find(f => f.folder_id === folderId);
  const actions = (session?.info.writable ? folderId ? parent?.allowed_actions : session.info.root_allowed_actions : []) ?? [];
  const pending = session?.journal.pending;
  const blocked = busy || Boolean(pending) || !session?.info.writable;
  if (selected.id && session) return <RemoteReport key={`${selected.id}:${selected.revision ?? ''}:${recovery?.key ?? ''}`} {...props} session={session} reportId={selected.id} revisionId={selected.revision} recovery={recovery}
    onLeave={() => { navigate(null); setGeneration(n => n + 1); }} onOpen={(id, revision) => navigate(id, folderId, revision ?? null)} />;
  const items: ReportFileItem[] = [
    ...folders.filter(f => f.parent_folder_id === folderId).sort((a, b) => a.name.localeCompare(b.name)).map(folder => ({
      id: folder.folder_id, name: folder.name, kind: 'folder' as const, onOpen: () => navigate(null, folder.folder_id), detail: folder.ownership.owner_ref.display_name || folder.ownership.owner_ref.id, state: 'Folder',
      actions: <ResourceMenu resource={folder} disabled={blocked} onAction={action => setDialog({ action, resource: folder })} />,
    })),
    ...reports.map(report => ({ id: report.report_id, name: report.envelope?.title ?? 'Redacted report', description: report.envelope?.description, kind: 'report' as const,
      onOpen: () => navigate(report.report_id), detail: report.ownership.owner_ref.display_name || report.ownership.owner_ref.id, state: `${report.published_revision_id ? 'Published' : 'Draft'} · revision ${String(report.revision_number)}`,
      actions: <ReportActionMenu label={`Actions for ${report.envelope?.title ?? 'report'}`} actions={[
        reportAction('details', () => setDetails(report)),
        ...(props.onTransferReport && !report.redacted ? [reportAction('copy', () => props.onTransferReport?.({ kind: 'worker', url: client.url, record: report }, false), busy || Boolean(pending)),
          ...(report.allowed_actions.some(a => a === 'move' || a === 'delete') ? [reportAction('move', () => props.onTransferReport?.({ kind: 'worker', url: client.url, record: report }, true), blocked)] : [])] : []),
        ...(report.allowed_actions.includes('delete') ? [reportAction('delete', () => setDialog({ action: 'delete', resource: report }), blocked)] : []),
      ]} />,
    })),
  ];
  return <section aria-label="Worker report library" className="flex h-full min-h-0 flex-col">
    <header className="flex flex-wrap items-center gap-3 border-b px-5 py-4">
      <FolderOpen className="size-5" /><h1 className="font-semibold">{session?.info.display_name ?? 'Report library'}</h1>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setGeneration(n => n + 1); window.dispatchEvent(new CustomEvent(REPORT_LIBRARY_CHANGED, { detail: { url: client.url } })); }}><RefreshCw />Reload library</Button>
      <div className="ml-auto flex flex-wrap gap-2">
        <Button variant="outline" disabled={blocked || !actions.includes('create_folder')} onClick={() => setDialog({ action: 'folder' })}>New folder</Button>
        <Button disabled={busy || loading} onClick={() => { if (blocked || !actions.includes('create_report')) props.onCreateLocal?.(); else void create(newEvidenceReport(props.serviceUrl, props.catalogName)).catch(e => setError(reportError(e))); }}><Plus />New report</Button>
      </div>
    </header>
    <div className="min-h-0 flex-1 space-y-4 overflow-auto p-5">
      {!loading && session && (!actions.includes('create_report') || !session.info.writable) ? <ReportNotice kind="permission" title="Read-only location" action={<Button size="sm" variant="outline" onClick={props.onCreateLocal}><Plus />New local report</Button>}>
        You can view reports here. Save new reports on this device or choose a writable folder.
      </ReportNotice> : !loading && session && !actions.includes('create_folder') && <ReportNotice kind="permission" title="Folder creation restricted">Your current access allows reports here, but not new folders.</ReportNotice>}
      {error && <ReportNotice kind="error" title="Could not load or update this location">{error}</ReportNotice>}
      {notice && <p role="status" className="text-sm">{notice}</p>}
      {pending && <div className="space-y-2 rounded border border-amber-400 p-3 text-sm"><p>A previous change has not been confirmed. Retry uses the same request ID and content.</p><Button disabled={busy} onClick={() => void retry()}>Retry pending change</Button> <Button variant="outline" disabled={busy} onClick={async () => { if (confirm('This change may already have succeeded. Inspect the worker first. Discard the saved request without retrying?')) { await session.journal.discard(); setGeneration(n => n + 1); } }}>Discard request…</Button></div>}
      <nav aria-label="Report folders" className="flex flex-wrap items-center gap-2 text-sm"><Button variant="ghost" size="sm" onClick={props.onAllReports}>All reports</Button><span>/</span><Button variant="ghost" size="sm" onClick={() => navigate(null, null)} aria-current={parent ? undefined : 'page'}>{session?.info.display_name || 'Library root'}</Button>{parent && <><span>/</span><span aria-current="page">{folderPath(parent, folders)}</span><Button variant="ghost" size="sm" onClick={() => navigate(null, parent.parent_folder_id)}>Up one folder</Button></>}</nav>
      <div className="flex flex-wrap items-center gap-4"><Input className="max-w-md" aria-label="Search reports" placeholder="Search this folder and its descendants…" value={query} onChange={e => setQuery(e.target.value)} /><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={publishedOnly} onChange={e => setPublishedOnly(e.target.checked)} />Published only</label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={ownedByMe} onChange={e => setOwnedByMe(e.target.checked)} />Owned by me</label></div>
      {loading ? <p role="status">Loading report library…</p> : <ReportFileList items={items} detailLabel="Owner" emptyMessage="This folder is empty." />}
      <details className="rounded border p-3 text-sm"><summary className="cursor-pointer font-medium">Import reports</summary><p className="my-3 text-muted-foreground">Copies the current report definition into this folder. Existing reports and their history remain on this device or in the source file.</p>
        <select aria-label="Import report from this device" className="rounded border bg-background p-2" value="" disabled={blocked || !actions.includes('create_report')} onChange={e => { const report = localReports.find(r => r.id === e.target.value); if (report) void create(report, true).catch(e => setError(reportError(e))); }}><option value="">Choose a report on this device…</option>{localReports.map(r => <option key={r.id} value={r.id}>{r.title}</option>)}</select>
        <Button className="ml-2" variant="outline" disabled={blocked || !actions.includes('create_report')} onClick={() => file.current?.click()}>Import report file</Button>
        <input ref={file} hidden type="file" accept=".json" aria-label="Import worker report file" onChange={async e => {
          const chosen = e.target.files?.[0]; e.target.value = ''; if (!chosen) return;
          try { const parsed = parseReportFile(await chosen.text()); if (parsed.errors.length) throw new Error(parsed.errors.join('\n')); if (parsed.reports.length !== 1) throw new Error('Choose a file containing one report. Import reports individually so each result can be confirmed.'); await create(parsed.reports[0], true); } catch (e) { setError(reportError(e)); }
        }} />
      </details>
      {drafts.length > 0 && <section aria-label="Recovered worker drafts" className="space-y-2 rounded border p-3"><h2 className="text-sm font-semibold">Drafts kept on this device</h2>{drafts.map(draft => <div key={draft.key} className="flex flex-wrap items-center gap-3 text-sm"><span>{draft.value.draft.report.title} · {new Date(draft.value.updatedAt).toLocaleString()}</span><Button size="sm" variant="outline" onClick={() => { navigate(draft.value.base.report_id); setRecovery(draft); }}>Review draft</Button><Button size="sm" variant="ghost" onClick={() => downloadDocumentFile(JSON.stringify(draft.value.draft.report, null, 2), 'recovered-report.json')}>Export draft</Button><Button size="sm" variant="ghost" onClick={async () => { if (confirm('Discard this recovery draft? Any pending worker request may already have succeeded.')) { localStorage.removeItem(draft.key); await new MutationJournal(client, session!.scope, draft.value.journalId).discard(); setDrafts(recoveryDrafts(session!.scope)); } }}>Discard draft…</Button></div>)}</section>}
      <p className="text-xs text-muted-foreground">Folder and report permissions are defined by this worker. Publishing does not itself grant access.</p>
    </div>
    {details && <ReportDetailsDialog initial={{ name: details.envelope?.title ?? '', description: details.envelope?.description ?? '', tags: details.envelope?.tags ?? [] }} location={session?.info.display_name ?? 'Report library'} onClose={() => setDetails(null)} blocked={blocked}
      identity={<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2"><dt>Created by</dt><dd>{details.created_by.display_name || details.created_by.id}</dd><dt>Owner</dt><dd>{details.ownership.owner_ref.display_name || details.ownership.owner_ref.id}</dd></dl>}
      onTransferOwnership={details.allowed_actions.includes('transfer_ownership') ? () => { setDialog({ action: 'ownership', resource: details }); setDetails(null); } : undefined} />}
    {dialog && <ResourceDialog key={`${dialog.action}:${dialog.resource && ('name' in dialog.resource ? dialog.resource.folder_id : dialog.resource.report_id)}`} {...dialog} folders={folders} libraryName={session?.info.display_name} rootActions={session?.info.root_allowed_actions ?? []} writable={Boolean(session?.info.writable)} parentId={folderId} onClose={() => setDialog(null)} onApply={apply} />}
  </section>;
}

export function ResourceMenu({ resource, disabled, onAction }: { resource: FolderRecord | ReportRow; disabled: boolean; onAction: (action: ResourceAction) => void }) {
  const actions: Array<[string, ResourceAction, string]> = [['rename', 'rename', 'Rename'], ['move', 'move', 'Move'], ['transfer_ownership', 'ownership', 'Transfer ownership'], ['delete', 'delete', 'Delete']];
  const offered = actions.filter(([hint]) => resource.allowed_actions.includes(hint) && (hint !== 'rename' || 'name' in resource));
  return offered.length ? <DropdownMenu><DropdownMenuTrigger disabled={disabled} aria-label={`Actions for ${'name' in resource ? resource.name : resource.envelope?.title ?? 'report'}`} className={buttonVariants({ variant: 'ghost', size: 'icon' })}><MoreHorizontal /></DropdownMenuTrigger><DropdownMenuContent align="end">{offered.map(([hint, action, label]) => <DropdownMenuItem key={hint} onClick={() => onAction(action)}>{label}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu> : null;
}
