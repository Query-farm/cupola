import { useEffect, useState } from 'react';
import { Button } from '../ui/button';
import { EvidenceWorkspace } from '../evidence/EvidenceWorkspace';
import { ReportLibrary } from './ReportLibrary';
import { ReportOverview } from './ReportOverview';
import { TransferDialog } from './TransferDialog';
import { reportError } from '../../lib/reporting/client';
import { useReportLocations } from './ReportLocations';
import { REPORT_ROUTE_CHANGED } from '../../lib/reporting/navigation';
import { OPEN_REPORT_EVENT, reportHref, type OpenReportDetail } from '../../lib/evidence/open-report';
import { saveEvidenceReport, type EvidenceReport } from '../../lib/evidence/reports';
import { newEvidenceReport } from '../../lib/evidence/templates';
import { placeLocalReport } from '../../lib/reporting/local-library';
import { forgetTransfer, resumeTransfer, transferJobs, type TransferJob, type TransferSource } from '../../lib/reporting/transfers';
import type { CatalogData } from '../../lib/service';
import { hasReportPromotion } from '../../lib/reports/events';
import { appBase } from '../../lib/app-base';

export interface ReportingWorkspaceProps {
  catalogName: string; serviceUrl: string; workspaceId?: string; catalogs: readonly CatalogData[]; defaultToLibrary?: boolean;
  onCreateLocal?: () => void; onTransferReport?: (source: TransferSource, move: boolean) => void;
}
const route = () => {
  const search = new URLSearchParams(location.search);
  if (hasReportPromotion()) return { selected: 'local', localEditor: true, localFolder: null };
  return { selected: search.get('report_service') ?? (search.has('evidence_report') || search.has('evidence_new') ? 'local' : 'all'),
    localEditor: search.has('evidence_report') || search.has('evidence_new'), localFolder: search.get('local_report_folder') };
};
export function ReportingWorkspace(props: ReportingWorkspaceProps) {
  const [view, setView] = useState(() => {
    const current = route();
    // The original /evidence preview link still opens its example directly.
    return props.defaultToLibrary === false && current.selected === 'all' && /\/evidence\/?$/.test(location.pathname)
      ? { ...current, selected: 'local', localEditor: true } : current;
  });
  const { locations: services, refresh: refreshLocations } = useReportLocations();
  const [generation, setGeneration] = useState(0);
  const [transfer, setTransfer] = useState<{ source: TransferSource; move: boolean } | null>(null);
  const [jobs, setJobs] = useState<TransferJob[]>([]), [notice, setNotice] = useState(''), [error, setError] = useState(''), [retrying, setRetrying] = useState(false);
  const [editorKey, setEditorKey] = useState(0);
  const scope = props.workspaceId ?? props.serviceUrl;
  useEffect(() => {
    const url = new URL(location.href);
    if (!/\/(?:reports|evidence)(?:\/|$)/.test(url.pathname)) {
      url.pathname = `${appBase.replace(/\/$/, '')}/reports`;
      history.replaceState({}, '', url);
    }
  }, []);
  function refresh() { refreshLocations(); setGeneration(n => n + 1); try { setJobs(transferJobs(scope)); } catch (e) { setError(reportError(e)); } }
  useEffect(() => { try { setJobs(transferJobs(scope)); } catch (e) { setError(reportError(e)); } }, [scope, generation]);
  useEffect(() => {
    const pop = () => { setView(route()); setEditorKey(n => n + 1); };
    const local = (event: Event) => {
      const detail = (event as CustomEvent<OpenReportDetail>).detail;
      if ((detail.workspaceId ?? detail.serviceUrl) !== scope) return;
      const next = new URL(detail.href, location.href);
      if (location.pathname + location.search === next.pathname + next.search) return;
      history.pushState({}, '', next); window.dispatchEvent(new Event(REPORT_ROUTE_CHANGED)); pop();
    };
    window.addEventListener('popstate', pop); window.addEventListener(OPEN_REPORT_EVENT, local);
    return () => { window.removeEventListener('popstate', pop); window.removeEventListener(OPEN_REPORT_EVENT, local); };
  }, [scope]);
  useEffect(() => {
    const promote = () => {
      if (view.selected === 'local' && view.localEditor) return; // The mounted editor consumes it.
      history.pushState({}, '', reportHref(props.serviceUrl, undefined, true));
      window.dispatchEvent(new Event(REPORT_ROUTE_CHANGED)); setView(route()); setEditorKey(n => n + 1);
    };
    window.addEventListener('cupola:promote-report', promote);
    return () => window.removeEventListener('cupola:promote-report', promote);
  }, [view.selected, view.localEditor, props.serviceUrl]);
  function choose(value: string, reportId?: string, folderId?: string | null) {
    const url = new URL(location.href);
    url.pathname = `${appBase.replace(/\/$/, '')}/reports${value === 'local' && !reportId ? '/saved' : ''}`;
    url.searchParams.set('report_service', value);
    for (const key of ['report_id', 'report_revision', 'report_folder', 'evidence_report', 'evidence_new', 'evidence_view', 'evidence_edit', 'local_report_folder']) url.searchParams.delete(key);
    for (const key of [...url.searchParams.keys()]) if (key.startsWith('p.')) url.searchParams.delete(key);
    if (reportId) url.searchParams.set('report_id', reportId);
    if (value === 'local' && folderId) url.searchParams.set('local_report_folder', folderId);
    if (!['local', 'all'].includes(value) && folderId) url.searchParams.set('report_folder', folderId);
    history.pushState({}, '', url); window.dispatchEvent(new Event(REPORT_ROUTE_CHANGED)); setView(route()); setEditorKey(n => n + 1);
  }
  function openLocal(report: EvidenceReport, editing = false) {
    const url = new URL(reportHref(props.serviceUrl, report.id), location.href);
    if (editing) url.searchParams.set('evidence_edit', '1');
    history.pushState({}, '', url); window.dispatchEvent(new Event(REPORT_ROUTE_CHANGED)); setView(route()); setEditorKey(n => n + 1);
  }
  function createLocal() {
    try {
      const report = saveEvidenceReport({ ...newEvidenceReport(props.serviceUrl, props.catalogName), workspaceId: props.workspaceId });
      if (view.selected === 'local' && view.localFolder) placeLocalReport(scope, report.id, view.localFolder);
      openLocal(report, true);
    } catch (e) { setError(`Could not save locally: ${reportError(e)}`); }
  }
  function transferReport(source: TransferSource, move: boolean) {
    // Unmount the editor after its save, before a move can remove its source.
    // Otherwise an editor's unmount autosave could recreate a deleted report.
    choose(source.kind === 'local' ? 'local' : source.url);
    setTransfer({ source, move });
  }
  function completed(job: TransferJob) {
    setTransfer(null); setError(''); setNotice(`${job.move ? 'Moved' : 'Copied'} “${job.envelope.title}” to ${job.destination.name}.`);
    choose(job.destination.url ?? 'local', undefined, job.destination.folderId); refresh();
  }
  return <div className="flex h-full min-h-0 flex-col">
    {notice && <p role="status" className="shrink-0 px-5 py-2 text-sm">{notice}</p>}
    {error && <p role="alert" className="shrink-0 px-5 py-2 text-sm text-destructive">{error}</p>}
    {jobs.length > 0 && <section aria-label="Pending report transfers" className="shrink-0 space-y-2 border-b px-5 py-3 text-sm">{jobs.map(job => <div key={job.id} className="flex flex-wrap items-center gap-2"><span>Unconfirmed {job.move ? 'move' : 'copy'}: {job.envelope.title} → {job.destination.name}</span><Button size="sm" disabled={retrying} onClick={async () => { setRetrying(true); setError(''); try { completed(await resumeTransfer(job)); } catch (e) { setError(reportError(e)); } finally { setRetrying(false); } }}>Retry transfer</Button><Button size="sm" variant="ghost" disabled={retrying} onClick={() => { if (confirm('Stop retrying this transfer? Its copy or move may already have completed. Check both locations before deleting anything.')) { forgetTransfer(job); refresh(); } }}>Stop retrying…</Button></div>)}</section>}
    <div className="min-h-0 flex-1">{view.selected === 'all' || view.selected === 'local' && !view.localEditor
      ? <ReportOverview key={`${view.selected}:${view.localFolder ?? ''}`} locations={services} scope={scope} serviceUrl={props.serviceUrl} workspaceId={props.workspaceId} localOnly={view.selected === 'local'} folderId={view.localFolder} onAllReports={() => choose('all')} onFolder={id => choose('local', undefined, id)} onNew={createLocal} onLocal={openLocal} onWorker={(url, id) => choose(url, id)} onTransfer={transferReport} onRefresh={refresh} />
      : view.selected === 'local'
        ? <EvidenceWorkspace key={editorKey} {...props} onLibrary={() => choose('local')} onTransfer={(report, move) => transferReport({ kind: 'local', report }, move)} />
        : <ReportLibrary key={view.selected + ':' + editorKey} {...props} libraryUrl={view.selected} onAllReports={() => choose('all')} onCreateLocal={createLocal} onTransferReport={transferReport} />}</div>
    {transfer && <TransferDialog {...transfer} locations={services} scope={scope} serviceUrl={props.serviceUrl} workspaceId={props.workspaceId} onClose={() => { setTransfer(null); refresh(); }} onComplete={completed} />}
  </div>;
}
