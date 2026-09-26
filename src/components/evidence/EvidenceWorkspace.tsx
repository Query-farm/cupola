import { sessionCatalogs } from "@/lib/catalog-store";
import { EvidenceQueryRun } from '../../lib/evidence/query-run';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ArrowLeft, Code2, Copy, FileText, FolderOpen, Plus, RefreshCw, Save, Search, Trash2, Eye, Maximize2, Minimize2, Square, FileDown, MoreHorizontal, Loader2, Check, ChevronRight } from 'lucide-react';
import { Button, buttonVariants } from '../ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { Input } from '../ui/input';
import { engine, waitForEngineReady } from '../../lib/shell-bridge';
import { compileReportQuery, materializeReportQuery } from '../../lib/reports/parameters';
import { compilerParameters, deleteEvidenceReport, listEvidenceReports, resolveParameters, saveEvidenceReport, STORAGE_PREFIX, LEGACY_STORAGE_PREFIX, type EvidenceReport, type ParameterValues } from '../../lib/evidence/reports';
import { newDrillExampleReport, newEvidenceReport } from '../../lib/evidence/templates';
import { isWeatherService, WEATHER_TEST_SERVICE } from '../../lib/evidence/weather';
import { quoteIdentifier } from '../../lib/evidence/data-browser';
import type { EvidenceDataContext } from '../../lib/evidence/data-browser';
import type { QueryLogEntry } from '../../lib/evidence/haybarn-query-service';
import { ParameterInput, useParameterChoices } from './EvidenceParameters';
import { describeParameter, resolveChoices } from '../../lib/evidence/parameter-choices';
import { summarizeFilters } from '../../lib/evidence/filter-summary';
import { parameterLint } from '../../lib/evidence/parameter-lint';
import { RefreshProfiler, type RefreshProfile } from '../../lib/evidence/refresh-profile';
import { drillState, drillValues, matchDrillValue } from '../../lib/evidence/drill';
import { completeValuesFromUrl, PARAMETER_URL_PREFIX, valuesFromUrl, withParameterValues } from '../../lib/evidence/parameter-url';
import type { EvidenceIssue } from '../../lib/evidence/editor-support';
import type { CatalogData } from '../../lib/service';
import { prepareEvidenceSemanticDatasets, type SemanticDatasetState } from '../../lib/evidence/semantic-datasets';
import { EvidencePivot } from './EvidencePivot';
import { consumeReportPromotion } from '../../lib/reports/events';
import { useReportTheme } from './useReportTheme';
import { EvidenceEditor } from './EvidenceEditor';
import { EvidencePreview, type EvidenceInputState, type PreviewDrill, type ReportRun } from './EvidencePreview';
import { useReportPrint } from './useReportPrint';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
/** A PDF per parameter value re-renders the report once per section; past this, it stops. */
const MAX_PDF_SECTIONS = 25;
const isLibraryUrl = () => (window.location.pathname.endsWith('/evidence/reports') || window.location.pathname.endsWith('/reports/saved')) || new URLSearchParams(window.location.search).get('evidence_view') === 'library';

