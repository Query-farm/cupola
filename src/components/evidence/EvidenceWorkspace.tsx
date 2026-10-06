import { appBase } from "../../lib/app-base";
import { sessionCatalogs } from "@/lib/catalog-store";
import { EvidenceQueryRun } from '../../lib/evidence/query-run';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { ArrowLeft, Code2, Copy, FileText, FolderOpen, Plus, RefreshCw, Save, Search, Trash2, Eye, Maximize2, Minimize2, Square, FileDown, MoreHorizontal, Loader2, Check, ChevronRight, Download, Upload } from 'lucide-react';
import { Button, buttonVariants } from '../ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { Input } from '../ui/input';
import { engine, waitForEngineReady } from '../../lib/shell-bridge';
import { hasSqlStatements, materializeReportQuery } from '../../lib/reports/parameters';
import { compilerParameters, deleteEvidenceReport, listEvidenceReports, resolveParameters, saveEvidenceReport, validateEvidenceReport, describeReportError, saveRecoveryDraft, clearRecoveryDraft, loadRecoveryDraft, listUnsavedDrafts, titled, isQuotaError, UNTITLED_REPORT, STORAGE_FULL_MESSAGE, STORAGE_PREFIX, LEGACY_STORAGE_PREFIX, EVIDENCE_REPORTS_CHANGED, type EvidenceReport, type ParameterValues } from '../../lib/evidence/reports';
import { newDrillExampleReport, newEvidenceReport } from '../../lib/evidence/templates';
import { reportScope } from '../../lib/evidence/reports';
import { getWorkspace, hostOf, listWorkspaces, subscribeWorkspaces, workspaceLabel, type Workspace } from '../../lib/workspace/store';
import { resolveRequires, rewriteReportAliases, withDerivedRequires, type RequireCatalog } from '../../lib/evidence/report-requires';
import { rebindLabel, REPORT_REWRITE_EVENT, rewriteReportForRename, type ReportRewrite } from '../../lib/workspace/alias-rename';
import { openAttachCatalog } from '../../lib/workspace/events';
import { OPEN_REPORT_EVENT, type OpenReportDetail } from '../../lib/evidence/open-report';
import { parseReportFile, planImport, reportFileName, serializeReportFile, REPORT_FILE_EXTENSION } from '../../lib/evidence/report-file';
import { emptyHistory, loadReportHistory, mergeHistories, recordRevision, removeRevision, revisionReport, saveReportHistory, shrinkStoredHistory, specOf, type ReportHistory, type Revision, type RevisionMeta } from '../../lib/evidence/revisions';
import type { ProposalEvent } from './EvidenceAgent';
import { isWeatherService, WEATHER_TEST_SERVICE } from '../../lib/evidence/weather';
import { quoteIdentifier } from '../../lib/evidence/data-browser';
import type { EvidenceDataContext } from '../../lib/evidence/data-browser';
import type { QueryLogEntry } from '../../lib/evidence/haybarn-query-service';
import { ParameterInput, useParameterChoices } from './EvidenceParameters';
import { describeParameter, resolveChoices } from '../../lib/evidence/parameter-choices';
import { summarizeFilters } from '../../lib/evidence/filter-summary';
import { parameterLint } from '../../lib/evidence/parameter-lint';
import { runSetupSql } from '../../lib/evidence/setup-test';
import { RefreshProfiler, type RefreshPhase, type RefreshProfile } from '../../lib/evidence/refresh-profile';
import { EvidenceRefreshProgress } from './EvidenceRefreshProgress';
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
import { captureReportPreview, RetainedReportPreview } from './RetainedReportPreview';
import { ReportSharing } from './ReportSharing';
import { copyReport, exportSavedReport } from '../../lib/evidence/report-actions';
import { useSavedDocumentActions } from '../../lib/saved-document-actions';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
/** A PDF per parameter value re-renders the report once per section; past this, it stops. */
const MAX_PDF_SECTIONS = 25;
const RECOVERED_NOTICE = 'Recovered changes that could not be saved when this report was last open.';
/** How long after the last edit a report saves itself. */
const AUTOSAVE_DELAY_MS = 1_500;
/** A report as it compares with its saved JSON: a blank title saves as "Untitled report". */
const asSaved = (report: EvidenceReport) => JSON.stringify(titled(report));
const diagnosticSpec = (report: EvidenceReport) => JSON.stringify([report.source, report.setupSql, report.parameters, report.semanticDatasets]);
const isLibraryUrl = () => (window.location.pathname.endsWith('/evidence/reports') || window.location.pathname.endsWith('/reports/saved')) || new URLSearchParams(window.location.search).get('evidence_view') === 'library';

