import { useEffect, useRef, useState } from 'react';
import { FolderOpen, Plus, RefreshCw } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import { deleteEvidenceReport, EVIDENCE_REPORTS_CHANGED, listEvidenceReports, listUnsavedDrafts, saveEvidenceReport, type EvidenceReport } from '../../lib/evidence/reports';
import { ReportClient, reportError } from '../../lib/reporting/client';
import type { FolderRecord, ReportRow } from '../../lib/reporting/contracts.generated';
import { createLocalFolder, deleteLocalFolder, localFolderPath, localLibrary, placeLocalReport } from '../../lib/reporting/local-library';
import { locationLabel, type ReportLocation } from '../../lib/reporting/locations';
import type { TransferSource } from '../../lib/reporting/transfers';
import { folderPath } from './ResourceDialog';
import { parseReportFile, planImport, reportFileName, serializeReportFile } from '../../lib/evidence/report-file';
import { loadReportHistory, mergeHistories, recordRevision, saveReportHistory } from '../../lib/evidence/revisions';
import { downloadDocumentFile } from '../../lib/saved-document-actions';
import { exportSavedReport } from '../../lib/evidence/report-actions';
import { ReportBrowserLayout, type ReportBrowserNavigation } from './ReportStorageTree';
import { ReportFileList, type ReportFileItem } from './ReportFileList';
import { ReportActionMenu, reportAction } from './ReportActionMenu';

