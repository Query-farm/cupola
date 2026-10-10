import { useEffect, useState, type MouseEvent } from 'react';
import { FileChartColumn, FileText, FolderPlus } from 'lucide-react';
import { SavedDocumentsSidebar } from '../shared/SavedDocumentsSidebar';
import { SavedDocumentRow } from '../shared/SavedDocumentRow';
import { FileTree, type FileTreeNode } from './FileTree';
import { useReportLocations } from './ReportLocations';
import { ReportClient, reportError } from '../../lib/reporting/client';
import { locationLabel } from '../../lib/reporting/locations';
import type { FolderRecord, ReportRow } from '../../lib/reporting/contracts.generated';
import { localLibrary } from '../../lib/reporting/local-library';
import { reportDirectoryNodes, type ReportDirectoryNode } from '../../lib/reporting/file-tree';
import { currentReportNode, REPORT_LIBRARY_CHANGED, REPORT_ROUTE_CHANGED, reportNavigationHref, reportNodeKey, type ReportDestination } from '../../lib/reporting/navigation';
import { EVIDENCE_REPORTS_CHANGED, listEvidenceReports, type EvidenceReport } from '../../lib/evidence/reports';
import { OPEN_REPORT_EVENT, reportHref, type OpenReportDetail } from '../../lib/evidence/open-report';
import { requestSavedDocumentAction, type SavedDocumentAction } from '../../lib/saved-document-actions';
import { actOnSavedReport } from '../../lib/evidence/report-actions';
import { appBase } from '../../lib/app-base';
import { requestTransferSource } from '../../lib/reporting/transfer-source';
import type { TransferSource } from '../../lib/reporting/transfers';

interface LibraryRows { reports: ReportRow[]; folders: FolderRecord[]; loading?: boolean; error?: string }

