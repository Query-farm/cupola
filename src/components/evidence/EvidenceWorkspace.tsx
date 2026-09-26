import { sessionCatalogs } from "@/lib/catalog-store";
import { EvidenceQueryRun } from '../../lib/evidence/query-run';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ArrowLeft, Code2, Copy, FileText, FolderOpen, Plus, RefreshCw, Save, Search, Trash2, Eye, Maximize2, Minimize2, Square, FileDown, MoreHorizontal } from 'lucide-react';
import { Button, buttonVariants } from '../ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { Input } from '../ui/input';
import { engine, waitForEngineReady } from '../../lib/shell-bridge';
import { compileReportQuery } from '../../lib/reports/parameters';
import { compilerParameters, deleteEvidenceReport, listEvidenceReports, resolveParameters, saveEvidenceReport, STORAGE_PREFIX, LEGACY_STORAGE_PREFIX, type EvidenceReport } from '../../lib/evidence/reports';
import { newEvidenceReport } from '../../lib/evidence/templates';
import { isWeatherService } from '../../lib/evidence/weather';
import { quoteIdentifier } from '../../lib/evidence/data-browser';
import type { EvidenceDataContext } from '../../lib/evidence/data-browser';
import type { QueryLogEntry } from '../../lib/evidence/haybarn-query-service';
import { ParameterInput } from './EvidenceParameters';
import type { EvidenceIssue } from '../../lib/evidence/editor-support';
import type { CatalogData } from '../../lib/service';
import { prepareEvidenceSemanticDatasets, type SemanticDatasetState } from '../../lib/evidence/semantic-datasets';
import { EvidencePivot } from './EvidencePivot';
import { consumeReportPromotion } from '../../lib/reports/events';
import { useReportTheme } from './useReportTheme';
import { EvidenceEditor } from './EvidenceEditor';
import { EvidencePreview, type ReportRun } from './EvidencePreview';
import { useReportPrint } from './useReportPrint';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const isLibraryUrl = () => (window.location.pathname.endsWith('/evidence/reports') || window.location.pathname.endsWith('/reports/saved')) || new URLSearchParams(window.location.search).get('evidence_view') === 'library';