export function EvidenceWorkspace({ catalogName, serviceUrl, catalogs, defaultToLibrary = true }: { catalogName: string; serviceUrl: string; catalogs: readonly CatalogData[]; defaultToLibrary?: boolean }) {
  const [initial] = useState(() => {
    let reports: EvidenceReport[] = [], error = '';
    try { reports = listEvidenceReports(serviceUrl); } catch (e) { error = `Could not read saved reports: ${message(e)}`; }
    const id = new URLSearchParams(window.location.search).get('evidence_report');
    const stored = reports.find(report => report.id === id);
    // A shared link's `p.<key>` values are the view it names; they win over the saved ones.
    const found = stored && { ...stored, values: { ...stored.values, ...valuesFromUrl(stored.parameters, new URLSearchParams(window.location.search)) } };
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
  const pendingRef = useRef(0);
  const refreshing = busy || pendingQueries > 0;
  // Stop replaces Refresh in the same spot. A refresh the reader started shows Stop at once, but
  // lazy renderer queries (a chart scrolling into view) run for a moment at any time, and a
  // click meant for Refresh landed on Stop. Those offer Stop only once they've run for a beat.
  const [slowQueries, setSlowQueries] = useState(false);
  useEffect(() => {
    if (pendingQueries === 0) { setSlowQueries(false); return; }
    const timer = setTimeout(() => setSlowQueries(true), 400);
    return () => clearTimeout(timer);
  }, [pendingQueries > 0]);
  const offerStop = busy || slowQueries;
  function stopRefresh() {
    execution.current?.stop();
    setStatus('Refresh stopped');
    setNotice('Report refresh stopped. Refresh again to reload the report.');
  }
  const semanticTables = useRef(new Set<string>());
  const [semanticStates, setSemanticStates] = useState<SemanticDatasetState[]>([]);
  const [dataContext, setDataContext] = useState<EvidenceDataContext | null>(null);
  /** Reads the rendered document's Evidence input values (for the PDF's filter summary). */
  const readInputs = useRef<(() => EvidenceInputState[]) | null>(null);
  const [run, setRun] = useState<ReportRun | null>(null);
  const [updated, setUpdated] = useState('');
  /** When the report's data was last refreshed; the PDF prints it in full (date and time). */
  const updatedAt = useRef<Date | null>(null);
  useReportPrint(workspace, !library && Boolean(run));
  // Export progress lives on the button: working, then "exported" for a moment.
  const [pdfExport, setPdfExport] = useState<{ state: 'idle' } | { state: 'exporting'; progress?: string } | { state: 'done'; omitted: string[] }>({ state: 'idle' });
  const exporting = pdfExport.state === 'exporting';
  const pdfDoneTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(pdfDoneTimer.current), []);
  const previewRoot = () => workspace.current?.querySelector('[data-testid="evidence-preview"]')?.shadowRoot?.querySelector('[data-markdoc-content]') ?? null;
  /** What every PDF of this report shares: title, update time, a link back to a saved view, fonts. */
  function pdfDocument(extraMeta: { label: string; value: string }[] = []) {
    const view = saved && !isLibraryUrl() ? new URL(window.location.href) : null;
    if (view) view.hash = ''; // Never carry a fragment (auth tokens, keys) into a document.
    return {
      title: report.title, meta: extraMeta, fonts: reportTheme.config.fonts,
      updated: updatedAt.current ? new Intl.DateTimeFormat(undefined, { dateStyle: 'long', timeStyle: 'short' }).format(updatedAt.current) : undefined,
      link: view ? { label: 'Open this view in Cupola', url: view.href } : undefined,
      accent: reportTheme.mode === 'light' ? (reportTheme.style as Record<string, string>)['--primary'] : undefined,
    };
  }
  function downloadPdf(pdf: Blob, name: string, omitted: string[]) {
    const url = URL.createObjectURL(pdf);
    Object.assign(document.createElement('a'), { href: url, download: name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    const skipped = [...new Set(omitted)].map(item => item.replaceAll('_', ' '));
    setPdfExport({ state: 'done', omitted: skipped });
    pdfDoneTimer.current = setTimeout(() => setPdfExport({ state: 'idle' }), skipped.length ? 8_000 : 4_000);
  }
  async function exportPdf() {
    const root = previewRoot();
    if (!run || !root) return;
    clearTimeout(pdfDoneTimer.current); setPdfExport({ state: 'exporting' }); setError('');
    try {
      const { exportReportPdf, pdfFileName } = await import('../../lib/evidence/typst/export-pdf');
      const filters = summarizeFilters({ parameters: run.report.parameters, values: run.values, states: choices.states, inputs: readInputs.current?.() ?? [], drill: drillSummary || undefined });
      const { pdf, omitted } = await exportReportPdf({ ...pdfDocument(), root, filters });
      downloadPdf(pdf, pdfFileName(report.title), omitted);
    } catch (cause) {
      setPdfExport({ state: 'idle' });
      setError(`PDF export failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  /** Wait until a freshly refreshed report has rendered and gone quiet: a new document root,
   *  no report queries in flight and no chart still drawing, for several checks in a row. */
  async function settledRoot(previous: Element | null): Promise<Element> {
    const deadline = Date.now() + 90_000;
    let quiet = 0;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const root = previewRoot();
      const ready = root && root !== previous && !busyRef.current && pendingRef.current === 0 && !root.querySelector('[data-echarts-ready="false"]');
      if (!ready) { quiet = 0; continue; }
      if (++quiet >= 5) return root;
    }
    throw new Error('The report did not finish loading.');
  }
  /** One PDF with a section per choice of a parameter. Each section is the report refreshed with
   *  that value; the reader's draft is untouched, and the original view is restored afterwards. */
  async function exportPdfPerValue(key: string) {
    if (!run || busyRef.current) return;
    const original = reportRef.current;
    const parameter = run.report.parameters.find(item => item.key === key);
    if (!parameter) return;
    const all = choices.states[key]?.options ?? (parameter.options?.kind === 'static' ? parameter.options.values : []);
    const options = all.slice(0, MAX_PDF_SECTIONS);
    if (!options.length) { setError(`${parameter.label} has no choices to export.`); return; }
    clearTimeout(pdfDoneTimer.current); setError('');
    let restored = false;
    try {
      const { createPdfExport, pdfFileName } = await import('../../lib/evidence/typst/export-pdf');
      const book = createPdfExport({
        ...pdfDocument([{ label: 'Sections', value: `One per ${parameter.label} (${options.length}${all.length > options.length ? ` of ${all.length}; the first ${MAX_PDF_SECTIONS}` : ''})` }]),
        filters: summarizeFilters({ parameters: run.report.parameters.filter(item => item.key !== key), values: run.values, states: choices.states }),
      });
      let previous = previewRoot();
      for (const [index, option] of options.entries()) {
        setPdfExport({ state: 'exporting', progress: `${index + 1} of ${options.length}` });
        const values = { ...original.values, [key]: parameter.type === 'multi_select' ? [option.value] : option.value };
        if (!await refresh({ ...original, values }, 'none')) throw new Error(`${parameter.label} ${option.label}: the report could not be refreshed.`);
        const root = await settledRoot(previous);
        await book.addSection(root, `${parameter.label}: ${option.label}`);
        previous = root;
      }
      setPdfExport({ state: 'exporting', progress: 'finishing' });
      const { pdf, omitted } = await book.finish();
      await refresh(original, 'none'); restored = true;
      downloadPdf(pdf, pdfFileName(`${original.title} by ${parameter.label}`), omitted);
    } catch (cause) {
      setPdfExport({ state: 'idle' });
      setError(`PDF export failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      if (!restored) void refresh(original, 'none');
    }
  }
  const [logs, setLogs] = useState<QueryLogEntry[]>([]);
  const [profile, setProfile] = useState<RefreshProfile | null>(null);
  const profiler = useRef<RefreshProfiler | null>(null);
  // A refresh has finished rendering once its document has mounted (it reports its data context)
  // and its queries have then been quiet for a moment; it ended when its last query did. Quiet
  // alone isn't enough: the document loads and mounts before its first query starts.
  const [mountedRevision, setMountedRevision] = useState(-1);
  useEffect(() => {
    const current = profiler.current;
    if (!run || mountedRevision !== run.revision || busy || pendingQueries > 0 || !current || current.finished) return;
    const timer = setTimeout(() => {
      if (pendingRef.current > 0 || current.finished) return;
      const ends = current.profile.queries.filter(query => query.phase === 'render').map(query => query.startedAt + query.durationMs);
      current.finish('done', Math.max(current.profile.startedAt, ...current.profile.phases.map(span => span.end), ...ends));
    }, 700);
    return () => clearTimeout(timer);
  }, [run, mountedRevision, busy, pendingQueries]);
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
    if (id !== url.searchParams.get('evidence_report')) for (const key of [...url.searchParams.keys()]) if (key.startsWith(PARAMETER_URL_PREFIX)) url.searchParams.delete(key);
    if (id) url.searchParams.set('evidence_report', id); else url.searchParams.delete('evidence_report');
    window.history[replace ? 'replaceState' : 'pushState']({}, '', url);
    setLibrary(showLibrary);
    if (showLibrary) setFocused(false);
    if (showLibrary) { setRun(null); reloadList(); }
  }
  const choices = useParameterChoices(report.parameters, report.values, !library,
    resets => setReport(current => ({ ...current, values: { ...current.values, ...resets } })));
  /** `history`: a reader's refresh pushes an entry so Back restores the previous parameters;
   *  opening a report replaces the current one; Back/Forward itself writes nothing. */
  // Drill paths stand where the applied values put them; a drill applies at once.
  const drills = run ? (run.report.drillPaths ?? []).map(path => drillState(path, run.report.parameters, run.values, choices.states)) : [];
  function drillTo(values: ParameterValues) {
    if (busyRef.current) return;
    const next = { ...reportRef.current, values };
    change(next);
    void refresh(next, 'push');
  }
  const previewDrill: PreviewDrill | undefined = drills.length ? {
    match: text => drills.some(drill => drill.next && matchDrillValue(drill.next, text, choices.states) !== undefined),
    onDrill: text => {
      for (const drill of drills) {
        const value = drill.next && matchDrillValue(drill.next, text, choices.states);
        if (value === undefined || value === null) continue;
        drillTo(drillValues(drill.path, reportRef.current.parameters, reportRef.current.values, drill.crumbs.length - 1, value));
        return;
      }
    },
    version: JSON.stringify([drills.map(drill => drill.next?.key ?? null), Object.entries(choices.states).map(([key, state]) => [key, state.status, state.options.length])]),
  } : undefined;
  const drillSummary = drills.map(drill => drill.crumbs.map(crumb => crumb.label).join(' › ')).join('; ');
  // `reportRef`, not `report`: an edit made just before ⌘Enter (CodeMirror reports changes outside
  // React events) has not re-rendered yet, and the render's `report` would refresh the old draft.
  async function refresh(next = reportRef.current, history: 'push' | 'replace' | 'none' = 'push'): Promise<boolean> {
    if (busyRef.current) return false;
    execution.current?.stop();
    const current = new EvidenceQueryRun(count => { if (execution.current === current) { pendingRef.current = count; setPendingQueries(count); } });
    execution.current = current;
    setPendingQueries(0);
    busyRef.current = true;
    setBusy(true); setSemanticStates([]); setDataContext(null); setError(''); setNotice(''); setLogs([]); setSpecIssues([]);
    // Every refresh gets a fresh profile: phases and queries on one clock (the Performance tab).
    profiler.current?.finish('stopped');
    const profile = profiler.current = new RefreshProfiler(setProfile);
    try {
      if (next.serviceUrl !== serviceUrl) throw new Error('Open this report using its saved service connection.');
      resolveParameters(next);
      setStatus('Waiting for engine…');
      profile.begin('engine');
      await current.wait(waitForEngineReady());
      profile.end('engine');
      current.signal.throwIfAborted();
      profile.begin('choices');
      // Fit every choice to its current options before binding, so a Refresh pressed
      // mid-cascade never runs with a child value its parent no longer offers.
      const fitted = await current.wait(resolveChoices(next.parameters, next.values, choices.loader, { signal: current.signal,
        observe: load => profile.query({ phase: 'choices', name: load.parameter.label, sql: load.sql, rows: load.rows, startedAt: load.startedAt, durationMs: load.durationMs, error: load.error, cached: load.cached }) }));
      profile.end('choices');
      const unavailable = next.parameters.find(parameter => fitted.states[parameter.key]?.status === 'error');
      if (unavailable) {
        const state = fitted.states[unavailable.key];
        throw new Error(`${unavailable.label}: choices could not be loaded${state.status === 'error' ? `: ${state.error}` : ''}`);
      }
      const values = resolveParameters({ ...next, values: fitted.values });
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
        profile.begin('setup');
        const compiled = compileReportQuery(next.setupSql, compilerParameters(next, values), values);
        const start = performance.now();
        const response = await current.query(compiled.sql, compiled.params);
        const entry = { sql: next.setupSql, rows: 0, durationMs: performance.now() - start, error: response.ok ? null : response.error || 'Dataset setup failed', startedAt: start };
        setLogs([entry]);
        profile.query({ ...entry, phase: 'setup', rows: undefined });
        profile.end('setup');
        if (!response.ok) throw new Error(response.error || 'Dataset setup failed');
      }
      if (next.semanticDatasets?.length) profile.begin('semantic');
      const semanticCatalogs = next.semanticDatasets?.length ? await current.wait(sessionCatalogs(catalogs)) : catalogs;
      const semantic = await prepareEvidenceSemanticDatasets(next, values, semanticCatalogs, name => semanticTables.current.add(name), current,
        step => profile.query({ phase: 'semantic', ...step }));
      profile.end('semantic');
      current.signal.throwIfAborted();
      setSemanticStates(semantic.states);
      // Rendering runs on after this returns: it ends once the document's queries go quiet.
      profile.begin('render');
      setRun({ execution: current, report: structuredClone(next), values, semanticQueries: semantic.queries, semanticStates: semantic.states, revision: ++revision.current });
      updatedAt.current = new Date();
      setUpdated(updatedAt.current.toLocaleTimeString());
      setStatus('Connected');
      if (history !== 'none' && !isLibraryUrl()) {
        const url = withParameterValues(new URL(window.location.href), next.parameters, values);
        if (url.href !== window.location.href) window.history[history === 'push' ? 'pushState' : 'replaceState'](window.history.state, '', url);
      }
      return true;
    } catch (e) {
      if (current.signal.aborted) { setStatus('Refresh stopped'); profile.finish('stopped'); }
      else { setError(message(e)); setStatus('Refresh failed'); profile.finish('failed'); }
      return false;
    }
    finally { busyRef.current = false; setBusy(false); }
  }
  useEffect(() => {
    if (!booted.current) {
      booted.current = true;
      if (initial.library) navigate(true, undefined, true);
      else if (!initial.library && !initial.error) void refresh(initial.report, 'replace');
    }
    const changed = (event: StorageEvent) => { if (event.key === null || event.key.startsWith(STORAGE_PREFIX) || event.key.startsWith(LEGACY_STORAGE_PREFIX)) reloadList(); };
    const unload = (event: BeforeUnloadEvent) => { if (dirtyRef.current) { event.preventDefault(); event.returnValue = ''; } };
    const pop = () => {
      if (isLibraryUrl()) { setRun(null); setLibrary(true); reloadList(); return; }
      const id = new URLSearchParams(window.location.search).get('evidence_report');
      const search = new URLSearchParams(window.location.search);
      if (!id || id === reportRef.current.id) {
        // Back/Forward between parameter views: the URL names every value that isn't a default.
        const restored = { ...reportRef.current, values: completeValuesFromUrl(reportRef.current.parameters, search) };
        setReport(restored); setLibrary(false); void refresh(restored, 'none'); return;
      }
      try {
        const found = listEvidenceReports(serviceUrl).find(item => item.id === id);
        if (found) openReport({ ...found, values: { ...found.values, ...valuesFromUrl(found.parameters, search) } }, false, false, 'none');
        else { setError(''); navigate(true, undefined, true); }
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

  function change(next: EvidenceReport) { reportRef.current = next; setReport(next); setNotice(''); }
  function save(copy = false) {
    try {
      const input = copy ? { ...report, id: crypto.randomUUID(), title: `${report.title} (copy)`, createdAt: Date.now() } : report;
      const next = saveEvidenceReport(input);
      setReport(next); setSaved(JSON.stringify(next)); baseline.current = JSON.stringify(next); reloadList();
      setError(''); setNotice('');
      navigate(false, next.id, true);
    } catch (e) { setError(`Could not save report: ${message(e)}`); }
  }
  function openReport(next: EvidenceReport, updateUrl = true, fresh = false, history: 'replace' | 'none' = 'replace') {
    if (busyRef.current) return;
    if (next.id !== reportRef.current.id && dirtyRef.current && !window.confirm('Discard unsaved changes to the current report?')) return;
    setReport(next); setHasOpenedReport(true); setSaved(fresh ? '' : JSON.stringify(next)); baseline.current = JSON.stringify(next); setEditing(fresh); setEditorOnly(false);
    setError(''); setNotice(''); setRun(null); setUpdated(''); setLibrary(false);
    if (updateUrl) navigate(false, fresh ? undefined : next.id);
    void refresh(next, history);
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

  const lint = useMemo(() => { try { return parameterLint(report); } catch { return []; } }, [report.parameters, report.setupSql, report.source, report.drillPaths]);
  const issues: EvidenceIssue[] = [...lint, ...specIssues, ...logs.filter(log => log.error).map(log => ({
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
        <div className="ml-auto flex gap-2">{hasOpenedReport && <Button variant="outline" disabled={busy} onClick={() => { navigate(false, saved ? report.id : undefined); if (!run) void refresh(report, 'replace'); }}>Back to report</Button>}<Button onClick={() => openReport(newEvidenceReport(serviceUrl, catalogName), true, true)} disabled={busy}><Plus />New report</Button></div></>
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
            {offerStop
              ? <Button key="stop" variant="outline" onClick={stopRefresh}><Square />Stop refresh</Button>
              : <Button key="refresh" variant="field" aria-label={editing ? 'Update preview' : 'Refresh report'} title={`${pending ? 'Changes not applied · ' : ''}⌘ / Ctrl + Enter`} onClick={() => void refresh()}>
                  <RefreshCw />{editing ? 'Update preview' : 'Refresh report'}
                  {pending && <span role="status" aria-label="Changes not applied" className="size-2 rounded-full bg-amber-400" />}
                </Button>}
            {(!editing || pdfExport.state !== 'idle') && <Button variant="outline" disabled={refreshing || !run || exporting} onClick={() => void exportPdf()} aria-live="polite"
              title={pdfExport.state === 'done' && pdfExport.omitted.length ? `Not included: ${pdfExport.omitted.join(', ')}` : 'Download the report as a typeset PDF · The selected tab of each tab group, and every table row'}>
              {pdfExport.state === 'exporting' ? <><Loader2 className="animate-spin" />{pdfExport.progress ? `Preparing PDF ${pdfExport.progress}…` : 'Preparing PDF…'}</>
                : pdfExport.state === 'done' ? <><Check />PDF exported{pdfExport.omitted.length ? ` · ${pdfExport.omitted.length} not included` : ''}</>
                : <><FileDown />Export PDF</>}
            </Button>}
            {dirty && <Button variant="outline" disabled={busy} onClick={() => save()} title="Save in this browser · ⌘ / Ctrl + S"><Save />Save report</Button>}
            {focused
              ? <Button variant="ghost" size="icon" aria-label="Exit focus mode" title="Exit focus mode · Esc" onClick={() => { setEditorOnly(false); setFocused(false); }}><Minimize2 /></Button>
              : <DropdownMenu>
                  <DropdownMenuTrigger aria-label="More report actions" className={buttonVariants({ variant: 'ghost', size: 'icon' })}><MoreHorizontal /></DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-44">
                    {editing && <DropdownMenuItem disabled={refreshing || !run || exporting} onClick={() => void exportPdf()}><FileDown />Export PDF</DropdownMenuItem>}
                    {run?.report.parameters.filter(item => item.type === 'select' || item.type === 'multi_select').map(item => <DropdownMenuItem key={item.key} disabled={refreshing || exporting} onClick={() => void exportPdfPerValue(item.key)}><FileDown />PDF per {item.label.toLowerCase()}</DropdownMenuItem>)}
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
      <div className="flex flex-wrap gap-2">
        {isWeatherService(serviceUrl) && <Button variant="outline" disabled={busy} onClick={() => openReport(newEvidenceReport(serviceUrl, catalogName, true), true, true)}>Use weather example</Button>}
        {serviceUrl === WEATHER_TEST_SERVICE && <Button variant="outline" disabled={busy} onClick={() => openReport(newDrillExampleReport(serviceUrl), true, true)}>Use drilldown example</Button>}
      </div>
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
                {run.report.parameters.length > 0 && <dl>{run.report.parameters.map(parameter => <div key={parameter.id}><dt>{parameter.label}</dt><dd>{describeParameter(parameter, run.values, choices.states)}</dd></div>)}</dl>}
              </div>}
              {report.parameters.length > 0 && <form className="mb-6 flex flex-wrap items-end gap-4 border-b pb-5" onSubmit={event => { event.preventDefault(); void refresh(); }} aria-label="Report inputs">
                {report.parameters.map(parameter => <label key={parameter.id} className={`min-w-32 ${parameter.type === 'date_range' ? 'max-w-80' : 'max-w-56'} space-y-1 text-xs font-medium`}>{parameter.label}{parameter.required && <span className="text-muted-foreground"> *</span>}<ParameterInput parameter={parameter} value={choices.values[parameter.key] ?? null} choices={choices.states[parameter.key]} label={parameter.label} disabled={busy} onChange={value => { choices.clearNotes(); change({ ...report, values: { ...report.values, [parameter.key]: value } }); }} /></label>)}
                <button type="submit" className="sr-only" tabIndex={-1}>Run with parameters</button>
                {choices.notes.length > 0 && <p role="status" aria-label="Parameter changes" className="basis-full text-xs text-amber-700 dark:text-amber-400">{choices.notes.join(' ')}</p>}
              </form>}
              {drills.map(drill => <nav key={drill.path.id} aria-label={drill.path.label ? `Drill path: ${drill.path.label}` : 'Drill path'} className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <ol className="flex flex-wrap items-center gap-1">
                  {drill.crumbs.map((crumb, index) => <li key={crumb.depth} className="flex items-center gap-1">
                    {index > 0 && <ChevronRight aria-hidden className="size-3.5 text-muted-foreground" />}
                    {index === drill.crumbs.length - 1
                      ? <span aria-current="location" className="font-medium">{crumb.label}</span>
                      : <button type="button" disabled={busy} className="text-primary underline-offset-2 hover:underline disabled:opacity-60" onClick={() => drillTo(drillValues(drill.path, report.parameters, report.values, crumb.depth))}>{crumb.label}</button>}
                  </li>)}
                </ol>
                {drill.next && <span className="text-xs text-muted-foreground print:hidden">Click a chart bar or underlined value to drill into {drill.next.label.toLowerCase()}.</span>}
              </nav>)}
              {run ? <EvidencePreview reportTheme={reportTheme} run={run} drill={previewDrill} onInputs={read => { readInputs.current = read; }} onData={context => { setDataContext(context); setMountedRevision(run.revision); }} onIssues={setSpecIssues} onQuery={entry => { setLogs(current => [...current.slice(-99), entry]); profiler.current?.query({ ...entry, phase: 'render' }); }} onError={message => { setError(message); setSpecIssues(current => [...current, { message, severity: 'error', target: 'document' }]); }} /> : <p className="py-8 text-sm text-muted-foreground" role="status">{busy ? status : 'Refresh to render this report.'}</p>}
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
        <div style={{ display: editing ? 'contents' : 'none' }}><EvidenceEditor performance={{ profile, namedQueries: dataContext?.queries ?? [], runnable: sql => {
          if (!run) return sql;
          try { return materializeReportQuery(sql, compilerParameters(run.report, run.values), run.values); } catch { return sql; }
        } }} parameterChoices={{ states: choices.states, values: choices.values, loader: choices.loader }} fullScreen={focused && editorOnly} onToggleFullScreen={() => { const exit = focused && editorOnly; setFocused(!exit); setEditorOnly(!exit); }} catalogs={catalogs} semanticStates={semanticStates} reportTheme={reportTheme} dataContext={dataContext} onRefreshData={async () => { await refresh(); }} key={report.id} report={report} onChange={change} issues={issues} stale={Boolean(pending)} editorOnly={editorOnly} onTogglePreview={() => setEditorOnly(!editorOnly)} previewBusy={busy} onApplyPreview={async next => { setEditorOnly(false); await refresh(next); }} /></div>
      </div>
    </main>
  </div>;
}