export function ReportsSidebar({ serviceUrl, workspaceId, search = '', active }: {
  serviceUrl: string; workspaceId?: string; search?: string; active?: boolean;
}) {
  const scope = workspaceId ?? serviceUrl, { locations, refresh, refreshVersion, transfer, setTransfer } = useReportLocations();
  const [local, setLocal] = useState<EvidenceReport[]>([]), [library, setLibrary] = useState<ReturnType<typeof localLibrary>>({ folders: [], entries: {} });
  const [localError, setLocalError] = useState(''), [remote, setRemote] = useState<Record<string, LibraryRows>>({});
  const [selected, setSelected] = useState(currentReportNode);
  const [actionError, setActionError] = useState(''), [preparing, setPreparing] = useState(false);
  useEffect(() => {
    const read = () => queueMicrotask(() => setSelected(currentReportNode()));
    for (const event of ['popstate', OPEN_REPORT_EVENT, REPORT_ROUTE_CHANGED]) window.addEventListener(event, read);
    return () => { for (const event of ['popstate', OPEN_REPORT_EVENT, REPORT_ROUTE_CHANGED]) window.removeEventListener(event, read); };
  }, []);
  useEffect(() => {
    const read = () => { try { setLocal(listEvidenceReports(scope)); setLibrary(localLibrary(scope)); setLocalError(''); } catch (e) { setLocal([]); setLocalError(reportError(e)); } };
    read(); window.addEventListener(EVIDENCE_REPORTS_CHANGED, read); window.addEventListener('storage', read);
    return () => { window.removeEventListener(EVIDENCE_REPORTS_CHANGED, read); window.removeEventListener('storage', read); };
  }, [scope, refreshVersion]);
  useEffect(() => {
    const supported = locations.filter(l => l.info), requests = new Map<string, AbortController>();
    setRemote(old => Object.fromEntries(supported.map(l => [l.url, old[l.url] ?? { reports: [], folders: [], loading: true }])));
    const load = (url: string) => {
      requests.get(url)?.abort(); const abort = new AbortController(); requests.set(url, abort);
      const client = new ReportClient(url);
      void Promise.all([client.call('list_folders', {}, abort.signal), client.call('list_reports', { recursive: true }, abort.signal)])
        .then(([folders, reports]) => { if (!abort.signal.aborted) setRemote(old => ({ ...old, [url]: { folders, reports } })); })
        .catch(e => { if (!abort.signal.aborted) setRemote(old => ({ ...old, [url]: { folders: [], reports: [], error: reportError(e) } })); });
    };
    supported.forEach(l => load(l.url));
    const changed = (event: Event) => { const { url } = (event as CustomEvent<{ url: string }>).detail; if (supported.some(l => l.url === url)) load(url); };
    window.addEventListener(REPORT_LIBRARY_CHANGED, changed);
    return () => { requests.forEach(abort => abort.abort()); window.removeEventListener(REPORT_LIBRARY_CHANGED, changed); };
  }, [locations]);
  const href = (destination: ReportDestination) => reportNavigationHref(serviceUrl, destination, window.location.href, appBase);
  function open(destination: ReportDestination, newFolder = false) {
    const url = new URL(href(destination), window.location.href);
    if (newFolder) url.searchParams.set('report_new_folder', '1');
    window.dispatchEvent(new CustomEvent<OpenReportDetail>(OPEN_REPORT_EVENT, { detail: { serviceUrl, workspaceId, href: url.href } }));
  }
  function navigate(event: MouseEvent<HTMLAnchorElement>, destination: ReportDestination) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); open(destination);
  }
  const act = (id: string, action: SavedDocumentAction) => requestSavedDocumentAction({ kind: 'report', scope, id, action }, () => actOnSavedReport(scope, id, action));
  const destinations = new Map<string, ReportDestination>();
  const sources = new Map<string, TransferSource>([
    ...local.map(report => [reportNodeKey({ location: 'local', reportId: report.id }), { kind: 'local', report }] as const),
    ...locations.flatMap(l => (remote[l.url]?.reports ?? []).map(record => [reportNodeKey({ location: l.url, reportId: record.report_id }), { kind: 'worker', url: l.url, record }] as const)),
  ]);
  function allowed(destination: ReportDestination, action: string) {
    if (destination.reportId) return false;
    if (destination.location === 'local') return true;
    const info = locations.find(l => l.url === destination.location)?.info;
    return Boolean(info?.writable && (destination.folderId ? remote[destination.location]?.folders.find(f => f.folder_id === destination.folderId)?.allowed_actions : info.root_allowed_actions)?.includes(action));
  }
  function canDrag(id: string) {
    const source = sources.get(id);
    return !preparing && !transfer && Boolean(source && (source.kind === 'local' || locations.find(l => l.url === source.url)?.info?.writable && !source.record.redacted && source.record.allowed_actions.some(a => a === 'move' || a === 'delete')));
  }
  function canDrop(sourceId: string, destinationId: string) {
    const source = sources.get(sourceId), destination = destinations.get(destinationId);
    if (!source || !destination || !canDrag(sourceId) || !allowed(destination, 'create_report')) return false;
    const sameStore = destination.location === (source.kind === 'local' ? 'local' : source.url);
    const currentFolder = source.kind === 'local' ? library.entries[source.report.id]?.folderId ?? null : source.record.folder_id;
    return !(sameStore && currentFolder === (destination.folderId ?? null)) && (source.kind === 'local' || source.record.allowed_actions.includes(sameStore ? 'move' : 'delete'));
  }
  async function move(sourceId: string, destinationId?: string) {
    const source = sources.get(sourceId), destination = destinationId ? destinations.get(destinationId) : undefined;
    if (!source || !canDrag(sourceId) || destinationId && !canDrop(sourceId, destinationId)) return;
    setPreparing(true); setActionError('');
    try {
      const current = await requestTransferSource(scope, source);
      // Leave the saved editor before a confirmed move can delete its source.
      open({ location: current.kind === 'local' ? 'local' : current.url, folderId: current.kind === 'local' ? library.entries[current.report.id]?.folderId : current.record.folder_id });
      setTransfer({ source: current, move: true, initialDestination: destination ? { url: destination.location === 'local' ? null : destination.location, folderId: destination.folderId ?? null, name: destination.location === 'local' ? 'Local' : locations.find(l => l.url === destination.location)?.name ?? 'Report library' } : undefined });
    } catch (e) { setActionError(reportError(e)); } finally { setPreparing(false); }
  }
  const folderAction = (destination: ReportDestination, name: string) => allowed(destination, 'create_folder') ? <button type="button" aria-label={`New folder in ${name}`} title={`New folder in ${name}`} className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-ring" onClick={() => open(destination, true)}><FolderPlus aria-hidden className="size-4" /></button> : undefined;
  const nodes = (entries: ReportDirectoryNode[], isLocal = false): FileTreeNode[] => entries.map(entry => {
    destinations.set(entry.id, entry.destination);
    return { ...entry, href: href(entry.destination), children: entry.children && nodes(entry.children, isLocal),
      readOnly: entry.kind === 'folder' && !allowed(entry.destination, 'create_report') && !allowed(entry.destination, 'create_folder'),
      actions: entry.kind === 'folder' ? folderAction(entry.destination, entry.name) : undefined,
      content: entry.kind === 'report' ? <SavedDocumentRow className="min-w-0 flex-1" item={{ id: entry.destination.reportId!, title: entry.name, href: href(entry.destination) }} icon={FileText} active={Boolean(active && selected === entry.id)} documentKind="report" actionsOnHover onAction={isLocal ? act : undefined} onMove={canDrag(entry.id) ? () => void move(entry.id) : undefined} onNavigate={event => navigate(event, entry.destination)} /> : undefined };
  });
  const root = (location: string, name: string, children: FileTreeNode[], detail?: string): FileTreeNode => {
    const destination = { location }, id = reportNodeKey(destination); destinations.set(id, destination);
    return { id, name, kind: 'location', children, href: href(destination), detail, actions: folderAction(destination, name), readOnly: !allowed(destination, 'create_report') && !allowed(destination, 'create_folder') };
  };
  const allNodes = [
    ...locations.filter(l => l.info).map(l => root(l.url, locationLabel(l, locations), nodes(reportDirectoryNodes(l.url,
      (remote[l.url]?.folders ?? []).map(f => ({ id: f.folder_id, name: f.name, parentId: f.parent_folder_id })),
      (remote[l.url]?.reports ?? []).map(r => ({ id: r.report_id, name: r.envelope?.title ?? 'Redacted report', folderId: r.folder_id })))), l.name)),
    root('local', 'Local', nodes(reportDirectoryNodes('local', library.folders, local.map(r => ({ id: r.id, name: r.title, folderId: library.entries[r.id]?.folderId ?? null }))), true), 'Saved in this browser'),
  ];
  const filter = (items: FileTreeNode[]): FileTreeNode[] => items.flatMap(node => {
    if (node.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())) return [node];
    const children = filter(node.children ?? []); return children.length ? [{ ...node, children }] : [];
  });
  const errors = [...locations.filter(l => l.error).map(l => `${l.name}: ${l.error}`), ...locations.filter(l => remote[l.url]?.error).map(l => `${l.name}: ${remote[l.url].error}`)];
  const items = [
    ...local.map(r => ({ id: r.id, title: r.title, href: href({ location: 'local', reportId: r.id }) })),
    ...locations.flatMap(l => (remote[l.url]?.reports ?? []).map(r => ({ id: `${l.url}:${r.report_id}`, title: r.envelope?.title ?? 'Redacted report', href: href({ location: l.url, reportId: r.report_id }) }))),
  ];
  return <section className="mt-2 border-t border-border pt-2">
    <SavedDocumentsSidebar title="Reports" documentKind="report" icon={FileChartColumn} itemIcon={FileText} openKey="cupola.sidebar.reports-open" testId="sidebar-reports-toggle"
      items={items}
      search={search} libraryHref={href({ location: 'all' })} libraryActive={active && selected === reportNodeKey({ location: 'all' })} onNavigate={event => navigate(event, { location: 'all' })} onAction={act}
      onCreate={() => window.dispatchEvent(new CustomEvent<OpenReportDetail>(OPEN_REPORT_EVENT, { detail: { serviceUrl, workspaceId, create: true, href: reportHref(serviceUrl, undefined, true) } }))} createLabel="New report" error={localError || undefined}>
      <FileTree nodes={search ? filter(allNodes) : allNodes} label="Reports" selectedId={active ? selected : undefined} initialExpandedIds={[reportNodeKey({ location: 'local' })]} expandAll={Boolean(search)} autoFocusSelection={false}
        dragDrop={{ canDrag, canDrop, onDrop: (source, destination) => void move(source, destination) }}
        onSelect={id => { const destination = destinations.get(id); if (destination) open(destination); }} onNavigate={(event, id) => { const destination = destinations.get(id); if (destination) navigate(event, destination); }} />
      {(locations.some(l => l.loading) || Object.values(remote).some(r => r.loading)) && <p role="status" className="px-2 py-1 text-xs text-muted-foreground">Loading reports…</p>}
      {errors.length > 0 && <div className="px-2 py-1 text-xs text-destructive"><p role="alert">{errors.join(' ')}</p><button className="underline" onClick={refresh}>Retry report libraries</button></div>}
      {actionError && <p role="alert" className="px-2 py-1 text-xs text-destructive">{actionError}</p>}
    </SavedDocumentsSidebar>
  </section>;
}
