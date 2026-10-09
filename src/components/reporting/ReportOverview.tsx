import { useEffect, useRef, useState } from 'react';
import { FileText, FolderOpen, Plus, RefreshCw } from 'lucide-react';
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

interface WorkerRows { url: string; reports: ReportRow[]; folders: FolderRecord[]; error?: string; loading?: boolean }
export function ReportOverview({ locations, scope, localOnly, folderId, onFolder, onNew, onLocal, onWorker, onTransfer, onRefresh, serviceUrl, workspaceId }: {
  locations: ReportLocation[]; scope: string; serviceUrl: string; workspaceId?: string; localOnly: boolean; folderId: string | null;
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
  return <section className="flex h-full flex-col overflow-auto" aria-label="Report browser">
    <header className="flex flex-wrap items-center gap-3 border-b px-5 py-4"><FolderOpen className="size-5" /><h1 className="font-semibold">{localOnly ? 'On this device' : 'All reports'}</h1><Button variant="ghost" size="sm" onClick={() => { reloadLocal(); onRefresh(); }}><RefreshCw />Refresh</Button>
      <div className="ml-auto flex gap-2"><Button variant="outline" onClick={() => { setName(''); setError(''); setNewFolder(true); }}>New folder</Button><Button onClick={onNew}><Plus />New report</Button></div>
    </header>
    <div className="space-y-4 p-5">
      <p className="text-sm text-muted-foreground">{localOnly ? 'Reports in this workspace saved in this browser. Copy or move them to a named location to save them on a worker.' : 'Reports from this browser and connected workers. New reports start on this device; choose Copy to or Move to when you are ready to save elsewhere.'}</p>
      {localOnly && <nav aria-label="Local report folders" className="flex items-center gap-2 text-sm"><Button variant="ghost" onClick={() => onFolder(null)}>On this device</Button>{folderId && <><span>/ {localFolderPath(folderId, library.folders)}</span><Button variant="ghost" onClick={() => onFolder(library.folders.find(f => f.id === folderId)?.parentId ?? null)}>Up one folder</Button></>}</nav>}
      <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => fileInput.current?.click()}>Import report file</Button><Button size="sm" variant="ghost" disabled={!local.length} onClick={exportAll}>Export local reports</Button><input ref={fileInput} hidden type="file" multiple accept=".json" aria-label="Import local report files" onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ''; void importFiles(files); }} /></div>
      {notice && <p role="status" className="text-sm">{notice}</p>}
      {drafts.length > 0 && <section aria-label="Unsaved local drafts" className="rounded border p-3"><h2 className="font-medium">Recovered local drafts</h2>{drafts.map(d => <Button key={d.report.id} variant="link" onClick={() => onLocal(d.report)}>{d.report.title}</Button>)}</section>}
      <Input aria-label="Search reports" placeholder="Search reports across locations…" className="max-w-md" value={query} onChange={e => setQuery(e.target.value)} />
      {(localError || error) && <p role="alert" className="text-sm text-destructive">{localError || error}</p>}
      {!localOnly && locations.filter(l => l.error || l.loading).map(l => <p key={l.url} role={l.error ? 'alert' : 'status'} className="text-sm text-muted-foreground">{locationLabel(l, locations)}: {l.error || 'Checking for report storage…'}</p>)}
      {workers.filter(w => w.error || w.loading).map(w => <p key={w.url} role={w.error ? 'alert' : 'status'} className="text-sm text-muted-foreground">{locations.find(l => l.url === w.url)?.name}: {w.error || 'Loading reports…'}</p>)}
      <div className="overflow-x-auto rounded-lg border"><table className="w-full text-left text-sm"><thead><tr className="border-b bg-muted/40"><th className="p-3">Name</th><th className="p-3">Location</th><th className="p-3">State</th><th className="p-3"><span className="sr-only">Actions</span></th></tr></thead><tbody>
        {localOnly && !query && library.folders.filter(f => f.parentId === folderId).map(f => <tr key={f.id} className="border-b"><td className="p-3"><Button variant="link" onClick={() => onFolder(f.id)}><FolderOpen />{f.name}</Button></td><td className="p-3">On this device</td><td className="p-3">Folder</td><td className="p-3"><Button variant="ghost" onClick={() => { try { deleteLocalFolder(scope, f.id); } catch (e) { setError(reportError(e)); } }}>Delete empty folder</Button></td></tr>)}
        {localRows.map(report => <tr key={`local:${report.id}`} className="border-b last:border-0"><td className="p-3"><Button variant="link" onClick={() => onLocal(report)}><FileText />{report.title}</Button></td><td className="p-3">On this device{library.entries[report.id]?.folderId && ` / ${localFolderPath(library.entries[report.id].folderId, library.folders)}`}</td><td className="p-3">Local</td><td className="p-3"><div className="flex flex-wrap gap-1"><Button size="sm" variant="ghost" onClick={() => onTransfer({ kind: 'local', report }, false)}>Copy to…</Button><Button size="sm" variant="ghost" onClick={() => onTransfer({ kind: 'local', report }, true)}>Move to…</Button><Button size="sm" variant="ghost" onClick={() => { try { exportSavedReport(report); } catch (e) { setError(reportError(e)); } }}>Export</Button><Button size="sm" variant="ghost" onClick={() => { if (confirm(`Delete “${report.title}” from this browser?`)) { try { deleteEvidenceReport(scope, report.id); } catch (e) { setError(reportError(e)); } } }}>Delete</Button></div></td></tr>)}
        {remoteRows.map(({ worker, report }) => <tr key={`${worker.url}:${report.report_id}`} className="border-b last:border-0"><td className="p-3"><Button variant="link" onClick={() => onWorker(worker.url, report.report_id)}><FileText />{report.envelope?.title ?? 'Redacted report'}</Button></td><td className="p-3" title={worker.url}>{locationLabel(locations.find(l => l.url === worker.url)!, locations)}{report.folder_id && ` / ${folderPath(worker.folders.find(f => f.folder_id === report.folder_id) ?? { name: 'Folder', parent_folder_id: null } as FolderRecord, worker.folders)}`}</td><td className="p-3">{report.published_revision_id ? 'Published' : 'Draft'}</td><td className="p-3"><div className="flex flex-wrap gap-1">{!report.redacted && <Button size="sm" variant="ghost" onClick={() => onTransfer({ kind: 'worker', url: worker.url, record: report }, false)}>Copy to…</Button>}{report.allowed_actions.includes('delete') && <Button size="sm" variant="ghost" onClick={() => onTransfer({ kind: 'worker', url: worker.url, record: report }, true)}>Move to…</Button>}</div></td></tr>)}
      </tbody></table>{!localRows.length && !remoteRows.length && !workers.some(w => w.loading) && <p className="p-5 text-sm text-muted-foreground">No reports found.</p>}</div>
    </div>
    {newFolder && <Dialog open onOpenChange={setNewFolder}><DialogContent><DialogHeader><DialogTitle>New folder</DialogTitle><DialogDescription>Creates a folder on this device{folderId ? ` in ${localFolderPath(folderId, library.folders)}` : ''}. To create one on a worker, open that location.</DialogDescription></DialogHeader><form className="space-y-3" onSubmit={e => { e.preventDefault(); try { createLocalFolder(scope, name, folderId); setNewFolder(false); onFolder(folderId); } catch (e) { setError(reportError(e)); } }}><label>Name<Input aria-label="Name" required value={name} onChange={e => setName(e.target.value)} /></label>{error && <p role="alert">{error}</p>}<Button type="submit">Create folder</Button></form></DialogContent></Dialog>}
  </section>;
}