export function EvidenceWorkspace({ catalogName, serviceUrl, catalogs, defaultToLibrary = true }: { catalogName: string; serviceUrl: string; catalogs: readonly CatalogData[]; defaultToLibrary?: boolean }) {
  const [initial] = useState(() => {
    let reports: EvidenceReport[] = [], error = '';
    try { reports = listEvidenceReports(serviceUrl); } catch (e) { error = `Could not read saved reports: ${message(e)}`; }
    const id = new URLSearchParams(window.location.search).get('evidence_report');
    const found = reports.find(report => report.id === id);
    const report = found ?? newEvidenceReport(serviceUrl, catalogName, isWeatherService(serviceUrl));
    return { reports, report, error, saved: found ? JSON.stringify(found) : '', library: isLibraryUrl() || (!found && (defaultToLibrary || Boolean(id))) };
  });
  const [promotion, setPromotion] = useState(consumeReportPromotion);
  const [report, setReport] = useState(initial.report);
  const reportTheme = useReportTheme(report.appearance);
  const [saved, setSaved] = useState(initial.saved);
  const [reports, setReports] = useState(initial.reports);
  const [library, setLibrary] = useState(initial.library);
  const [hasOpenedReport, setHasOpenedReport] = useState(!initial.library);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(false);
  const [focused, setFocused] = useState(false);
  const [editorOnly, setEditorOnly] = useState(false);
  const [editorWidth, setEditorWidth] = useState(() => {
    try {
      const stored = Number(localStorage.getItem('cupola.evidence.editor-width'));
      return stored >= 25 && stored <= 70 ? stored : 36;
    } catch { return 36; }
  });
  const split = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  function resizeEditor(width: number) {
    const next = Math.min(70, Math.max(25, width));
    setEditorWidth(next);
    try { localStorage.setItem('cupola.evidence.editor-width', String(next)); } catch { /* Layout still works without storage. */ }
  }

  const [specIssues, setSpecIssues] = useState<EvidenceIssue[]>([]);
  const workspace = useRef<HTMLDivElement>(null);
  const [error, setError] = useState(initial.error);
  const [notice, setNotice] = useState('');
  const [status, setStatus] = useState('Ready to run');
  const [busy, setBusy] = useState(false);
  const execution = useRef<EvidenceQueryRun | null>(null);
  const [pendingQueries, setPendingQueries] = useState(0);
  const refreshing = busy || pendingQueries > 0;
  function stopRefresh() {
    execution.current?.stop();
    setStatus('Refresh stopped');
    setNotice('Report refresh stopped. Refresh again to reload the report.');
  }
  const semanticTables = useRef(new Set<string>());
  const [semanticStates, setSemanticStates] = useState<SemanticDatasetState[]>([]);
  const [dataContext, setDataContext] = useState<EvidenceDataContext | null>(null);
  const [run, setRun] = useState<ReportRun | null>(null);
  const [updated, setUpdated] = useState('');
  useReportPrint(workspace, !library && Boolean(run));
  const [exporting, setExporting] = useState(false);
  async function exportPdf() {
    const root = workspace.current?.querySelector('[data-testid="evidence-preview"]')?.shadowRoot?.querySelector('[data-markdoc-content]');
    if (!run || !root) return;
    setExporting(true); setError(''); setNotice('Preparing PDF…');
    try {
      const { exportReportPdf, pdfFileName } = await import('../../lib/evidence/typst/export-pdf');
      const meta = [
        ...(updated ? [{ label: 'Updated', value: updated }] : []),
        ...run.report.parameters.map(parameter => ({ label: parameter.label, value: String(run.values[parameter.key] ?? '—') })),
      ];
      const { pdf, omitted } = await exportReportPdf({
        root, title: report.title, meta, fonts: reportTheme.config.fonts,
        accent: reportTheme.mode === 'light' ? (reportTheme.style as Record<string, string>)['--primary'] : undefined,
      });
      const url = URL.createObjectURL(pdf);
      const link = Object.assign(document.createElement('a'), { href: url, download: pdfFileName(report.title) });
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      const skipped = [...new Set(omitted)].map(name => name.replaceAll('_', ' '));
      setNotice(skipped.length ? `PDF exported. Not included: ${skipped.join(', ')}.` : 'PDF exported.');
    } catch (cause) {
      setNotice('');
      setError(`PDF export failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally { setExporting(false); }
  }
  const [logs, setLogs] = useState<QueryLogEntry[]>([]);
  const booted = useRef(false);
  const busyRef = useRef(false);
  const revision = useRef(0);
  const dirty = JSON.stringify(report) !== saved;
  const reportRef = useRef(report); reportRef.current = report;
  const baseline = useRef(JSON.stringify(initial.report));
  const dirtyRef = useRef(false); dirtyRef.current = JSON.stringify(report) !== baseline.current;

  useEffect(() => {
    if (!focused || !workspace.current) return;
    // Focus mode covers the app; keep the covered chrome out of keyboard navigation.
    const covered: { element: HTMLElement; inert: boolean }[] = [];
    let current: HTMLElement = workspace.current;
    while (current.parentElement) {
      for (const sibling of current.parentElement.children) {
        if (sibling !== current && sibling instanceof HTMLElement) {
          covered.push({ element: sibling, inert: sibling.inert });
          sibling.inert = true;
        }
      }
      current = current.parentElement;
      if (current === document.body) break;
    }
    return () => { for (const { element, inert } of covered) element.inert = inert; };
  }, [focused]);

  function reloadList() {
    try { setReports(listEvidenceReports(serviceUrl)); }
    catch (e) { setError(`Could not read saved reports: ${message(e)}`); }
  }
  function navigate(showLibrary: boolean, id?: string, replace = false) {
    const url = new URL(window.location.href);
    url.pathname = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/reports${showLibrary ? '/saved' : ''}`;
    url.searchParams.delete('evidence_view');
    url.searchParams.set('service', serviceUrl);
    if (id) url.searchParams.set('evidence_report', id); else url.searchParams.delete('evidence_report');
    window.history[replace ? 'replaceState' : 'pushState']({}, '', url);
    setLibrary(showLibrary);
    if (showLibrary) setFocused(false);
    if (showLibrary) { setRun(null); reloadList(); }
  }
  async function refresh(next = report) {
    if (busyRef.current) return;
    execution.current?.stop();
    const current = new EvidenceQueryRun(count => { if (execution.current === current) setPendingQueries(count); });
    execution.current = current;
    setPendingQueries(0);
    busyRef.current = true;
    setBusy(true); setSemanticStates([]); setDataContext(null); setError(''); setNotice(''); setLogs([]); setSpecIssues([]);
    try {
      if (next.serviceUrl !== serviceUrl) throw new Error('Open this report using its saved service connection.');
      const values = resolveParameters(next);
      setStatus('Waiting for engine…');
      await current.wait(waitForEngineReady());
      current.signal.throwIfAborted();
      if (!engine.queryPrepared || engine.bootError) throw new Error(engine.bootError || 'Haybarn is not ready');
      // Unmount the old document before replacing its temporary datasets.
      setRun(null);
      setStatus('Refreshing report…');
      for (const name of semanticTables.current) {
        const dropped = await current.query(`DROP TABLE IF EXISTS temp.main.${quoteIdentifier(name)}`);
        if (!dropped.ok) throw new Error(dropped.error || 'Could not replace semantic dataset');
        semanticTables.current.delete(name);
      }
      if (next.setupSql.trim()) {
        const compiled = compileReportQuery(next.setupSql, compilerParameters(next, values), values);
        const start = performance.now();
        const response = await current.query(compiled.sql, compiled.params);
        setLogs([{ sql: next.setupSql, rows: 0, durationMs: performance.now() - start, error: response.ok ? null : response.error || 'Dataset setup failed' }]);
        if (!response.ok) throw new Error(response.error || 'Dataset setup failed');
      }
      const semanticCatalogs = next.semanticDatasets?.length ? await current.wait(sessionCatalogs(catalogs)) : catalogs;
      const semantic = await prepareEvidenceSemanticDatasets(next, values, semanticCatalogs, name => semanticTables.current.add(name), current);
      current.signal.throwIfAborted();
      setSemanticStates(semantic.states);
      setRun({ execution: current, report: structuredClone(next), values, semanticQueries: semantic.queries, semanticStates: semantic.states, revision: ++revision.current });
      setUpdated(new Date().toLocaleTimeString());
      setStatus('Connected');
    } catch (e) {
      if (current.signal.aborted) setStatus('Refresh stopped');
      else { setError(message(e)); setStatus('Refresh failed'); }
    }
    finally { busyRef.current = false; setBusy(false); }
  }
  useEffect(() => {
    if (!booted.current) {
      booted.current = true;
      if (initial.library) navigate(true, undefined, true);
      else if (!initial.library && !initial.error) void refresh(initial.report);
    }
    const changed = (event: StorageEvent) => { if (event.key === null || event.key.startsWith(STORAGE_PREFIX) || event.key.startsWith(LEGACY_STORAGE_PREFIX)) reloadList(); };
    const unload = (event: BeforeUnloadEvent) => { if (dirtyRef.current) { event.preventDefault(); event.returnValue = ''; } };
    const pop = () => {
      if (isLibraryUrl()) { setRun(null); setLibrary(true); reloadList(); return; }
      const id = new URLSearchParams(window.location.search).get('evidence_report');
      if (!id || id === reportRef.current.id) { setLibrary(false); void refresh(reportRef.current); return; }
      try {
        const found = listEvidenceReports(serviceUrl).find(item => item.id === id);
        if (found) openReport(found, false); else { setError(''); navigate(true, undefined, true); }
      } catch (e) { setError(message(e)); }
    };
    window.addEventListener('storage', changed);
    window.addEventListener('beforeunload', unload);
    window.addEventListener('popstate', pop);
    return () => { execution.current?.stop(); window.removeEventListener('storage', changed); window.removeEventListener('beforeunload', unload); window.removeEventListener('popstate', pop); };
  }, []);

  useEffect(() => {
    const promoted = () => setPromotion(consumeReportPromotion());
    window.addEventListener('cupola:promote-report', promoted);
    return () => window.removeEventListener('cupola:promote-report', promoted);
  }, []);
  useEffect(() => {
    if (!promotion || busy) return;
    setPromotion(null);
    const next = newEvidenceReport(serviceUrl, catalogName);
    next.title = promotion.title || 'New report';
    if (promotion.kind === 'semantic') {
      next.semanticDatasets = [{ id: crypto.randomUUID(), kind: 'semantic', name: 'model_data', query: promotion.query }];
      next.source = `# ${next.title}\n\n${promotion.markdown || ''}\n\n{% table data="model_data" /%}`;
    } else next.source = `# ${next.title}\n\n${promotion.markdown || ''}\n\n\`\`\`sql query_data\n${promotion.sql}\n\`\`\`\n\n{% table data="query_data" /%}`;
    openReport(next, true, true);
  }, [promotion, busy]);

  function change(next: EvidenceReport) { setReport(next); setNotice(''); }
  function save(copy = false) {
    try {
      const input = copy ? { ...report, id: crypto.randomUUID(), title: `${report.title} (copy)`, createdAt: Date.now() } : report;
      const next = saveEvidenceReport(input);
      setReport(next); setSaved(JSON.stringify(next)); baseline.current = JSON.stringify(next); reloadList();
      setError(''); setNotice('');
      navigate(false, next.id, true);
    } catch (e) { setError(`Could not save report: ${message(e)}`); }
  }
  function openReport(next: EvidenceReport, updateUrl = true, fresh = false) {
    if (busyRef.current) return;
    if (next.id !== reportRef.current.id && dirtyRef.current && !window.confirm('Discard unsaved changes to the current report?')) return;
    setReport(next); setHasOpenedReport(true); setSaved(fresh ? '' : JSON.stringify(next)); baseline.current = JSON.stringify(next); setEditing(fresh); setEditorOnly(false);
    setError(''); setNotice(''); setRun(null); setUpdated(''); setLibrary(false);
    if (updateUrl) navigate(false, fresh ? undefined : next.id);
    void refresh(next);
  }
  function copySavedReport(item: EvidenceReport) {
    try {
      saveEvidenceReport({ ...item, id: crypto.randomUUID(), title: `${item.title} (copy)`, createdAt: Date.now() });
      setError(''); setNotice(''); reloadList();
    } catch (e) { setError(`Could not copy report: ${message(e)}`); }
  }
  function remove(item: EvidenceReport) {
    if (!window.confirm(`Delete “${item.title}” from this browser?`)) return;
    try {
      deleteEvidenceReport(serviceUrl, item.id); reloadList();
      if (item.id === report.id) setSaved('');
      setError(''); setNotice('Report deleted.');
    } catch (e) { setError(`Could not delete report: ${message(e)}`); }
  }
  const visible = reports.filter(item => `${item.title} ${item.serviceUrl}`.toLowerCase().includes(search.toLowerCase()));
  const pending = run && (run.report.source !== report.source || run.report.setupSql !== report.setupSql || JSON.stringify(run.report.parameters) !== JSON.stringify(report.parameters) || JSON.stringify(run.report.values) !== JSON.stringify(report.values) || JSON.stringify(run.report.semanticDatasets) !== JSON.stringify(report.semanticDatasets));

  const issues: EvidenceIssue[] = [...specIssues, ...logs.filter(log => log.error).map(log => ({
    message: log.error!, severity: 'error' as const, target: log.sql === report.setupSql ? 'data' as const : 'document' as const, sql: log.sql,
  }))];

  const errorCount = issues.filter(issue => issue.severity === 'error').length;
  // "Connected" is the normal state: kept for assistive tech, shown only when it isn't.
  const quietStatus = pendingQueries === 0 && status === 'Connected';

  return <div ref={workspace} className={`${focused ? 'fixed inset-0 z-50' : 'h-full'} flex min-h-0 flex-col overflow-hidden bg-background text-foreground`} onKeyDown={event => {
    if (event.defaultPrevented) return;
    if (event.key === 'Escape' && focused) { setFocused(false); setEditorOnly(false); event.stopPropagation(); }
    if (library || !(event.metaKey || event.ctrlKey)) return;
    if (event.key === 'Enter') { event.preventDefault(); void refresh(); }
    if (event.key.toLowerCase() === 's') { event.preventDefault(); if (!busy) save(); }
  }}>
    <header className="z-10 flex shrink-0 flex-wrap items-center gap-3 border-b bg-card px-5 py-3">
      {library ? <><FolderOpen className="size-4 text-muted-foreground" /><h1 className="text-sm font-semibold">Saved reports</h1><span className="text-xs text-muted-foreground">{reports.length} {reports.length === 1 ? 'report' : 'reports'}</span>
        <div className="ml-auto flex gap-2">{hasOpenedReport && <Button variant="outline" disabled={busy} onClick={() => { navigate(false, saved ? report.id : undefined); if (!run) void refresh(); }}>Back to report</Button>}<Button onClick={() => openReport(newEvidenceReport(serviceUrl, catalogName), true, true)} disabled={busy}><Plus />New report</Button></div></>
        : <>
          <Button variant="ghost" size="sm" className="-ml-2" onClick={() => navigate(true)}><ArrowLeft />Saved reports</Button>
          <span className="text-muted-foreground" aria-hidden>/</span>
          <div className="flex min-w-0 flex-col">
            <span className="max-w-72 truncate text-sm font-semibold">{report.title}</span>
            <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
              <span role="status">{dirty ? (saved ? 'Unsaved changes' : 'Not saved yet') : 'Saved'}</span>
              {(updated || !quietStatus) && <span aria-hidden>·</span>}
              <span role="status" aria-label="Report refresh status">
                <span className={quietStatus ? 'sr-only' : ''}>{pendingQueries > 0 ? 'Refreshing report…' : status}</span>
                {updated && <span>{quietStatus ? '' : ' · '}Updated {updated}</span>}
              </span>
            </span>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg bg-muted p-1" role="group" aria-label="Report mode">
              <Button variant={editing ? 'ghost' : 'outline'} size="sm" aria-pressed={!editing} aria-label="View report" onClick={() => { setEditing(false); setEditorOnly(false); }}><Eye />View</Button>
              <Button variant={editing ? 'outline' : 'ghost'} size="sm" aria-pressed={editing} aria-label="Edit report" title={errorCount ? `${errorCount} report problems` : undefined} onClick={() => setEditing(true)}>
                <Code2 />Edit
                {errorCount > 0 && <span className="rounded-full bg-destructive px-1.5 text-[10px] leading-4 font-semibold text-white" data-testid="report-problem-count">{errorCount}</span>}
              </Button>
            </div>
            {/* One slot: Refresh while idle, Stop while a refresh runs. The dot says
                edits are waiting to be applied (it replaced a "Changes not applied" banner). */}
            {refreshing
              ? <Button variant="outline" onClick={stopRefresh}><Square />Stop refresh</Button>
              : <Button variant="field" aria-label={editing ? 'Update preview' : 'Refresh report'} title={`${pending ? 'Changes not applied · ' : ''}⌘ / Ctrl + Enter`} onClick={() => void refresh()}>
                  <RefreshCw />{editing ? 'Update preview' : 'Refresh report'}
                  {pending && <span role="status" aria-label="Changes not applied" className="size-2 rounded-full bg-amber-400" />}
                </Button>}
            {!editing && <Button variant="outline" disabled={refreshing || !run || exporting} onClick={() => void exportPdf()} title="Download the report as a typeset PDF · The selected tab of each tab group, and every table row"><FileDown />{exporting ? 'Exporting…' : 'Export PDF'}</Button>}
            {dirty && <Button variant="outline" disabled={busy} onClick={() => save()} title="Save in this browser · ⌘ / Ctrl + S"><Save />Save report</Button>}
            {focused
              ? <Button variant="ghost" size="icon" aria-label="Exit focus mode" title="Exit focus mode · Esc" onClick={() => { setEditorOnly(false); setFocused(false); }}><Minimize2 /></Button>
              : <DropdownMenu>
                  <DropdownMenuTrigger aria-label="More report actions" className={buttonVariants({ variant: 'ghost', size: 'icon' })}><MoreHorizontal /></DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-44">
                    {editing && <DropdownMenuItem disabled={refreshing || !run || exporting} onClick={() => void exportPdf()}><FileDown />Export PDF</DropdownMenuItem>}
                    <DropdownMenuItem disabled={busy} onClick={() => save(true)}><Copy />Save a copy</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => setFocused(true)}><Maximize2 />Focus report</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>}
          </div></>}

    </header>
    {error && <div role="alert" className="m-5 whitespace-pre-wrap rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
    {notice && <p role="status" className="mx-5 mt-3 text-xs text-muted-foreground">{notice}</p>}
    <section hidden={!library} className="mx-auto w-full max-w-6xl flex-1 overflow-auto space-y-5 p-5" aria-label="Saved reports list">
      <p className="text-sm text-muted-foreground">Reports for this worker are saved in this browser, including source, parameter definitions, and selected values. Data is refreshed when you open a report.</p>
      <div className="relative max-w-sm"><Search className="absolute left-2.5 top-2 size-4 text-muted-foreground" /><Input className="pl-8" aria-label="Search saved reports" placeholder="Search reports…" value={search} onChange={e => setSearch(e.target.value)} /></div>
      {visible.length ? <div className="overflow-x-auto rounded-lg border bg-card"><table className="w-full text-left text-sm"><thead className="border-b bg-muted/40 text-xs text-muted-foreground"><tr><th className="px-4 py-3">Report</th><th className="px-4 py-3">Parameters</th><th className="px-4 py-3">Last saved</th><th className="px-4 py-3"><span className="sr-only">Actions</span></th></tr></thead><tbody>{visible.map(item => <tr key={item.id} className="border-b last:border-0">
        <td className="px-4 py-3">
          {item.serviceUrl === serviceUrl
            ? <Button variant="link" className="h-auto justify-start whitespace-normal p-0 text-left font-medium" disabled={busy} onClick={() => openReport(item)}>{item.title}</Button>
            : <a className="font-medium text-primary underline-offset-4 hover:underline" href={`${import.meta.env.BASE_URL.replace(/\/$/, '')}/reports?service=${encodeURIComponent(item.serviceUrl)}&evidence_report=${encodeURIComponent(item.id)}`}>{item.title}</a>}
          <span className="mt-1 block max-w-sm truncate text-xs text-muted-foreground">{item.serviceUrl}</span>
        </td><td className="px-4 py-3 text-xs text-muted-foreground">{item.parameters.map(p => p.label).join(', ') || 'None'}</td><td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">{new Date(item.updatedAt).toLocaleString()}</td>
        <td className="px-4 py-3"><div className="flex justify-end gap-2">{item.serviceUrl === serviceUrl ? <Button variant="outline" disabled={busy} onClick={() => openReport(item)}>Open report</Button> : <a className="text-xs text-primary underline" href={`${import.meta.env.BASE_URL.replace(/\/$/, '')}/evidence?service=${encodeURIComponent(item.serviceUrl)}&evidence_report=${encodeURIComponent(item.id)}`}>Open service</a>}<Button variant="ghost" size="icon" aria-label={`Copy ${item.title}`} title="Copy report" onClick={() => copySavedReport(item)}><Copy /></Button><Button variant="ghost" size="icon" aria-label={`Delete ${item.title}`} onClick={() => remove(item)}><Trash2 /></Button></div></td>
      </tr>)}</tbody></table></div> : <div className="rounded-lg border border-dashed p-12 text-center"><FileText className="mx-auto mb-3 size-7 text-muted-foreground" /><h2 className="text-sm font-semibold">{reports.length ? 'No matching reports' : 'No saved reports yet'}</h2><p className="mt-2 text-xs text-muted-foreground">{reports.length ? 'Try a different search.' : 'Save your current report or create a new one to start your library.'}</p></div>}
      {isWeatherService(serviceUrl) && <Button variant="outline" disabled={busy} onClick={() => openReport(newEvidenceReport(serviceUrl, catalogName, true), true, true)}>Use weather example</Button>}
    </section>
    <main hidden={library} className="min-h-0 flex-1 flex-col" style={{ display: library ? 'none' : 'flex' }}>
      <div ref={split} style={{ '--evidence-editor-width': `clamp(280px, ${editorWidth}%, calc(100% - 288px))` } as CSSProperties} className={`grid min-h-0 flex-1 ${editing && !editorOnly ? 'grid-rows-[minmax(360px,1fr)_minmax(360px,1fr)] overflow-auto lg:grid-rows-1 lg:grid-cols-[minmax(0,1fr)_8px_var(--evidence-editor-width)] lg:overflow-hidden' : 'grid-rows-1'}`}>
        <section style={{ display: editing && editorOnly ? 'none' : undefined }} aria-label={editing ? 'Report preview' : 'Report viewer'} className="flex min-h-0 min-w-0 flex-col">
          <div data-testid="evidence-viewer-scroll" className="min-h-0 flex-1 overflow-auto bg-muted/20 p-3 md:p-6">
            <article data-testid="evidence-report-surface" data-print-title={report.title} data-report-mode={reportTheme.mode} style={reportTheme.style} aria-busy={busy} className="mx-auto min-w-0 max-w-6xl rounded-lg border bg-card p-5 md:p-8">
              {run && <div className="evidence-print-heading">
                <h1>{report.title}</h1>
                <p>Current report view{updated ? ` · Updated ${updated}` : ''}</p>
                {pending && <p>Unapplied changes are not included.</p>}
                {run.report.parameters.length > 0 && <dl>{run.report.parameters.map(parameter => <div key={parameter.id}><dt>{parameter.label}</dt><dd>{String(run.values[parameter.key] ?? '—')}</dd></div>)}</dl>}
              </div>}
              {report.parameters.length > 0 && <form className="mb-6 flex flex-wrap items-end gap-4 border-b pb-5" onSubmit={event => { event.preventDefault(); void refresh(); }} aria-label="Report inputs">
                {report.parameters.map(parameter => <label key={parameter.id} className="min-w-32 max-w-56 space-y-1 text-xs font-medium">{parameter.label}{parameter.required && <span className="text-muted-foreground"> *</span>}<ParameterInput parameter={parameter} value={Object.hasOwn(report.values, parameter.key) ? report.values[parameter.key] : parameter.defaultValue} label={parameter.label} disabled={busy} onChange={value => change({ ...report, values: { ...report.values, [parameter.key]: value } })} /></label>)}
                <button type="submit" className="sr-only" tabIndex={-1}>Run with parameters</button>
              </form>}
              {run ? <EvidencePreview reportTheme={reportTheme} run={run} onData={setDataContext} onIssues={setSpecIssues} onQuery={entry => setLogs(current => [...current.slice(-99), entry])} onError={message => { setError(message); setSpecIssues(current => [...current, { message, severity: 'error', target: 'document' }]); }} /> : <p className="py-8 text-sm text-muted-foreground" role="status">{busy ? status : 'Refresh to render this report.'}</p>}
              {dataContext && (report.pivots ?? []).map(pivot => <section key={pivot.id} className="mt-8 space-y-3" aria-label={pivot.title}>
                <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-semibold">{pivot.title}</h2>{editing && <Button variant="ghost" size="sm" onClick={() => change({ ...report, pivots: report.pivots?.filter(item => item.id !== pivot.id) })}>Remove pivot</Button>}</div>
                <EvidencePivot mode={reportTheme.mode} context={dataContext} datasetId={pivot.datasetId} config={pivot.config} onConfig={config => { if (editing) change({ ...reportRef.current, pivots: reportRef.current.pivots?.map(item => item.id === pivot.id ? { ...item, config } : item) }); }} />
              </section>)}
            </article>
          </div>
        </section>
        {editing && !editorOnly && <div
          role="separator" aria-label="Resize report editor" aria-orientation="vertical" tabIndex={0}
          aria-valuemin={25} aria-valuemax={70} aria-valuenow={Math.round(editorWidth)} aria-valuetext={`Editor width ${Math.round(editorWidth)} percent`}
          title="Drag to resize editor · Arrow keys to adjust · Double-click to reset"
          className="hidden touch-none select-none cursor-col-resize items-center justify-center bg-border/40 hover:bg-primary/20 focus-visible:outline-2 focus-visible:outline-ring lg:flex"
          onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={event => {
            if (!dragging.current || !split.current) return;
            const bounds = split.current.getBoundingClientRect();
            resizeEditor((bounds.right - event.clientX) / bounds.width * 100);
          }}
          onPointerUp={event => { dragging.current = false; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
          onPointerCancel={() => { dragging.current = false; }}
          onLostPointerCapture={() => { dragging.current = false; }}
          onDoubleClick={() => resizeEditor(36)}
          onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            resizeEditor(event.key === 'Home' ? 25 : event.key === 'End' ? 70 : editorWidth + (event.key === 'ArrowLeft' ? 2 : -2));
          }}
        ><span className="h-10 w-0.5 rounded-full bg-muted-foreground/40" /></div>}
        <div style={{ display: editing ? 'contents' : 'none' }}><EvidenceEditor fullScreen={focused && editorOnly} onToggleFullScreen={() => { const exit = focused && editorOnly; setFocused(!exit); setEditorOnly(!exit); }} catalogs={catalogs} semanticStates={semanticStates} reportTheme={reportTheme} dataContext={dataContext} onRefreshData={() => refresh()} key={report.id} report={report} onChange={change} issues={issues} stale={Boolean(pending)} editorOnly={editorOnly} onTogglePreview={() => setEditorOnly(!editorOnly)} previewBusy={busy} onApplyPreview={async next => { setEditorOnly(false); await refresh(next); }} /></div>
      </div>
    </main>
  </div>;
}