interface WorkerRows { url: string; reports: ReportRow[]; folders: FolderRecord[]; error?: string; loading?: boolean }
export function ReportOverview({ navigation, locations, scope, localOnly, folderId, onAllReports, onFolder, onNew, onLocal, onWorker, onTransfer, onRefresh, serviceUrl, workspaceId }: {
  locations: ReportLocation[]; scope: string; serviceUrl: string; workspaceId?: string; localOnly: boolean; folderId: string | null;
  navigation: ReportBrowserNavigation; onAllReports: () => void;
  onFolder: (id: string | null) => void; onNew: () => void; onLocal: (report: EvidenceReport) => void;
  onWorker: (url: string, id: string) => void; onTransfer: (source: TransferSource, move: boolean) => void; onRefresh: () => void;
}) {
  const [local, setLocal] = useState<EvidenceReport[]>([]), [localError, setLocalError] = useState('');
  const [library, setLibrary] = useState(() => localLibrary(scope)), [workers, setWorkers] = useState<WorkerRows[]>([]);
  const [query, setQuery] = useState(''), [newFolder, setNewFolder] = useState(false), [name, setName] = useState('');
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [drafts, setDrafts] = useState<ReturnType<typeof listUnsavedDrafts>>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const reloadLocal = () => { try { const reports = listEvidenceReports(scope); setLocal(reports); setDrafts(listUnsavedDrafts(scope, new Set(reports.map(r => r.id)))); setLibrary(localLibrary(scope)); setLocalError(''); } catch (e) { setLocalError(reportError(e)); } };
  function exportAll() {
    try { downloadDocumentFile(serializeReportFile(local.map(report => ({ report, history: loadReportHistory(scope, report.id) }))), reportFileName(local)); }
    catch (e) { setError(reportError(e)); }
  }
  async function importFiles(files: File[]) {
    const errors: string[] = []; let imported = 0;
    for (const file of files) {
      try {
        const parsed = parseReportFile(await file.text()); errors.push(...parsed.errors);
        const plans = planImport(parsed.reports, listEvidenceReports(scope), { serviceUrl, workspaceId },
          (existing, next) => confirm(`“${existing.title}” already exists and differs from “${next.title}”. OK replaces it; Cancel keeps both.`));
        for (const [i, plan] of plans.entries()) {
          try {
            let history = parsed.histories[i];
            if (plan.action === 'replace' || plan.action === 'unchanged') history = mergeHistories(loadReportHistory(scope, plan.report.id), history);
            const report = plan.action === 'unchanged' ? plan.report : saveEvidenceReport(plan.report);
            saveReportHistory(scope, report.id, plan.action === 'unchanged' ? history : recordRevision(history, report, { kind: 'import', label: `Imported from ${file.name}` }));
            if (plan.action !== 'unchanged') { placeLocalReport(scope, report.id, folderId); imported++; }
          } catch (e) { errors.push(`${plan.report.title}: ${reportError(e)}`); }
        }
      } catch (e) { errors.push(`${file.name}: ${reportError(e)}`); }
    }
    setError(errors.join('\n')); setNotice(`Imported ${imported} reports on this device.`); reloadLocal();
  }
  useEffect(() => {
    reloadLocal(); window.addEventListener(EVIDENCE_REPORTS_CHANGED, reloadLocal); window.addEventListener('storage', reloadLocal);
    return () => { window.removeEventListener(EVIDENCE_REPORTS_CHANGED, reloadLocal); window.removeEventListener('storage', reloadLocal); };
  }, [scope]);
  useEffect(() => {
    const abort = new AbortController();
    const supported = localOnly ? [] : locations.filter(l => l.info);
    setWorkers(supported.map(l => ({ url: l.url, reports: [], folders: [], loading: true })));
    for (const location of supported) {
      const client = new ReportClient(location.url);
      void Promise.all([client.call('list_reports', { recursive: true }, abort.signal), client.call('list_folders', {}, abort.signal)])
        .then(([reports, folders]) => { if (!abort.signal.aborted) setWorkers(old => old.map(w => w.url === location.url ? { url: w.url, reports, folders } : w)); })
        .catch(e => { if (!abort.signal.aborted) setWorkers(old => old.map(w => w.url === location.url ? { ...w, loading: false, error: reportError(e) } : w)); });
    }
    return () => abort.abort();
  }, [locations, localOnly]);
  const match = (title: string) => title.toLocaleLowerCase().includes(query.toLocaleLowerCase());
  const localRows = local.filter(r => match(r.title) && (!localOnly || query || (library.entries[r.id]?.folderId ?? null) === folderId));
  const remoteRows = workers.flatMap(w => w.reports.filter(r => match(r.envelope?.title ?? '')).map(report => ({ worker: w, report })));
  const items: ReportFileItem[] = [
    ...(localOnly && !query ? library.folders.filter(f => f.parentId === folderId).map(f => ({ id: f.id, name: f.name, kind: 'folder' as const, onOpen: () => onFolder(f.id), detail: 'On this device', state: 'Folder', actions: <ReportActionMenu label={`Actions for ${f.name}`} actions={[{ ...reportAction('delete', () => { try { deleteLocalFolder(scope, f.id); } catch (e) { setError(reportError(e)); } }), label: 'Delete empty folder' }]} /> })) : []),
    ...localRows.map(report => ({ id: `local:${report.id}`, name: report.title, kind: 'report' as const, onOpen: () => onLocal(report), detail: `On this device${library.entries[report.id]?.folderId ? ` / ${localFolderPath(library.entries[report.id].folderId, library.folders)}` : ''}`, state: 'Local', actions: <ReportActionMenu label={`Actions for ${report.title}`} actions={[
      reportAction('copy', () => onTransfer({ kind: 'local', report }, false)), reportAction('move', () => onTransfer({ kind: 'local', report }, true)),
      reportAction('export', () => { try { exportSavedReport(report); } catch (e) { setError(reportError(e)); } }),
      reportAction('delete', () => { if (confirm(`Delete “${report.title}” from this browser?`)) { try { deleteEvidenceReport(scope, report.id); } catch (e) { setError(reportError(e)); } } }),
    ]} /> })),
    ...remoteRows.map(({ worker, report }) => ({ id: `${worker.url}:${report.report_id}`, name: report.envelope?.title ?? 'Redacted report', kind: 'report' as const, onOpen: () => onWorker(worker.url, report.report_id), detail: <span title={worker.url}>{locationLabel(locations.find(l => l.url === worker.url)!, locations)}{report.folder_id && ` / ${folderPath(worker.folders.find(f => f.folder_id === report.folder_id) ?? { name: 'Folder', parent_folder_id: null } as FolderRecord, worker.folders)}`}</span>, state: report.published_revision_id ? 'Published' : 'Draft', actions: <ReportActionMenu label={`Actions for ${report.envelope?.title ?? 'report'}`} actions={[
      ...(!report.redacted ? [reportAction('copy', () => onTransfer({ kind: 'worker', url: worker.url, record: report }, false))] : []),
      ...(report.allowed_actions.some(a => a === 'move' || a === 'delete') ? [reportAction('move', () => onTransfer({ kind: 'worker', url: worker.url, record: report }, true))] : []),
    ]} /> })),
  ];
  return <section className="flex h-full min-h-0 flex-col" aria-label="Report browser">
    <header className="flex flex-wrap items-center gap-3 border-b px-5 py-4"><FolderOpen className="size-5" /><h1 className="font-semibold">{localOnly ? 'On this device' : 'All reports'}</h1><Button variant="ghost" size="sm" onClick={() => { reloadLocal(); onRefresh(); }}><RefreshCw />Refresh</Button>
      <div className="ml-auto flex gap-2"><Button variant="outline" onClick={() => { setName(''); setError(''); setNewFolder(true); }}>New folder</Button><Button onClick={onNew}><Plus />New report</Button></div>
    </header>
    <ReportBrowserLayout navigation={navigation} location={localOnly ? 'local' : 'all'} folderId={folderId}>
    <div className="space-y-4 p-5">
      <p className="text-sm text-muted-foreground">{localOnly ? 'Reports in this workspace saved in this browser. Copy or move them to a named location to save them on a worker.' : 'Reports from this browser and connected workers. New reports start on this device; use the report’s action menu to save a copy or move it elsewhere.'}</p>
      {localOnly && <nav aria-label="Local report folders" className="flex flex-wrap items-center gap-2 text-sm"><Button variant="ghost" onClick={onAllReports}>All reports</Button><span>/</span><Button variant="ghost" onClick={() => onFolder(null)} aria-current={folderId ? undefined : 'page'}>On this device</Button>{folderId && <><span aria-current="page">/ {localFolderPath(folderId, library.folders)}</span><Button variant="ghost" onClick={() => onFolder(library.folders.find(f => f.id === folderId)?.parentId ?? null)}>Up one folder</Button></>}</nav>}
      <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => fileInput.current?.click()}>Import report file</Button><Button size="sm" variant="ghost" disabled={!local.length} onClick={exportAll}>Export local reports</Button><input ref={fileInput} hidden type="file" multiple accept=".json" aria-label="Import local report files" onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ''; void importFiles(files); }} /></div>
      {notice && <p role="status" className="text-sm">{notice}</p>}
      {drafts.length > 0 && <section aria-label="Unsaved local drafts" className="rounded border p-3"><h2 className="font-medium">Recovered local drafts</h2>{drafts.map(d => <Button key={d.report.id} variant="link" onClick={() => onLocal(d.report)}>{d.report.title}</Button>)}</section>}
      <Input aria-label="Search reports" placeholder="Search reports across locations…" className="max-w-md" value={query} onChange={e => setQuery(e.target.value)} />
      {(localError || error) && <p role="alert" className="text-sm text-destructive">{localError || error}</p>}
      {!localOnly && locations.filter(l => l.error || l.loading).map(l => <p key={l.url} role={l.error ? 'alert' : 'status'} className="text-sm text-muted-foreground">{locationLabel(l, locations)}: {l.error || 'Checking for report storage…'}</p>)}
      {workers.filter(w => w.error || w.loading).map(w => <p key={w.url} role={w.error ? 'alert' : 'status'} className="text-sm text-muted-foreground">{locations.find(l => l.url === w.url)?.name}: {w.error || 'Loading reports…'}</p>)}
      <ReportFileList items={items} emptyMessage={workers.some(w => w.loading) ? 'Loading reports…' : 'No reports found.'} />
    </div>
    </ReportBrowserLayout>
    {newFolder && <Dialog open onOpenChange={setNewFolder}><DialogContent><DialogHeader><DialogTitle>New folder</DialogTitle><DialogDescription>Creates a folder on this device{folderId ? ` in ${localFolderPath(folderId, library.folders)}` : ''}. To create one on a worker, open that location.</DialogDescription></DialogHeader><form className="space-y-3" onSubmit={e => { e.preventDefault(); try { createLocalFolder(scope, name, folderId); setNewFolder(false); onFolder(folderId); } catch (e) { setError(reportError(e)); } }}><label>Name<Input aria-label="Name" required value={name} onChange={e => setName(e.target.value)} /></label>{error && <p role="alert">{error}</p>}<Button type="submit">Create folder</Button></form></DialogContent></Dialog>}
  </section>;
}