export function EvidenceWorkspace({ catalogName, serviceUrl, workspaceId, catalogs, defaultToLibrary = true }: { catalogName: string; serviceUrl: string; workspaceId?: string; catalogs: readonly CatalogData[]; defaultToLibrary?: boolean }) {
  // Reports are kept per workspace (multi-catalog phase 2); without one (a test harness), per service.
  const scope = workspaceId ?? serviceUrl;
  const stamp = (next: EvidenceReport): EvidenceReport => workspaceId ? { ...next, workspaceId } : next;
  // The workspace's catalogs, for the report's `requires`: derived on save, resolved on open.
  const storedWorkspace = useSyncExternalStore(subscribeWorkspaces, () => workspaceId ? getWorkspace(workspaceId) : null, () => null);
  const requireCatalogs = (ws: Workspace | null | undefined = workspaceId ? getWorkspace(workspaceId) : null): RequireCatalog[] =>
    (ws?.catalogs ?? []).filter(c => c.alias).map(c => ({ alias: c.alias, url: c.url, catalogName: c.catalogName }));
  const [initial] = useState(() => {
    let reports: EvidenceReport[] = [], error = '';
    try { reports = listEvidenceReports(scope); } catch (e) { error = `Could not read saved reports: ${message(e)}`; }
    const search = new URLSearchParams(window.location.search);
    const create = search.get('evidence_new') === '1';
    const id = create ? null : search.get('evidence_report');
    const stored = reports.find(report => report.id === id);
    // A shared link's `p.<key>` values are the view it names; they win over the saved ones.
    const found = stored && { ...stored, values: { ...stored.values, ...valuesFromUrl(stored.parameters, new URLSearchParams(window.location.search)) } };
    const report = found ?? stamp(newEvidenceReport(serviceUrl, catalogName, !create && isWeatherService(serviceUrl)));
    // Edits that could not be saved when this report was last open come back, and so does a new
    // report that was never saved (its URL names it from the start).
    const recovered = id ? loadRecoveryDraft(scope, id) : null;
    const draft = recovered && (!found || specOf(recovered) !== specOf(found)) ? recovered : null;
    return { reports, report: draft ?? report, savedReport: report, recovered: Boolean(draft), create, error, saved: found ? JSON.stringify(found) : '', library: !create && (isLibraryUrl() || (!found && !draft && (defaultToLibrary || Boolean(id)))) };
  });
  const [promotion, setPromotion] = useState(consumeReportPromotion);
  const [report, setReport] = useState(initial.report);
  const reportTheme = useReportTheme(report.appearance);
  const [saved, setSaved] = useState(initial.saved);
  const [reports, setReports] = useState(initial.reports);
  const [library, setLibrary] = useState(initial.library);
  const [hasOpenedReport, setHasOpenedReport] = useState(!initial.library);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(initial.recovered || initial.create);
  const [focused, setFocused] = useState(false);
  const [editorOnly, setEditorOnly] = useState(false);
  const [compactView, setCompactView] = useState<'editor' | 'preview'>('editor');
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
  const checkedSpec = useRef(diagnosticSpec(initial.report));
  const workspace = useRef<HTMLDivElement>(null);
  const [error, setError] = useState(initial.error);
  const [notice, setNotice] = useState('');
  /** The draft on screen was recovered, not saved; said until it saves. */
  const [recovered, setRecovered] = useState(initial.recovered);
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
  const [retained, setRetained] = useState<{ content: DocumentFragment; run: ReportRun } | null>(null);
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
  /** After the PDF export opens a collapsed section: no report query in flight and no chart
   *  still drawing, for several checks in a row (a section's queries start as it mounts). */
  async function settleReport(root: Element) {
    const deadline = Date.now() + 60_000;
    let quiet = 0;
    while (Date.now() < deadline && quiet < 5) {
      await new Promise(resolve => setTimeout(resolve, 100));
      quiet = pendingRef.current === 0 && !root.querySelector('[data-echarts-ready="false"]') ? quiet + 1 : 0;
    }
  }
  /** What every PDF of this report shares: title, update time, fonts. */
  function pdfDocument(extraMeta: { label: string; value: string }[] = []) {
    return {
      title: report.title, meta: extraMeta, fonts: reportTheme.config.fonts, settle: settleReport,
      updated: updatedAt.current ? new Intl.DateTimeFormat(undefined, { dateStyle: 'long', timeStyle: 'short' }).format(updatedAt.current) : undefined,
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
  /** The phases the running refresh will pass through, for its progress list. */
  const [refreshPhases, setRefreshPhases] = useState<RefreshPhase[]>([]);
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
  const dirty = asSaved(report) !== saved;
  const reportRef = useRef(report); reportRef.current = report;
  const deletedReportId = useRef<string | null>(null);
  const baseline = useRef(JSON.stringify(initial.savedReport));
  const dirtyRef = useRef(false); dirtyRef.current = asSaved(report) !== baseline.current;

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

  /** New reports that never saved, kept only as recovery drafts. */
  const [unsavedDrafts, setUnsavedDrafts] = useState(() => listUnsavedDrafts(scope, new Set(initial.reports.map(item => item.id))));
  function reloadList() {
    try {
      const list = listEvidenceReports(scope);
      setReports(list);
      setUnsavedDrafts(listUnsavedDrafts(scope, new Set(list.map(item => item.id))));
    }
    catch (e) { setError(`Could not read saved reports: ${message(e)}`); }
  }
  useEffect(() => {
    const reload = () => reloadList();
    window.addEventListener(EVIDENCE_REPORTS_CHANGED, reload);
    return () => window.removeEventListener(EVIDENCE_REPORTS_CHANGED, reload);
  }, [scope]);
  function navigate(showLibrary: boolean, id?: string, replace = false) {
    const url = new URL(window.location.href);
    url.pathname = `${appBase.replace(/\/$/, '')}/reports${showLibrary ? '/saved' : ''}`;
    url.searchParams.delete('evidence_view');
    url.searchParams.delete('evidence_new');
    // A workspace tab names its catalogs with `?local_ws=`, which wins over `?service=`.
    if (!url.searchParams.has('local_ws')) url.searchParams.set('service', serviceUrl);
    if (id !== url.searchParams.get('evidence_report')) for (const key of [...url.searchParams.keys()]) if (key.startsWith(PARAMETER_URL_PREFIX)) url.searchParams.delete(key);
    if (id) url.searchParams.set('evidence_report', id); else url.searchParams.delete('evidence_report');
    window.history[replace ? 'replaceState' : 'pushState']({}, '', url);
    setLibrary(showLibrary);
    if (showLibrary) setFocused(false);
    if (showLibrary) { setRun(null); setRetained(null); reloadList(); }
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
    checkedSpec.current = diagnosticSpec(next);
    const previousRoot = workspace.current?.querySelector('[data-testid="evidence-preview"]')?.shadowRoot;
    if (run?.report.id === next.id && previousRoot && pendingRef.current === 0 && !specIssues.some(issue => issue.severity === 'error') && !logs.some(log => log.error)) {
      setRetained({ content: captureReportPreview(previousRoot), run });
    }
    execution.current?.stop();
    const current = new EvidenceQueryRun(count => { if (execution.current === current) { pendingRef.current = count; setPendingQueries(count); } });
    execution.current = current;
    setPendingQueries(0);
    busyRef.current = true;
    setBusy(true); setSemanticStates([]); setDataContext(null); setError(''); setNotice(''); setLogs([]); setSpecIssues([]);
    // Every refresh gets a fresh profile: phases and queries on one clock (the Performance tab).
    profiler.current?.finish('stopped');
    const profile = profiler.current = new RefreshProfiler(setProfile);
    setRefreshPhases(['engine', ...(next.parameters.length ? ['choices' as const] : []), ...(hasSqlStatements(next.setupSql) ? ['setup' as const] : []),
      ...(next.semanticDatasets?.length ? ['semantic' as const] : []), 'render']);
    try {
      if (reportScope(next) !== scope) throw new Error('Open this report in the workspace it was saved in.');
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
      // Keep a static copy before unmounting queries that reference temporary datasets.
      setRun(null);
      setStatus('Refreshing report…');
      for (const name of semanticTables.current) {
        const dropped = await current.query(`DROP TABLE IF EXISTS temp.main.${quoteIdentifier(name)}`);
        if (!dropped.ok) throw new Error(dropped.error || 'Could not replace semantic dataset');
        semanticTables.current.delete(name);
      }
      // Comment-only setup SQL (a script someone commented out) has nothing to run; DuckDB
      // would reject it with "no statements".
      if (hasSqlStatements(next.setupSql)) {
        profile.begin('setup');
        // Statement by statement, so the Performance tab times each one.
        const start = performance.now();
        const setup = await runSetupSql(next.setupSql, next, values, (sql, params) => current.query(sql, params),
          step => profile.query({ phase: 'setup', name: step.name, sql: step.sql, startedAt: step.startedAt, durationMs: step.durationMs, error: step.error }),
          step => profile.start({ phase: 'setup', ...step }));
        // Logged against the whole setup SQL, so an error points the editor at the Dataset SQL.
        setLogs([{ sql: next.setupSql, rows: 0, durationMs: performance.now() - start, error: setup.ok ? null : setup.error, startedAt: start }]);
        profile.end('setup');
        if (!setup.ok) throw new Error(setup.error);
      }
      if (next.semanticDatasets?.length) profile.begin('semantic');
      const semanticCatalogs = next.semanticDatasets?.length ? await current.wait(sessionCatalogs(catalogs)) : catalogs;
      const semantic = await prepareEvidenceSemanticDatasets(next, values, semanticCatalogs, name => semanticTables.current.add(name), current,
        step => profile.query({ phase: 'semantic', ...step }), step => profile.start({ phase: 'semantic', ...step }));
      profile.end('semantic');
      current.signal.throwIfAborted();
      setSemanticStates(semantic.states);
      // Rendering runs on after this returns: it ends once the document's queries go quiet.
      profile.begin('render');
      setRetained(null);
      setRun({ execution: current, report: structuredClone(next), values, appliedFilters: next.parameters.map(parameter => `${parameter.label}: ${describeParameter(parameter, values, fitted.states)}`).join(' · '), semanticQueries: semantic.queries, semanticStates: semantic.states, revision: ++revision.current });
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
      if (initial.create) navigate(false, initial.report.id, true);
      if (initial.library) navigate(true, undefined, true);
      else if (!initial.library && !initial.error) void refresh(initial.report, 'replace');
    }
    const changed = (event: StorageEvent) => { if (event.key === null || event.key.startsWith(STORAGE_PREFIX) || event.key.startsWith(LEGACY_STORAGE_PREFIX)) reloadList(); };
    // Save on the way out; ask only when the draft can't be saved (it is kept for recovery either way).
    const unload = (event: BeforeUnloadEvent) => { if (!exportingRef.current) autosaveRef.current(); if (unsavedRef.current()) { event.preventDefault(); event.returnValue = ''; } };
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
        const found = listEvidenceReports(scope).find(item => item.id === id);
        const draft = found ? null : loadRecoveryDraft(scope, id);
        if (found) openReport({ ...found, values: { ...found.values, ...valuesFromUrl(found.parameters, search) } }, false, false, 'none');
        else if (draft) resumeDraft(draft, false);
        else { setError(''); navigate(true, undefined, true); }
      } catch (e) { setError(message(e)); }
    };
    window.addEventListener('storage', changed);
    window.addEventListener('beforeunload', unload);
    window.addEventListener('popstate', pop);
    return () => { execution.current?.stop(); window.removeEventListener('storage', changed); window.removeEventListener('beforeunload', unload); window.removeEventListener('popstate', pop); };
  }, []);

  // A report opened from the sidebar: no page load. Clicking the open report only leaves the list.
  const openFromSidebar = useRef<(detail: OpenReportDetail) => Promise<void>>(async () => {});
  openFromSidebar.current = async detail => {
    if ((detail.workspaceId ?? detail.serviceUrl) !== scope) return;
    if (!detail.id && !detail.create) { if (!library || !isLibraryUrl()) navigate(true); return; }
    if (detail.id === reportRef.current.id && savedRef.current) {
      if (library) { navigate(false, detail.id); if (!run) void refresh(reportRef.current, 'replace'); }
      return;
    }
    // A refresh in progress would refuse the switch: stop it, and wait for it to wind down.
    if (busyRef.current) {
      execution.current?.stop();
      for (let waited = 0; busyRef.current && waited < 5_000; waited += 50) await new Promise(resolve => setTimeout(resolve, 50));
    }
    try {
      if (detail.create) { openReport(stamp(newEvidenceReport(serviceUrl, catalogName)), true, true); return; }
      const found = listEvidenceReports(scope).find(item => item.id === detail.id);
      if (found) openReport(found);
      else setError('That report is no longer saved in this browser.');
    } catch (e) { setError(`Could not open that report: ${message(e)}`); }
  };
  useEffect(() => {
    const open = (event: Event) => void openFromSidebar.current((event as CustomEvent<OpenReportDetail>).detail);
    window.addEventListener(OPEN_REPORT_EVENT, open);
    return () => window.removeEventListener(OPEN_REPORT_EVENT, open);
  }, []);
  useEffect(() => {
    const promoted = () => setPromotion(consumeReportPromotion());
    window.addEventListener('cupola:promote-report', promoted);
    return () => window.removeEventListener('cupola:promote-report', promoted);
  }, []);
  useEffect(() => {
    if (!promotion || busy) return;
    setPromotion(null);
    const next = stamp(newEvidenceReport(serviceUrl, catalogName));
    next.title = promotion.title || 'New report';
    if (promotion.kind === 'semantic') {
      next.semanticDatasets = [{ id: crypto.randomUUID(), kind: 'semantic', name: 'model_data', query: promotion.query }];
      next.source = `# ${next.title}\n\n${promotion.markdown || ''}\n\n{% table data="model_data" /%}`;
    } else next.source = `# ${next.title}\n\n${promotion.markdown || ''}\n\n\`\`\`sql query_data\n${promotion.sql}\n\`\`\`\n\n{% table data="query_data" /%}`;
    // It carries the reader's query, so it saves at once; a blank new report waits for an edit.
    openReport(next, true, true, 'replace', true);
  }, [promotion, busy]);

  function change(next: EvidenceReport) {
    if (deletedReportId.current === next.id) return;
    reportRef.current = next; setReport(next); setNotice('');
  }

  // Revision history: every save keeps the saved version, labelled with who changed what.
  const [history, setHistory] = useState<ReportHistory>(emptyHistory);
  useEffect(() => {
    try { setHistory(loadReportHistory(scope, report.id)); }
    catch (e) { setHistory(emptyHistory()); setNotice(`Could not read this report's revision history: ${message(e)}`); }
  }, [scope, report.id, saved]);
  /** Add `next` to its history (a copy starts from its original's), and say so if that fails. */
  function keepRevision(next: EvidenceReport, from: { history: ReportHistory; before: EvidenceReport | null }, meta: RevisionMeta): string {
    try {
      let kept = from.history;
      // A report saved before history was kept: its last saved version opens the history.
      if (!kept.revisions.length && from.before && specOf(from.before) !== specOf(next)) kept = recordRevision(kept, from.before, { kind: 'baseline', savedAt: from.before.updatedAt });
      kept = recordRevision(kept, next, meta);
      const dropped = saveReportHistory(scope, next.id, kept);
      if (next.id === reportRef.current.id) setHistory(dropped ? loadReportHistory(scope, next.id) : kept);
      return dropped ? `Saved. Browser storage is full, so this report's ${dropped} oldest ${dropped === 1 ? 'revision was' : 'revisions were'} dropped to make room. Export report files to keep full histories.` : '';
    } catch (e) { return `Saved, but its revision history could not be stored: ${message(e)}`; }
  }

  // Autosave. A tab the browser closes to reclaim memory takes an unsaved draft with it, so the
  // draft is saved shortly after each edit and at once when the tab is hidden or closing. The
  // history stays readable: one editing session's edits grow one revision (`SESSION_WINDOW_MS`),
  // while each applied agent proposal, undo, restore and ⌘S is a revision of its own.
  const savedRef = useRef(initial.saved); savedRef.current = saved;
  /** The editing session autosaves extend; a checkpoint (⌘S, the agent, a restore) starts a new one. */
  const session = useRef(crypto.randomUUID());
  const [saveError, setSaveError] = useState('');
  /** Save the report, recording a revision. Null when it can't be saved; the draft is kept for recovery. */
  function persist(next: EvidenceReport, meta: RevisionMeta): EvidenceReport | null {
    if (deletedReportId.current === next.id) return null;
    const before = savedRef.current ? JSON.parse(savedRef.current) as EvidenceReport : null;
    let stored: EvidenceReport;
    // A blank title (being retyped) saves as "Untitled report"; the field stays as typed.
    // `requires` follows the SQL: the workspace catalogs it names, and earlier ones it still names.
    try { stored = saveReport(withDerivedRequires(titled(next), requireCatalogs())); }
    catch (e) {
      const kept = saveRecoveryDraft(next);
      setSaveError(describeReportError(e) + (kept ? '' : isQuotaError(e) ? '. Your changes are only in this tab: export a report file before closing it' : ''));
      if (library) reloadList();
      else if (!savedRef.current) navigate(false, next.id, true);
      return null;
    }
    clearRecoveryDraft(scope, stored.id);
    // A parameter pick is the reader's view, not a change to the report: saved, but not a revision.
    const valuesOnly = before && meta.kind === 'edit' && !meta.label && specOf({ ...before, values: stored.values }) === specOf(stored);
    let history = emptyHistory();
    try { history = loadReportHistory(scope, stored.id); } catch { /* Starts again from this save. */ }
    const problem = valuesOnly ? '' : keepRevision(stored, { history, before }, meta);
    const first = !savedRef.current;
    savedRef.current = JSON.stringify(stored);
    baseline.current = savedRef.current;
    // Only when nothing was typed since `next` was read (a save is synchronous, so that is always).
    if (reportRef.current === next) { const shown = next.title === stored.title ? stored : { ...stored, title: next.title }; reportRef.current = shown; setReport(shown); }
    setSaved(savedRef.current); setSaveError(''); setRecovered(false); reloadList();
    if (problem) setNotice(problem);
    if (first) navigate(false, stored.id, true);
    return stored;
  }
  /** Save, and when storage is full, make room from this report's own history and try once more. */
  function saveReport(next: EvidenceReport): EvidenceReport {
    try { return saveEvidenceReport(next); }
    catch (e) {
      if (!isQuotaError(e) || !shrinkStoredHistory(scope, next.id)) throw e;
      const stored = saveEvidenceReport(next);
      setNotice(`Saved. Browser storage is full, so this report's oldest revisions were dropped to make room. Export report files to keep full histories.`);
      return stored;
    }
  }
  /** Whether the draft differs from what is saved (a new report: from the template it started as). */
  const unsaved = () => deletedReportId.current !== reportRef.current.id && asSaved(reportRef.current) !== (savedRef.current || baseline.current);
  function autosave() {
    if (unsaved()) persist(reportRef.current, { kind: 'edit', session: session.current });
  }
  /** For listeners registered once (beforeunload). */
  const autosaveRef = useRef(autosave); autosaveRef.current = autosave;
  const unsavedRef = useRef(unsaved); unsavedRef.current = unsaved;
  const exportingRef = useRef(false); exportingRef.current = exporting;
  useEffect(() => {
    // A PDF per value refreshes with each value in turn: its intermediate views aren't the reader's.
    if (exporting || !unsaved()) return;
    const timer = setTimeout(autosave, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [report, exporting]);
  useEffect(() => {
    const flush = () => { if (document.visibilityState === 'hidden' && !exportingRef.current) autosave(); };
    const leaving = () => { if (!exportingRef.current) autosave(); };
    document.addEventListener('visibilitychange', flush);
    window.addEventListener('pagehide', leaving);
    return () => { document.removeEventListener('visibilitychange', flush); window.removeEventListener('pagehide', leaving); };
  });
  /** ⌘S: save now, closing the session's revision so the next edits start another. */
  function checkpoint() {
    if (unsaved()) persist(reportRef.current, { kind: 'edit', session: session.current });
    session.current = crypto.randomUUID();
  }
  /** An agent proposal is its own revision, labelled with its summary. Edits the reader made first
   *  are saved before it, so the label never claims them. */
  function proposalEvent(event: ProposalEvent) {
    if (event.type === 'applied') {
      const saved = savedRef.current ? JSON.parse(savedRef.current) as EvidenceReport : null;
      const started = saved ?? (baseline.current ? JSON.parse(baseline.current) as EvidenceReport : null);
      if (!started || specOf(event.proposal.before) !== specOf(started)) persist({ ...event.proposal.before, updatedAt: saved?.updatedAt ?? event.proposal.before.updatedAt }, { kind: 'edit', session: session.current });
      persist(reportRef.current, { kind: 'agent', agentSummaries: [event.proposal.summary] });
    } else {
      persist(reportRef.current, { kind: 'edit', label: `Undid “${event.proposal.summary}”` });
    }
    session.current = crypto.randomUUID();
  }
  /** A catalog alias rename (`AliasRenameDialog`) rewrites the open report here, through the same
   *  save as an edit, so its revision and the draft on screen agree. Edits the reader made first are
   *  saved before it, so the rename's label never claims them. */
  const aliasRewrite = useRef<(detail: ReportRewrite) => void>(() => {});
  aliasRewrite.current = detail => {
    if (detail.scope !== scope || library && !savedRef.current) return;
    const current = reportRef.current;
    const next = rewriteReportForRename(current, detail.from, detail.to);
    detail.handled.push(current.id);
    if (!next) return;
    if (!savedRef.current) { change(next); return; }
    if (unsaved()) persist(current, { kind: 'edit', session: session.current });
    change(next);
    if (!persist(next, { kind: 'edit', label: detail.label })) detail.errors.push(`“${titled(next).title}” could not be saved; its changes are kept in this browser until it can be.`);
    session.current = crypto.randomUUID();
  };
  useEffect(() => {
    const rewrite = (event: Event) => aliasRewrite.current((event as CustomEvent<ReportRewrite>).detail);
    window.addEventListener(REPORT_REWRITE_EVENT, rewrite);
    return () => window.removeEventListener(REPORT_REWRITE_EVENT, rewrite);
  }, []);

  // `requires`: a report written for catalogs this workspace has under other aliases offers to
  // rebind them; one that reads catalogs it doesn't have offers to attach them, or to open anyway.
  const requires = useMemo(() => resolveRequires(report.requires, requireCatalogs(storedWorkspace)), [report.requires, storedWorkspace]);
  const [requiresDismissed, setRequiresDismissed] = useState<ReadonlySet<string>>(new Set());
  const showRequires = Boolean(workspaceId) && !library && !requires.ok && !requiresDismissed.has(report.id);
  function rebind() {
    const pairs = requires.rebind.map(({ from, to }) => ({ from, to }));
    if (!pairs.length) return;
    if (savedRef.current && unsaved()) persist(reportRef.current, { kind: 'edit', session: session.current });
    const { report: next } = rewriteReportAliases(reportRef.current, Object.fromEntries(pairs.map(pair => [pair.from, pair.to])));
    change(next);
    if (savedRef.current && persist(next, { kind: 'edit', label: rebindLabel(pairs) })) setNotice(`${rebindLabel(pairs)}.`);
    session.current = crypto.randomUUID();
    void refresh(reportRef.current);
  }

  function saveCopy() {
    try {
      const before = savedRef.current ? JSON.parse(savedRef.current) as EvidenceReport : null;
      const next = saveEvidenceReport({ ...reportRef.current, id: crypto.randomUUID(), title: `${titled(reportRef.current).title} (copy)`, createdAt: Date.now() });
      let original = emptyHistory();
      try { original = loadReportHistory(scope, reportRef.current.id); } catch { /* The copy starts its own history. */ }
      const problem = keepRevision(next, { history: original, before }, { kind: 'edit', label: `Saved as a copy of “${reportRef.current.title}”` });
      reportRef.current = next; setReport(next); setSaved(JSON.stringify(next)); savedRef.current = JSON.stringify(next); baseline.current = savedRef.current; reloadList();
      session.current = crypto.randomUUID();
      setError(''); setNotice(problem);
      navigate(false, next.id, true);
    } catch (e) { setError(`Could not save a copy: ${describeReportError(e)}`); }
  }
  /** Put an earlier version back. It saves at once, as a revision saying so: nothing is lost,
   *  since the version it replaced is in the history too. */
  function restoreRevision(revision: Revision) {
    try {
      const next = revisionReport(history, revision, reportRef.current);
      change(next);
      const label = `Restored the version of ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(revision.savedAt)} (${revision.label})`;
      if (persist(next, { kind: 'restore', label })) setNotice('Earlier version restored.');
      session.current = crypto.randomUUID();
      void refresh(reportRef.current);
    } catch (e) { setError(`Could not restore that version: ${message(e)}`); }
  }
  /** Remove an earlier version from the history. The saved report itself is untouched. */
  function deleteRevision(revision: Revision) {
    try {
      const id = reportRef.current.id;
      const next = removeRevision(loadReportHistory(scope, id), revision.id);
      saveReportHistory(scope, id, next);
      setHistory(next);
    } catch (e) { setError(`Could not remove that version: ${message(e)}`); }
  }
  /** `saveNow`: a new report whose content the reader brought (Add to report) saves at once. A blank
   *  one from a template doesn't, so one opened and abandoned never lands in the list. */
  function openReport(next: EvidenceReport, updateUrl = true, fresh = false, history: 'replace' | 'none' = 'replace', saveNow = false) {
    if (busyRef.current) return;
    if (next.id !== reportRef.current.id) {
      autosave();
      if (unsaved() && !window.confirm(`The current report could not be saved (${saveError || 'it has problems'}). Discard its unsaved changes?`)) return;
    }
    // Edits that could not be saved when this report was last open come back.
    const recovered = fresh ? null : loadRecoveryDraft(scope, next.id);
    const draft = recovered && specOf(recovered) !== specOf(next) ? recovered : null;
    // Import can restore a deliberately deleted report with its original identity.
    if (next.id === deletedReportId.current) deletedReportId.current = null;
    reportRef.current = draft ?? next;
    setReport(draft ?? next); setHasOpenedReport(true); setSaved(fresh ? '' : JSON.stringify(next)); savedRef.current = fresh ? '' : JSON.stringify(next); baseline.current = JSON.stringify(next); setEditing(fresh || Boolean(draft)); setEditorOnly(false);
    setError(''); setNotice(''); setRecovered(Boolean(draft)); setSaveError(''); setRun(null); setRetained(null); setUpdated(''); setLibrary(false); setCompactView('editor');
    session.current = crypto.randomUUID();
    // A new report is named in the URL too, so a reload finds its draft if it never saved.
    if (updateUrl) navigate(false, next.id);
    if (saveNow && fresh) persist(next, { kind: 'edit', session: session.current });
    void refresh(draft ?? next, history);
  }
  /** Reopen a new report that never saved, from its recovery draft; it saves as soon as it can. */
  function resumeDraft(draft: EvidenceReport, updateUrl = true) {
    // The report on screen is newer than its draft.
    if (draft.id === reportRef.current.id) { navigate(false, draft.id); if (!run) void refresh(reportRef.current, 'replace'); return; }
    openReport(draft, updateUrl, true, updateUrl ? 'replace' : 'none');
    if (reportRef.current !== draft) return;
    baseline.current = '';
    setRecovered(true);
  }
  function discardDraft(draft: EvidenceReport) {
    if (!window.confirm(`Discard the unsaved report “${draft.title.trim() || UNTITLED_REPORT}”?`)) return;
    clearRecoveryDraft(scope, draft.id);
    reloadList();
  }
  function copySavedReport(item: EvidenceReport) {
    try {
      const next = saveEvidenceReport({ ...item, id: crypto.randomUUID(), title: `${item.title} (copy)`, createdAt: Date.now() });
      let original = emptyHistory();
      try { original = loadReportHistory(scope, item.id); } catch { /* The copy starts its own history. */ }
      const problem = keepRevision(next, { history: original, before: item }, { kind: 'edit', label: `Saved as a copy of “${item.title}”` });
      setError(''); setNotice(problem); reloadList();
    } catch (e) { setError(`Could not copy report: ${message(e)}`); }
  }
  /** Copy a saved report into another workspace, with its history. It keeps its id there (ids are
   *  per workspace) unless that workspace already has one by that id. Its SQL names catalogs by
   *  alias, so it runs as is only where the same aliases are attached. */
  function copyToWorkspace(item: EvidenceReport, target: Workspace) {
    try {
      const targetDefault = target.catalogs.find(c => c.id === target.defaultCatalogId) ?? target.catalogs[0];
      let existing: EvidenceReport[] = [];
      try { existing = listEvidenceReports(target.id); } catch { /* Treated as empty. */ }
      const id = existing.some(r => r.id === item.id) ? crypto.randomUUID() : item.id;
      // It carries what it reads here, so opening it there can offer Rebind or Attach.
      const withRequires = withDerivedRequires(item, requireCatalogs());
      const copied = saveEvidenceReport({ ...withRequires, id, workspaceId: target.id, serviceUrl: targetDefault?.url ?? item.serviceUrl, title: id === item.id ? item.title : `${item.title} (copy)` });
      try { saveReportHistory(target.id, copied.id, loadReportHistory(scope, item.id)); } catch { /* The copy starts its own history. */ }
      const unmet = resolveRequires(copied.requires, requireCatalogs(target));
      const names = [...unmet.rebind.map(r => r.from), ...unmet.missing.map(r => r.alias)];
      setError('');
      setNotice(`Copied “${item.title}” to ${workspaceLabel(target)}.${names.length ? ` That workspace has no catalog named ${names.join(', ')}, which the report reads; opening it there offers to rebind or attach ${names.length === 1 ? 'it' : 'them'}.` : ''}`);
    } catch (e) { setError(`Could not copy the report: ${describeReportError(e)}`); }
  }
  /** Download reports as a report file, to move them to another browser or person. */
  function exportReports(items: EvidenceReport[]) {
    try {
      const valid = items.map(item => validateEvidenceReport(item));
      // Each report with its full revision history.
      const entries = valid.map(report => ({ report, history: loadReportHistory(scope, report.id) }));
      const url = URL.createObjectURL(new Blob([serializeReportFile(entries)], { type: 'application/json' }));
      Object.assign(document.createElement('a'), { href: url, download: reportFileName(valid) }).click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setError('');
    } catch (e) { setError(`Could not export: ${message(e)}`); }
  }
  const importInput = useRef<HTMLInputElement>(null);
  /** Save the reports in report files to this service's saved reports. */
  async function importReportFiles(files: File[]) {
    const problems: string[] = [];
    const incoming: EvidenceReport[] = [];
    const histories: ReportHistory[] = [];
    const sources: string[] = [];
    for (const file of files) {
      try {
        const parsed = parseReportFile(await file.text());
        incoming.push(...parsed.reports);
        histories.push(...parsed.histories);
        sources.push(...parsed.reports.map(() => file.name));
        problems.push(...parsed.errors.map(error => `${file.name}: ${error}`));
      } catch (e) { problems.push(`${file.name}: ${message(e)}`); }
    }
    let current: EvidenceReport[] = [];
    try { current = listEvidenceReports(scope); } catch (e) { problems.push(`Could not read saved reports: ${message(e)}`); }
    const plans = planImport(incoming, current, { serviceUrl, workspaceId }, (existing, next) => window.confirm(
      `“${existing.title}” is already saved in this browser, and the imported “${next.title}” differs from it.\n\nOK replaces the saved report. Cancel keeps both, saving the import as a copy.`));
    const counts = { new: 0, replace: 0, copy: 0, unchanged: 0 };
    for (const [index, plan] of plans.entries()) {
      // The file's history joins the saved report's; a changed report is itself a revision.
      const joined = (id: string) => {
        let saved = emptyHistory();
        if (plan.action === 'replace' || plan.action === 'unchanged') {
          try { saved = loadReportHistory(scope, id); } catch { /* Replaced by the file's. */ }
        }
        return mergeHistories(saved, histories[index]);
      };
      if (plan.action === 'unchanged') {
        counts.unchanged++;
        try {
          const merged = joined(plan.report.id);
          saveReportHistory(scope, plan.report.id, merged);
          if (plan.report.id === reportRef.current.id) setHistory(merged);
        } catch (e) { problems.push(`“${plan.report.title}”: its revision history could not be stored: ${message(e)}`); }
        continue;
      }
      try {
        const next = saveEvidenceReport(plan.report);
        const problem = keepRevision(next, { history: joined(next.id), before: null }, { kind: 'import', label: `Imported from ${sources[index]}` });
        if (problem) problems.push(`“${next.title}”: ${problem}`);
        counts[plan.action]++;
        // The open report was replaced: show the imported version unless it has unsaved edits.
        if (plan.action === 'replace' && next.id === reportRef.current.id && !dirtyRef.current) {
          reportRef.current = next; setReport(next); setSaved(JSON.stringify(next)); savedRef.current = JSON.stringify(next); baseline.current = savedRef.current; setRun(null);
        }
      } catch (e) { problems.push(`“${plan.report.title}”: ${message(e)}`); }
    }
    reloadList();
    // Reports written for catalogs this workspace has under other aliases, or doesn't have.
    const unmet = plans.filter(plan => plan.action !== 'unchanged' && !resolveRequires(plan.report.requires, requireCatalogs()).ok).length;
    const imported = counts.new + counts.replace + counts.copy;
    const details = [counts.replace && `${counts.replace} replaced`, counts.copy && `${counts.copy} kept as a copy`, counts.unchanged && `${counts.unchanged} already saved`].filter(Boolean).join(', ');
    setNotice(incoming.length ? `Imported ${imported} ${imported === 1 ? 'report' : 'reports'}${details ? ` (${details})` : ''}.${unmet ? ` ${unmet === 1 ? 'One reads catalogs' : `${unmet} read catalogs`} this workspace has under another alias or doesn't have: open ${unmet === 1 ? 'it' : 'one'} to rebind or attach them.` : ''}` : '');
    setError(problems.length ? `Could not import:\n${problems.join('\n')}` : '');
  }
  function remove(item: EvidenceReport) {
    if (!window.confirm(`Delete “${item.title}” from this browser?`)) return;
    try {
      deleteEvidenceReport(scope, item.id); reloadList();
      if (item.id === report.id) setSaved('');
      setError(''); setNotice('Report deleted.');
    } catch (e) { setError(`Could not delete report: ${message(e)}`); }
  }
  useSavedDocumentActions('report', scope, report.id, action => {
    const current = reportRef.current;
    switch (action.type) {
      case 'rename': {
        const next = { ...current, title: action.title };
        change(next);
        if (!persist(next, { kind: 'edit', label: 'Renamed report' }))
          throw new Error('The report could not be saved. Resolve its save error before renaming it.');
        break;
      }
      case 'duplicate': copyReport(current); reloadList(); break;
      case 'export': exportSavedReport(current); break;
      case 'delete':
        if (busyRef.current || exportingRef.current)
          throw new Error('Stop the report refresh or wait for its export before deleting this report.');
        deleteEvidenceReport(scope, current.id);
        deletedReportId.current = current.id;
        execution.current?.stop();
        savedRef.current = '';
        setSaved('');
        setHasOpenedReport(false);
        setEditing(false);
        setSaveError('');
        setRecovered(false);
        navigate(true);
        break;
    }
  });
  const visible = reports.filter(item => `${item.title} ${item.serviceUrl}`.toLowerCase().includes(search.toLowerCase()));
  const displayedRun = run ?? retained?.run;
  const filtersPending = Boolean(displayedRun && report.parameters.some(parameter => JSON.stringify(choices.values[parameter.key] ?? null) !== JSON.stringify(displayedRun.values[parameter.key] ?? null)));
  const pending = Boolean(displayedRun && (displayedRun.report.source !== report.source || displayedRun.report.setupSql !== report.setupSql || JSON.stringify(displayedRun.report.parameters) !== JSON.stringify(report.parameters) || filtersPending || JSON.stringify(displayedRun.report.semanticDatasets) !== JSON.stringify(report.semanticDatasets)));

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
    if (event.key.toLowerCase() === 's') { event.preventDefault(); checkpoint(); }
  }}>
    <header className="z-10 flex shrink-0 flex-wrap items-center gap-3 border-b bg-card px-5 py-3">
      {library ? <><FolderOpen className="size-4 text-muted-foreground" /><h1 className="text-sm font-semibold">Saved reports</h1><span className="text-xs text-muted-foreground">{reports.length} {reports.length === 1 ? 'report' : 'reports'}</span>
        <div className="ml-auto flex gap-2">
          <input ref={importInput} type="file" accept={`${REPORT_FILE_EXTENSION},.json,application/json`} multiple hidden aria-label="Report files to import"
            onChange={event => { const files = [...event.target.files ?? []]; event.target.value = ''; if (files.length) void importReportFiles(files); }} />
          <Button variant="outline" disabled={busy} onClick={() => importInput.current?.click()} title="Import reports from report files"><Upload />Import</Button>
          <Button variant="outline" disabled={!reports.length} onClick={() => exportReports(reports)} title="Download every saved report for this worker as one report file"><Download />Export all</Button>
          {hasOpenedReport && <Button variant="outline" disabled={busy} onClick={() => { navigate(false, report.id); if (!run) void refresh(report, 'replace'); }}>Back to report</Button>}<Button onClick={() => openReport(stamp(newEvidenceReport(serviceUrl, catalogName)), true, true)} disabled={busy}><Plus />New report</Button></div></>
        : <>
          <Button variant="ghost" size="sm" className="-ml-2" onClick={() => navigate(true)}><ArrowLeft />Saved reports</Button>
          <span className="text-muted-foreground" aria-hidden>/</span>
          <div className="flex min-w-0 flex-col">
            <span className="max-w-72 truncate text-sm font-semibold">{report.title.trim() || UNTITLED_REPORT}</span>
            <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
              <span role="status" aria-label="Save status" className={saveError ? 'text-destructive' : undefined} title={saveError ? 'Your changes are kept in this browser, and saved once the report is valid again.' : 'Saved locally for this data connection. Use Share to download a copy for another browser.'}>
                {saveError ? `Not saved: ${saveError}` : !dirty ? 'Saved in this browser' : saved || asSaved(report) !== baseline.current ? 'Saving in this browser…' : 'Not saved yet · saves here when you edit it'}
              </span>
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
            {/* Refresh and Stop share a slot; unapplied edits are explained above the results. */}
            {offerStop
              ? <Button key="stop" variant="outline" onClick={stopRefresh}><Square />Stop refresh</Button>
              : <Button key="refresh" variant="field" aria-label={editing ? 'Update preview' : 'Refresh report'} title={`${pending ? 'Changes not applied · ' : ''}⌘ / Ctrl + Enter`} onClick={() => void refresh()}>
                  <RefreshCw />{editing ? 'Update preview' : 'Refresh report'}
                  {pending && <span role="status" aria-label="Changes not applied" className="size-2 rounded-full bg-amber-400" />}
                </Button>}
            {(!editing || pdfExport.state !== 'idle') && <Button variant="outline" disabled={refreshing || !run || exporting || Boolean(pending)} onClick={() => void exportPdf()} aria-live="polite"
              title={pdfExport.state === 'done' && pdfExport.omitted.length ? `Not included: ${pdfExport.omitted.join(', ')}` : 'Download the report as a typeset PDF · The selected tab of each tab group, and every table row'}>
              {pdfExport.state === 'exporting' ? <><Loader2 className="animate-spin" />{pdfExport.progress ? `Preparing PDF ${pdfExport.progress}…` : 'Preparing PDF…'}</>
                : pdfExport.state === 'done' ? <><Check />PDF exported{pdfExport.omitted.length ? ` · ${pdfExport.omitted.length} not included` : ''}</>
                : <><FileDown />Export PDF</>}
            </Button>}
            <ReportSharing canExportPdf={!refreshing && Boolean(run) && !exporting} pending={Boolean(pending)} onPdf={() => void exportPdf()} onFile={() => exportReports([report])} />
            {!focused && <Button variant="ghost" size="icon" aria-label="Focus report" title="Focus report" onClick={() => setFocused(true)}><Maximize2 /></Button>}
            {saveError && <Button variant="outline" onClick={checkpoint} title={`Not saved: ${saveError}. Your changes are kept in this browser until they can be.`}><Save />Retry save</Button>}
            {focused
              ? <Button variant="ghost" size="icon" aria-label="Exit focus mode" title="Exit focus mode · Esc" onClick={() => { setEditorOnly(false); setFocused(false); }}><Minimize2 /></Button>
              : <DropdownMenu>
                  <DropdownMenuTrigger aria-label="More report actions" className={buttonVariants({ variant: 'ghost', size: 'icon' })}><MoreHorizontal /></DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-44">
                    {editing && <DropdownMenuItem disabled={refreshing || !run || exporting || Boolean(pending)} onClick={() => void exportPdf()}><FileDown />Export PDF</DropdownMenuItem>}
                    {run?.report.parameters.filter(item => item.type === 'select' || item.type === 'multi_select').map(item => <DropdownMenuItem key={item.key} disabled={refreshing || exporting} onClick={() => void exportPdfPerValue(item.key)}><FileDown />PDF per {item.label.toLowerCase()}</DropdownMenuItem>)}
                    <DropdownMenuItem onClick={saveCopy}><Copy />Save a copy</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => exportReports([report])}><Download />Export report file</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => setFocused(true)}><Maximize2 />Focus report</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>}
          </div></>}

    </header>
    {error && <div role="alert" className="m-5 whitespace-pre-wrap rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
    {notice && <p role="status" className="mx-5 mt-3 text-xs text-muted-foreground">{notice}</p>}
    {recovered && !library && <p role="status" className="mx-5 mt-3 text-xs text-muted-foreground">{RECOVERED_NOTICE}</p>}
    {showRequires && <div role="region" aria-label="Report catalogs" data-testid="report-requires-banner" className="mx-5 mt-3 space-y-2 rounded-lg border border-amber-300 bg-amber-50/60 p-3 text-sm dark:border-amber-700/60 dark:bg-amber-950/20">
      {requires.rebind.length > 0 && <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1">
          This report was written for {requires.rebind.map((item, index) => <span key={item.from}>{index > 0 && ', '}<code>{item.from}</code>{item.from.toLowerCase() !== item.to.toLowerCase() && <> (here <code>{item.to}</code>)</>}</span>)}: the same {requires.rebind.length === 1 ? 'catalog' : 'catalogs'} under another alias in this workspace.
        </p>
        <Button size="sm" disabled={busy} onClick={rebind}>Rebind</Button>
      </div>}
      {requires.missing.map(item => <div key={item.alias} className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1">This report reads <code>{item.alias}</code> ({item.catalogName || 'catalog'} on {hostOf(item.url)}), which isn't in this workspace.</p>
        <Button size="sm" variant="outline" onClick={() => openAttachCatalog({ url: item.url, catalogName: item.catalogName || undefined, alias: item.alias })}>Attach {item.alias}…</Button>
      </div>)}
      <div className="flex justify-end">
        <Button size="sm" variant="ghost" onClick={() => setRequiresDismissed(current => new Set([...current, report.id]))}>{requires.missing.length ? 'Open anyway' : 'Not now'}</Button>
      </div>
    </div>}
    <section hidden={!library} className="mx-auto w-full max-w-6xl flex-1 overflow-auto space-y-5 p-5" aria-label="Saved reports list">
      <p className="text-sm text-muted-foreground">Reports are saved in this browser for the current data connection. They do not sync between devices. Use Share in an open report, or Export all, to download copies. Import adds an editable report file; its queries run with your connection when opened, so import only reports you trust.</p>
      <div className="relative max-w-sm"><Search className="absolute left-2.5 top-2 size-4 text-muted-foreground" /><Input className="pl-8" aria-label="Search saved reports" placeholder="Search reports…" value={search} onChange={e => setSearch(e.target.value)} /></div>
      {unsavedDrafts.length > 0 && <section aria-label="Unsaved reports" className="rounded-lg border border-amber-300 bg-amber-50/40 p-4 dark:border-amber-700/60 dark:bg-amber-950/20">
        <h2 className="text-sm font-semibold">Unsaved reports</h2>
        <p className="mt-1 text-xs text-muted-foreground">New reports that could not be saved yet, kept in this browser. Continue one to fix what stopped it from saving.</p>
        <ul className="mt-3 space-y-2">{unsavedDrafts.map(({ report: draft, savedAt }) => <li key={draft.id} className="flex flex-wrap items-center gap-2 text-sm">
          <span className="min-w-0 flex-1 truncate font-medium">{draft.title.trim() || UNTITLED_REPORT}</span>
          {savedAt > 0 && <span className="text-xs text-muted-foreground">Last edited {new Date(savedAt).toLocaleString()}</span>}
          <Button variant="outline" size="sm" disabled={busy} onClick={() => resumeDraft(draft)}>Continue editing</Button>
          <Button variant="ghost" size="icon" aria-label={`Discard ${draft.title.trim() || UNTITLED_REPORT}`} title="Discard this unsaved report" onClick={() => discardDraft(draft)}><Trash2 /></Button>
        </li>)}</ul>
      </section>}
      {visible.length ? <div className="overflow-x-auto rounded-lg border bg-card"><table className="w-full text-left text-sm"><thead className="border-b bg-muted/40 text-xs text-muted-foreground"><tr><th className="px-4 py-3">Report</th><th className="px-4 py-3">Parameters</th><th className="px-4 py-3">Last saved</th><th className="px-4 py-3"><span className="sr-only">Actions</span></th></tr></thead><tbody>{visible.map(item => <tr key={item.id} className="border-b last:border-0">
        <td className="px-4 py-3">
          <Button variant="link" className="h-auto justify-start whitespace-normal p-0 text-left font-medium" disabled={busy} onClick={() => openReport(item)}>{item.title}</Button>
          <span className="mt-1 block max-w-sm truncate text-xs text-muted-foreground">{item.serviceUrl}</span>
        </td><td className="px-4 py-3 text-xs text-muted-foreground">{item.parameters.map(p => p.label).join(', ') || 'None'}</td><td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">{new Date(item.updatedAt).toLocaleString()}</td>
        <td className="px-4 py-3"><div className="flex justify-end gap-2"><Button variant="outline" disabled={busy} onClick={() => openReport(item)}>Open report</Button><Button variant="ghost" size="icon" aria-label={`Export ${item.title}`} title="Export report file" onClick={() => exportReports([item])}><Download /></Button><Button variant="ghost" size="icon" aria-label={`Copy ${item.title}`} title="Copy report" onClick={() => copySavedReport(item)}><Copy /></Button>{workspaceId && <CopyToWorkspaceMenu currentId={workspaceId} title={item.title} onCopy={target => copyToWorkspace(item, target)} />}<Button variant="ghost" size="icon" aria-label={`Delete ${item.title}`} onClick={() => remove(item)}><Trash2 /></Button></div></td>
      </tr>)}</tbody></table></div> : <div className="rounded-lg border border-dashed p-12 text-center"><FileText className="mx-auto mb-3 size-7 text-muted-foreground" /><h2 className="text-sm font-semibold">{reports.length ? 'No matching reports' : 'No saved reports yet'}</h2><p className="mt-2 text-xs text-muted-foreground">{reports.length ? 'Try a different search.' : 'Create a report and choose a sample layout, or describe what you want to the report assistant. Your edits save automatically in this browser.'}</p></div>}
      <div className="flex flex-wrap gap-2">
        {isWeatherService(serviceUrl) && <Button variant="outline" disabled={busy} onClick={() => openReport(stamp(newEvidenceReport(serviceUrl, catalogName, true)), true, true)}>Use weather example</Button>}
        {serviceUrl === WEATHER_TEST_SERVICE && <Button variant="outline" disabled={busy} onClick={() => openReport(stamp(newDrillExampleReport(serviceUrl)), true, true)}>Use drilldown example</Button>}
      </div>
    </section>
    <main hidden={library} className="min-h-0 flex-1 flex-col" style={{ display: library ? 'none' : 'flex' }}>
      {editing && !editorOnly && <div className="flex shrink-0 gap-2 border-b p-2 lg:hidden" role="group" aria-label="Report workspace view">
        <Button size="sm" variant={compactView === 'editor' ? 'secondary' : 'ghost'} aria-pressed={compactView === 'editor'} onClick={() => setCompactView('editor')}>Editor</Button>
        <Button size="sm" variant={compactView === 'preview' ? 'secondary' : 'ghost'} aria-pressed={compactView === 'preview'} onClick={() => setCompactView('preview')}>Preview</Button>
      </div>}
      <div ref={split} style={{ '--evidence-editor-width': `clamp(280px, ${editorWidth}%, calc(100% - 288px))` } as CSSProperties} className={`grid min-h-0 flex-1 ${editing && !editorOnly ? 'grid-rows-1 overflow-hidden lg:grid-cols-[minmax(0,1fr)_8px_var(--evidence-editor-width)]' : 'grid-rows-1'}`}>
        <section style={{ display: editing && editorOnly ? 'none' : undefined }} aria-label={editing ? 'Report preview' : 'Report viewer'} className={`${editing && compactView === 'editor' ? 'hidden lg:flex' : 'flex'} min-h-0 min-w-0 flex-col`}>
          <div data-testid="evidence-viewer-scroll" className="min-h-0 flex-1 overflow-auto bg-muted/20 p-3 md:p-6">
            <article data-testid="evidence-report-surface" data-print-title={report.title} data-report-mode={reportTheme.mode} style={reportTheme.style} aria-busy={busy} className="mx-auto min-w-0 max-w-6xl rounded-lg border bg-card p-5 md:p-8">
              {pending && !busy && <p role="status" aria-label="Unapplied report changes" className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                {filtersPending ? 'Filters have changed. Results below still use the applied filters.' : 'Your edits have not been applied. The preview still shows the previous version.'} {editing ? 'Update preview to apply changes.' : 'Refresh the report to apply changes.'}
              </p>}
              {run && <div className="evidence-print-heading">
                <h1>{report.title}</h1>
                <p>Current report view{updated ? ` · Updated ${updated}` : ''}</p>
                {pending && <p>Unapplied changes are not included.</p>}
                {run.report.parameters.length > 0 && <dl>{run.report.parameters.map(parameter => <div key={parameter.id}><dt>{parameter.label}</dt><dd>{describeParameter(parameter, run.values, choices.states)}</dd></div>)}</dl>}
              </div>}
              {report.parameters.length > 0 && <form className="mb-6 flex flex-wrap items-end gap-4 border-b pb-5" onSubmit={event => { event.preventDefault(); void refresh(); }} aria-label="Report inputs">
                {report.parameters.map(parameter => <label key={parameter.id} className={`min-w-32 ${parameter.type === 'date_range' ? 'max-w-80' : 'max-w-56'} space-y-1 text-xs font-medium`}>{parameter.label}{parameter.required && <span className="text-muted-foreground"> *</span>}<ParameterInput parameter={parameter} value={choices.values[parameter.key] ?? null} choices={choices.states[parameter.key]} label={parameter.label} disabled={busy} onChange={value => { choices.clearNotes(); change({ ...report, values: { ...report.values, [parameter.key]: value } }); }} /></label>)}
                <div className="flex gap-2">
                  <Button type="submit" size="sm" disabled={refreshing || exporting || !filtersPending}>Apply filters</Button>
                  <Button type="button" size="sm" variant="ghost" disabled={refreshing || exporting} onClick={() => { const next = { ...report, values: {} }; change(next); void refresh(next); }}>Reset filters</Button>
                </div>
                {displayedRun && <p aria-label="Applied filters" className="basis-full text-xs text-muted-foreground">Results use: {displayedRun.appliedFilters}</p>}
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
              {run ? <EvidencePreview reportTheme={reportTheme} run={run} drill={previewDrill} onInputs={read => { readInputs.current = read; }} onData={context => { setDataContext(context); setMountedRevision(run.revision); }} onIssues={setSpecIssues} onQuery={entry => { setLogs(current => [...current.slice(-99), entry]); profiler.current?.query({ ...entry, phase: 'render' }); }} onError={message => { setError(message); setSpecIssues(current => [...current, { message, severity: 'error', target: 'document' }]); }} /> : <>
                {busy && <EvidenceRefreshProgress profile={profile} phases={refreshPhases} fallback={status} />}
                {retained ? <section aria-label="Last successful preview">
                  <p role="status" className="mb-3 rounded-md border bg-muted p-3 text-sm">{busy ? 'Refreshing. Showing the previous results until the new data is ready.' : 'Refresh did not complete. Showing the previous results.'} This preview is read-only.</p>
                  <RetainedReportPreview content={retained.content} />
                </section> : !busy && <p className="py-8 text-sm text-muted-foreground" role="status">Refresh to render this report.</p>}
              </>}
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
        <div style={{ display: editing ? undefined : 'none' }} className={`${!editorOnly && compactView === 'preview' ? 'hidden lg:flex' : 'flex'} min-h-0 min-w-0 flex-col [&>aside]:flex-1`}>{deletedReportId.current !== report.id && <EvidenceEditor history={{ history, dirty, onRestore: restoreRevision, onDelete: deleteRevision }} onProposal={proposalEvent} performance={{ profile, namedQueries: dataContext?.queries ?? [], runnable: sql => {
          if (!run) return sql;
          try { return materializeReportQuery(sql, compilerParameters(run.report, run.values), run.values); } catch { return sql; }
        } }} parameterChoices={{ states: choices.states, values: choices.values, loader: choices.loader }} fullScreen={focused && editorOnly} onToggleFullScreen={() => { const exit = focused && editorOnly; setFocused(!exit); setEditorOnly(!exit); }} catalogs={catalogs} semanticStates={semanticStates} reportTheme={reportTheme} dataContext={dataContext} onRefreshData={async () => { await refresh(); }} key={report.id} report={report} onChange={change} issues={issues} issuesStale={checkedSpec.current !== diagnosticSpec(report)} stale={Boolean(pending)} editorOnly={editorOnly} onTogglePreview={() => { setEditorOnly(!editorOnly); setCompactView(editorOnly ? 'preview' : 'editor'); }} previewBusy={busy} onApplyPreview={async next => { setEditorOnly(false); setCompactView('preview'); await refresh(next); }} />}</div>
      </div>
    </main>
  </div>;
}

/** "Copy to workspace…": every other workspace in this browser. */
function CopyToWorkspaceMenu({ currentId, title, onCopy }: { currentId: string; title: string; onCopy: (target: Workspace) => void }) {
  const [targets, setTargets] = useState<Workspace[]>([]);
  return <DropdownMenu onOpenChange={open => { if (open) setTargets(listWorkspaces().filter(w => w.id !== currentId)); }}>
    <DropdownMenuTrigger aria-label={`Copy ${title} to workspace`} title="Copy to workspace…" className={buttonVariants({ variant: 'ghost', size: 'icon' })}><FolderOpen /></DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="min-w-52">
      {targets.length ? targets.map(w => <DropdownMenuItem key={w.id} onClick={() => onCopy(w)}>{workspaceLabel(w)}</DropdownMenuItem>)
        : <DropdownMenuItem disabled>No other workspaces</DropdownMenuItem>}
    </DropdownMenuContent>
  </DropdownMenu>;
}
