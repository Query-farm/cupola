import { catalogInventory } from "@/lib/catalog-store";
/**
 * DBeaver-style SQL editor surface: a tab strip of named query documents, a
 * CodeMirror editor with a run toolbar, and a results grid below. Coexists
 * with the xterm shell (shared DuckDB session via the bridge) and the catalog
 * sidebar (rendered by CatalogApp alongside this view).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { format as formatSql } from "sql-formatter";
import * as Sentry from "@sentry/astro";
import { tableToIPC } from "@query-farm/apache-arrow";
import { decodeArrowBuffer } from "@/lib/duckdb-query";
import { engine, ui, recordQuery, waitForEngineReady } from "@/lib/shell-bridge";
import { useEngineLifecycle } from "@/lib/use-engine-lifecycle";
import { useSettings } from "@/lib/settings";
import type { CatalogData } from "@/lib/service";
import {
  loadEditorState,
  saveEditorState,
  addDoc,
  removeDoc,
  renameDoc,
  updateDocSql,
  setActive,
  type EditorState as EditorDocState,
} from "@/lib/editor/editor-store";
import { sqlAutoCompleteSource } from "@/lib/editor/sql-autocomplete";
import { buildTableSelect, isTableRef } from "@/lib/sql/table-select";
import { useMediaQuery } from "@/lib/use-media-query";
import { treeIdToShellText } from "@/lib/tree";
import { exportResult, triggerDownload, safeFileStem, type ExportFormat } from "@/lib/editor/result-export";
import type { PerspectivePivotMode, QueryPivotMode } from "@/lib/pivot-source";
import { CodeMirrorSql, type CodeMirrorSqlHandle, type SqlEditorSession } from "./CodeMirrorSql";
import { SqlEditorTabs } from "./SqlEditorTabs";
import { EditorToolbar } from "./EditorToolbar";
import { EditorResultsPane, emptyResult, type ResultState } from "./EditorResultsPane";
import { EditorAiPanel } from "./EditorAiPanel";
import { RightDock, useDockState } from "./RightDock";
import { ConfirmCloseQueryDialog, type PendingClose } from "./ConfirmCloseQueryDialog";
import { KeyboardShortcutsDialog } from "./KeyboardShortcutsDialog";
import { HistoryPanel } from "./HistoryPanel";
import { deleteTabRevisions, recordRevision, type RevisionKind, type RunOutcome } from "@/lib/editor/tab-revisions";
import { Inspector } from "@/components/inspector/Inspector";
import { parseSelection, type Selection } from "@/lib/tree";
import { callablesForSelection, type Callable } from "@/lib/callable";
import { buildCatalogIndex } from "@/lib/catalog-index";
import { builtinFunctions, loadBuiltinFunctions, onBuiltinFunctionsLoaded } from "@/lib/builtin-functions";
import { buildCallSnippet } from "@/lib/editor/call-snippet";
import { openPopout, updateLatest } from "@/lib/editor/result-popout";
import type { SqlApplyActions } from "./EditorSqlToolCallBlock";
import { buildShareQueryUrl } from "@/lib/share-query";
import { promoteToReport } from "@/lib/reports/events";

/** SQL pushed into the editor from outside. Always lands in a new tab, which
 *  becomes the active one; `autoRun` decides whether it also executes. */
export interface PendingEditorSql {
  sql: string;
  autoRun: boolean;
}

interface Props {
  catalogData: CatalogData;
  attachedCatalogs?: CatalogData[];
  serviceUrl: string;
  /** Resolved ATTACH options fragment, propagated into share links. */
  attachOptions?: string;
  /** SQL pushed in from elsewhere (example queries, AI panels, shared
   *  links). Opens a new tab; call onPendingConsumed once handled. */
  pendingSql?: PendingEditorSql | null;
  onPendingConsumed?: () => void;
  /** True while any sub-tab's Ask AI conversation has a turn in flight, so the
   *  app tab bar can flag it from outside the editor. */
  onAiBusyChange?: (busy: boolean) => void;
  /** The sidebar's current selection; the Inspector follows it. */
  selection?: Selection | null;
  /** Bumped each time the sidebar asks to inspect its selection. */
  inspectRequest?: number;
  /** Show a selection's full catalog page. */
  onOpenFullPage?: (selection: Selection) => void;
}

const INSPECTABLE = new Set(["function", "macro", "table", "view"]);

export function SqlEditorView({ catalogData, attachedCatalogs = [], serviceUrl, attachOptions, pendingSql, onPendingConsumed, onAiBusyChange, selection = null, inspectRequest = 0, onOpenFullPage }: Props) {
  const { settings } = useSettings();
  const isNarrow = useMediaQuery("(max-width: 767px)");
  // Transient "Copied" confirmation on the Share button.
  const [shareCopied, setShareCopied] = useState(false);
  const [docState, setDocState] = useState<EditorDocState>(() => loadEditorState(serviceUrl));
  const [results, setResults] = useState<Record<string, ResultState>>({});
  const [hasSelection, setHasSelection] = useState(false);
  // Right-hand panel shared by the Inspector and Ask AI.
  const dock = useDockState();
  const aiOpen = dock.open && dock.tab === "ai";
  // The Inspector shows the last function/macro/table/view picked in the
  // sidebar (a schema click leaves it alone), unless pinned to one.
  const [lastInspectable, setLastInspectable] = useState<Selection | null>(null);
  const [pinned, setPinned] = useState<Selection | null>(null);
  useEffect(() => {
    if (selection && INSPECTABLE.has(selection.type)) setLastInspectable(selection);
  }, [selection]);
  const showDock = dock.show;
  useEffect(() => {
    if (inspectRequest > 0) showDock("inspector");
  }, [inspectRequest, showDock]);
  const inspectorTarget = pinned ?? lastInspectable;
  // Doc ids whose AI conversation is mid-turn. Conversations are per sub-tab
  // and the panel can be closed outright, so a running agent is otherwise
  // invisible the moment the user switches tabs or collapses the panel.
  const [aiBusyDocs, setAiBusyDocs] = useState<Set<string>>(() => new Set());
  const handleAiBusyChange = useCallback((id: string, busy: boolean) => {
    setAiBusyDocs((prev) => {
      if (prev.has(id) === busy) return prev;
      const next = new Set(prev);
      if (busy) next.add(id); else next.delete(id);
      return next;
    });
  }, []);
  useEffect(() => { onAiBusyChange?.(aiBusyDocs.size > 0); }, [aiBusyDocs, onAiBusyChange]);
  // Leaving the editor unmounts the panel and aborts its turns; make sure the
  // parent's flag doesn't stay stuck on.
  useEffect(() => () => onAiBusyChange?.(false), [onAiBusyChange]);
  // Vertical editor/results split (fraction of the left column the editor pane
  // gets). Persisted; clamped so neither pane collapses.
  const SPLIT_MIN = 0.2, SPLIT_MAX = 0.8;
  const [editorFrac, setEditorFrac] = useState<number>(() => {
    try { const n = parseFloat(localStorage.getItem("vgi-editor-split") || ""); if (n >= SPLIT_MIN && n <= SPLIT_MAX) return n; } catch {}
    return 0.42;
  });
  const splitColRef = useRef<HTMLDivElement>(null);
  const engineLifecycle = useEngineLifecycle();
  const queryReady = engineLifecycle.status === "ready";

  const editorRef = useRef<CodeMirrorSqlHandle | null>(null);
  const editorSessions = useRef(new Map<string, SqlEditorSession>());
  const runIdRef = useRef(0);
  // One manual run owns the connection until completion or an explicit Stop.
  const activeRunRef = useRef<{ controller: AbortController; docId: string } | null>(null);
  const [runningDocId, setRunningDocId] = useState<string | null>(null);
  // Persist edits (debounced) without re-rendering on every keystroke.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest doc state, so the flush-on-hide/unmount handler writes current text
  // even if the 400ms debounce hasn't fired yet (prevents losing recent edits
  // on reload / tab close).
  const docStateRef = useRef(docState);
  docStateRef.current = docState;

  const activeId = docState.activeId;
  const activeDoc = useMemo(
    () => docState.docs.find((d) => d.id === activeId) ?? docState.docs[0],
    [docState, activeId],
  );
  const activeResult = (activeId && results[activeId]) || emptyResult;
  const activeSession = useMemo(() => {
    if (!activeId) return undefined;
    let session = editorSessions.current.get(activeId);
    if (!session) editorSessions.current.set(activeId, session = {});
    return session;
  }, [activeId]);
  const backgroundRun = runningDocId && runningDocId !== activeId
    ? docState.docs.find((doc) => doc.id === runningDocId) : null;

  const persist = useCallback((next: EditorDocState) => {
    setDocState(next);
    saveEditorState(next, serviceUrl);
  }, [serviceUrl]);

  // Flush any pending debounced save when the page is hidden/closed or the
  // editor unmounts. CatalogApp keeps this view mounted across tab switches
  // (so results survive), so unmount now means page teardown — the 400ms
  // debounce is what covers a switch away mid-edit.
  useEffect(() => {
    const flush = () => {
      if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
      saveEditorState(docStateRef.current, serviceUrl);
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flush);
      flush();
    };
  }, [serviceUrl]);

  // ---- document model -----------------------------------------------------
  const handleDocChange = useCallback((sql: string) => {
    if (!activeId) return;
    setDocState((prev) => {
      const next = updateDocSql(prev, activeId, sql);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => saveEditorState(next, serviceUrl), 400);
      return next;
    });
  }, [activeId, serviceUrl]);

  const handleAddTab = useCallback((sql = "") => {
    persist(addDoc(docState, sql));
  }, [docState, persist]);

  const closeTab = useCallback((id: string) => {
    if (activeRunRef.current?.docId === id) {
      activeRunRef.current.controller.abort();
      activeRunRef.current = null;
      ++runIdRef.current;
      setRunningDocId(null);
    }
    editorSessions.current.delete(id);
    deleteTabRevisions(serviceUrl, id);
    persist(removeDoc(docStateRef.current, id));
    setResults((prev) => { const { [id]: _drop, ...rest } = prev; return rest; });
  }, [persist, serviceUrl]);

  // Closing a tab deletes its query, so one with SQL in it asks first.
  const [pendingClose, setPendingClose] = useState<PendingClose | null>(null);
  const handleCloseTab = useCallback((id: string) => {
    const doc = docState.docs.find((d) => d.id === id);
    if (!doc) return;
    // The active tab's text is in CodeMirror; the stored copy lags by the save debounce.
    const sql = id === docState.activeId && editorRef.current ? editorRef.current.getDoc() : doc.sql;
    if (!sql.trim()) { closeTab(id); return; }
    setPendingClose({ id, name: doc.name, sql });
  }, [docState, closeTab]);

  const handleRename = useCallback((id: string, name: string) => {
    persist(renameDoc(docState, id, name));
  }, [docState, persist]);

  const handleSelectTab = useCallback((id: string) => {
    persist(setActive(docState, id));
  }, [docState, persist]);

  // ---- execution ----------------------------------------------------------
  const setActiveResult = useCallback((id: string, patch: Partial<ResultState>) => {
    setResults((prev) => ({ ...prev, [id]: { ...(prev[id] ?? emptyResult), ...patch } }));
  }, []);

  const runSql = useCallback(async (sql: string, docId: string) => {
    const trimmed = sql.trim();
    // Also guard keyboard shortcuts and externally requested runs, including
    // repeated key presses before React has rendered the disabled controls.
    if (!trimmed || activeRunRef.current) return;
    // The tab's whole text as it ran: a revision of the tab once the run ends.
    const docText = (docId === docStateRef.current.activeId ? editorRef.current?.getDoc() : undefined)
      ?? docStateRef.current.docs.find((d) => d.id === docId)?.sql ?? trimmed;
    const tab = { docId };
    const statement = docText.trim() !== trimmed ? trimmed : undefined;
    const ran = (outcome: RunOutcome) => recordRevision(serviceUrl, docId, docText, "run", { statement, outcome });
    const myRun = ++runIdRef.current;
    const controller = new AbortController();
    activeRunRef.current = { controller, docId };
    setRunningDocId(docId);
    setActiveResult(docId, { running: true, ran: true, error: null, cancelled: false });

    // Only the latest run owns the slot; a superseded one leaves it alone.
    const release = () => {
      if (activeRunRef.current?.controller === controller) {
        activeRunRef.current = null;
        setRunningDocId(null);
      }
    };

    try {
      await waitForEngineReady();
    } catch (error) {
      release();
      if (myRun !== runIdRef.current) return;
      setActiveResult(docId, { running: false, error: error instanceof Error ? error.message : "The query engine couldn't start." });
      return;
    }
    if (myRun !== runIdRef.current) { release(); return; }
    const q = engine.query;
    if (!q) {
      release();
      setActiveResult(docId, { running: false, error: "The query engine is not ready yet." });
      return;
    }

    const t0 = performance.now();
    let res;
    try {
      // With a signal the engine runs this as a pending query it can cancel
      // between polls; without one it is a single blocking call Stop can't reach.
      res = await q(trimmed, { signal: controller.signal });
    } catch (e) {
      release();
      if (myRun !== runIdRef.current) return;
      if (controller.signal.aborted) {
        setActiveResult(docId, { running: false, cancelled: true, error: null, table: null });
        recordQuery({ ...tab, source: "editor", sql: trimmed, executionTimeMs: Math.round(performance.now() - t0), success: false, error: "Query cancelled" });
        ran({ success: false, error: "Query cancelled", ms: Math.round(performance.now() - t0) });
        return;
      }
      setActiveResult(docId, { running: false, error: e instanceof Error ? e.message : String(e) });
      ran({ success: false, error: e instanceof Error ? e.message : String(e), ms: Math.round(performance.now() - t0) });
      return;
    }
    release();
    if (myRun !== runIdRef.current) return;
    const elapsedMs = Math.round(performance.now() - t0);

    if (!res.ok) {
      setActiveResult(docId, { running: false, error: res.error || "Query failed", ok: false, table: null });
      recordQuery({ ...tab, source: "editor", sql: trimmed, executionTimeMs: elapsedMs, success: false, error: res.error });
      ran({ success: false, error: res.error || "Query failed", ms: elapsedMs });
      maybeSelectError(res.error);
      return;
    }

    const buf = res.arrowBuffers?.[0];
    const isEmpty = !buf || (buf instanceof ArrayBuffer ? buf.byteLength === 0 : (buf as Uint8Array).length === 0);
    if (isEmpty) {
      setActiveResult(docId, { running: false, error: null, ok: true, table: null, rowCount: 0, elapsedMs });
      recordQuery({ ...tab, source: "editor", sql: trimmed, executionTimeMs: elapsedMs, success: true });
      ran({ success: true, ms: elapsedMs });
      return;
    }
    const table = decodeArrowBuffer(buf);
    // DDL/INSERT etc. come back as a single "Count" column.
    const fields = table.schema.fields;
    const isCount = fields.length === 1 && fields[0].name === "Count" && table.numRows <= 1;
    if (isCount) {
      setActiveResult(docId, { running: false, error: null, ok: true, table: null, rowCount: 0, elapsedMs });
      recordQuery({ ...tab, source: "editor", sql: trimmed, executionTimeMs: elapsedMs, success: true });
      ran({ success: true, ms: elapsedMs });
      return;
    }
    setActiveResult(docId, {
      running: false, error: null, ok: true, table, sourceSql: trimmed, rowCount: table.numRows, elapsedMs,
    });
    recordQuery({ ...tab, source: "editor", sql: trimmed, executionTimeMs: elapsedMs, success: true, rowCount: table.numRows });
    ran({ success: true, rowCount: table.numRows, ms: elapsedMs });
  }, [setActiveResult, serviceUrl]);

  /** Best-effort: if a DuckDB error names a character offset, select it. */
  const maybeSelectError = useCallback((errMsg?: string) => {
    if (!errMsg || !editorRef.current) return;
    const m = /(?:at|near) (?:character|position) (\d+)/i.exec(errMsg) ?? /LINE \d+:\s/.exec(errMsg);
    if (m && m[1]) {
      const pos = Number(m[1]);
      if (Number.isFinite(pos)) editorRef.current.selectRange(pos, pos + 1);
    }
  }, []);

  /** What Run executes: the selection if there is one, else the statement at the cursor. */
  const sqlToRun = useCallback((): string | null => {
    if (!editorRef.current) return null;
    const selection = editorRef.current.getSelectionText();
    if (selection.trim()) return selection;
    return editorRef.current.getStatementAtCursor()?.text ?? null;
  }, []);

  const handleRun = useCallback(() => {
    if (!activeId) return;
    const sql = sqlToRun();
    if (sql) runSql(sql, activeId);
  }, [activeId, runSql, sqlToRun]);

  const handleRunAll = useCallback(() => {
    if (!activeId || !editorRef.current) return;
    runSql(editorRef.current.getDoc(), activeId);
  }, [activeId, runSql]);

  // EXPLAIN of what Run would execute; the results pane draws the plan.
  const handleExplain = useCallback(() => {
    if (!activeId) return;
    const sql = sqlToRun()?.trim().replace(/;\s*$/, "");
    if (!sql) return;
    runSql(/^explain\b/i.test(sql) ? sql : `EXPLAIN ${sql}`, activeId);
  }, [activeId, runSql, sqlToRun]);

  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const handleStop = useCallback(() => {
    activeRunRef.current?.controller.abort();
  }, []);

  // ---- toolbar actions ----------------------------------------------------
  // A whole-buffer change (Ask AI applying SQL, Restore, Format) snapshots the
  // text it replaces and the text it leaves, so neither exists only in undo.
  const replacingBuffer = useCallback((kind: RevisionKind, change: () => void) => {
    const ed = editorRef.current;
    const id = docStateRef.current.activeId;
    if (!ed || !id) { change(); return; }
    recordRevision(serviceUrl, id, ed.getDoc(), "edit");
    change();
    recordRevision(serviceUrl, id, ed.getDoc(), kind);
  }, [serviceUrl]);

  const handleFormat = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const sel = ed.getSelectionText();
    try {
      if (sel.trim()) {
        // No partial-range replace API exposed; format the whole doc when no
        // selection, otherwise insert the formatted selection in place.
        ed.insertAtCursor(formatSql(sel, { language: "duckdb", keywordCase: "upper", tabWidth: 2 }));
      } else {
        const doc = ed.getDoc();
        if (doc.trim()) {
          const formatted = formatSql(doc, { language: "duckdb", keywordCase: "upper", tabWidth: 2 });
          replacingBuffer("format", () => ed.setDoc(formatted));
        }
      }
    } catch {
      // sql-formatter throws on unparseable input — leave the text untouched.
    }
  }, [replacingBuffer]);

  const handleExport = useCallback(async (fmt: ExportFormat) => {
    const table = activeResult.table;
    if (!table) return;
    if (settings.aiTelemetry) {
      Sentry.addBreadcrumb({
        category: "result-export",
        level: "info",
        message: "Exporting query result",
        data: {
          format: fmt,
          sql: activeResult.sourceSql,
          rows: table.numRows,
          columns: table.schema?.fields?.length ?? 0,
        },
      });
    }
    await exportResult(table, fmt, activeDoc?.name ?? "query-result");
  }, [activeResult.table, activeResult.sourceSql, activeDoc?.name, settings.aiTelemetry]);

  const [pivotBusy, setPivotBusy] = useState<PerspectivePivotMode | null>(null);
  const [pivotError, setPivotError] = useState<string | null>(null);
  // A new result (or another tab's) makes the last pivot error stale.
  useEffect(() => { setPivotError(null); }, [activeResult.table]);

  // Open a query in Perspective as a live view or temp table. Shared by the
  // results pane's Pivot (the SQL behind the result on screen) and the
  // toolbar's Run in Perspective (SQL that has not run here at all).
  const pivotSql = useCallback(async (sql: string, mode: QueryPivotMode) => {
    setPivotError(null);
    setPivotBusy(mode);
    try {
      await waitForEngineReady();
      // The Perspective host is a lazily loaded chunk; a click right after
      // page load can beat it to registering this bridge.
      let show = ui.showPerspectiveQuery;
      for (let waited = 0; !show && waited < 5_000; waited += 100) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        show = ui.showPerspectiveQuery;
      }
      if (!show) throw new Error("Perspective is still loading. Try again in a moment.");
      const result = await show(sql, mode);
      if (!result.ok) setPivotError(result.error);
    } catch (e) {
      setPivotError(e instanceof Error ? e.message : String(e));
    } finally {
      setPivotBusy(null);
    }
  }, []);

  const handleRunInPerspective = useCallback((mode: QueryPivotMode) => {
    const sql = sqlToRun();
    if (sql?.trim()) void pivotSql(sql, mode);
  }, [pivotSql, sqlToRun]);

  const handleOpenInPerspective = useCallback(async (mode: PerspectivePivotMode) => {
    const table = activeResult.table;
    if (!table) return;
    setPivotError(null);
    if (mode === "snapshot") {
      if (!ui.showPerspective) return;
      // showPerspective wants an Arrow IPC ArrayBuffer; slice to detach a clean
      // buffer (the Uint8Array view may be a subarray of a larger allocation).
      const ipc = tableToIPC(table, "file");
      const ab = ipc.buffer.slice(ipc.byteOffset, ipc.byteOffset + ipc.byteLength) as ArrayBuffer;
      ui.showPerspective(ab, { sql: activeResult.sourceSql, source: "editor" });
      return;
    }
    if (activeResult.sourceSql) await pivotSql(activeResult.sourceSql, mode);
  }, [activeResult.table, activeResult.sourceSql, pivotSql]);

  // Copy a share link for the active tab. The link carries the connection
  // context (service + ATTACH options) so the recipient lands on the same
  // catalog; the SQL opens staged but unexecuted.
  const handleShareLink = useCallback(async () => {
    const sql = editorRef.current?.getDoc() ?? activeDoc?.sql ?? "";
    if (!sql.trim()) return;
    // Always name the service, even when it's the origin fallback (a flat
    // self-hosted deploy where Cupola and the VGI server share an origin).
    // A share link without `?service=` lands the recipient on the welcome
    // page, where no editor ever mounts to receive the SQL.
    const url = await buildShareQueryUrl({ sql, serviceUrl, attachOptions });
    try {
      await navigator.clipboard.writeText(url);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2000);
    } catch (err) {
      Sentry.captureException(err, { tags: { feature: "share-query-link" } });
    }
  }, [activeDoc?.sql, serviceUrl, attachOptions]);

  const handleDownloadSql = useCallback(() => {
    const sql = editorRef.current?.getDoc() ?? activeDoc?.sql ?? "";
    triggerDownload(new Blob([sql], { type: "text/plain;charset=utf-8" }), `${safeFileStem(activeDoc?.name ?? "query")}.sql`);
  }, [activeDoc?.name, activeDoc?.sql]);

  const handleAddToReport = useCallback(() => {
    const ed = editorRef.current;
    const sql = ed?.getSelectionText().trim() || ed?.getStatementAtCursor()?.text || ed?.getDoc() || activeDoc?.sql || "";
    if (!sql.trim()) return;
    promoteToReport({ sql, title: activeDoc?.name || "Query" });
  }, [activeDoc?.name, activeDoc?.sql]);

  // Pop the current result out into a snapshot window. Must run synchronously in
  // the click gesture (openPopout does the window.open) or the popup is blocked.
  // Returns false when blocked so the results pane can fall back to Maximize.
  const handlePopout = useCallback((): boolean => {
    const table = activeResult.table;
    if (!table) return false;
    const sql = editorRef.current?.getDoc() ?? activeDoc?.sql ?? "";
    return openPopout({ table, sql, capturedAt: new Date() });
  }, [activeResult.table, activeDoc?.sql]);

  // Keep any open pop-out window aware of the editor's current result so it can
  // offer "Sync". Not tied to unmount — the window persists across tab switches.
  useEffect(() => {
    updateLatest(activeResult.table ? { table: activeResult.table, sql: activeDoc?.sql ?? "" } : null);
  }, [activeResult.table, activeDoc?.sql]);

  // ---- Ask AI: live query getter + apply-back actions ---------------------
  // Read the LIVE buffer at call time (CodeMirror edits don't re-render us, so
  // a render-time snapshot would be stale).
  const getCurrentSql = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return activeDoc?.sql ?? "";
    return ed.getSelectionText().trim() || ed.getStatementAtCursor()?.text || ed.getDoc();
  }, [activeDoc?.sql]);

  const applyReplaceStatement = useCallback((sql: string) => {
    const ed = editorRef.current;
    if (!ed) return;
    const stmt = ed.getStatementAtCursor();
    if (stmt) {
      ed.selectRange(stmt.from, stmt.to); // insertAtCursor replaces the selection
    }
    ed.insertAtCursor(sql);
  }, []);

  const applyReplaceDocument = useCallback((sql: string) => {
    editorRef.current?.setDoc(sql);
  }, []);

  const applyInsertAtCursor = useCallback((sql: string) => {
    editorRef.current?.insertAtCursor(sql);
  }, []);

  // A function or macro call, as a snippet: Tab walks its arguments.
  const insertCallable = useCallback((callable: Callable) => {
    const ed = editorRef.current;
    if (!ed) return;
    ed.insertSnippet(buildCallSnippet(callable, { emptyDoc: ed.getDoc().trim() === "" }));
  }, []);

  const getCatalogIndex = useCallback(
    () => buildCatalogIndex(catalogInventory.getSnapshot().catalogs, builtinFunctions()),
    [],
  );
  // Read DuckDB's built-ins as soon as the engine can, so help is ready on the
  // first keystroke rather than the second.
  useEffect(() => { if (queryReady) void loadBuiltinFunctions(); }, [queryReady]);
  // A `fn(` typed before they arrived gets its help now, not on the next key.
  useEffect(() => onBuiltinFunctionsLoaded(() => editorRef.current?.refreshCatalogHelp()), []);

  // Smart insert (matches the shell): a bare table reference dropped/clicked
  // into an empty editor expands to a SELECT (geometry excluded); otherwise the
  // raw text is inserted at the cursor. A column/expression inserts verbatim.
  const smartInsert = useCallback((text: string) => {
    const ed = editorRef.current;
    if (!ed) return;
    if (isTableRef(text) && ed.getDoc().trim() === "") {
      ed.insertAtCursor(buildTableSelect(text, catalogInventory.getSnapshot().catalogs));
    } else {
      ed.insertAtCursor(text);
    }
  }, [catalogData]);

  // Drop of a sidebar tree id onto the editor — decode to a name, then insert.
  const handleDropText = useCallback((raw: string) => {
    const [callable] = /::[fm]:/.test(raw) ? callablesForSelection(catalogInventory.getSnapshot().catalogs, parseSelection(raw)) : [];
    if (callable) { insertCallable(callable); return; }
    const text = treeIdToShellText(raw) ?? (raw.includes("::") ? null : raw);
    if (text) smartInsert(text);
  }, [smartInsert, insertCallable]);

  // Apply-back actions handed to the AI panel (it lives inside this component,
  // so it calls our editor handlers directly).
  const aiApply = useMemo<SqlApplyActions>(() => ({
    replaceStatement: (sql) => replacingBuffer("ai", () => applyReplaceStatement(sql)),
    replaceDocument: (sql) => replacingBuffer("ai", () => applyReplaceDocument(sql)),
    insertAtCursor: (sql) => replacingBuffer("ai", () => applyInsertAtCursor(sql)),
    openInNewTab: (sql: string) => ui.openInEditor?.(sql),
  }), [applyReplaceStatement, applyReplaceDocument, applyInsertAtCursor, replacingBuffer]);

  // Vertical split resize between the editor and results panes. Clamp so each
  // keeps at least ~120px; persist the fraction on release.
  const onSplitResizeStart = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const col = splitColRef.current;
    if (!col) return;
    const rect = col.getBoundingClientRect();
    e.currentTarget.setPointerCapture(e.pointerId);
    const onMove = (ev: globalThis.PointerEvent) => {
      const frac = (ev.clientY - rect.top) / rect.height;
      const minFrac = 120 / rect.height;
      setEditorFrac(Math.min(Math.min(SPLIT_MAX, 1 - minFrac), Math.max(Math.max(SPLIT_MIN, minFrac), frac)));
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      setEditorFrac((f) => { try { localStorage.setItem("vgi-editor-split", String(f)); } catch {} return f; });
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }, []);

  // ---- sidebar click-to-insert --------------------------------------------
  useEffect(() => {
    ui.insertIntoEditor = smartInsert;
    return () => { if (ui.insertIntoEditor === smartInsert) ui.insertIntoEditor = null; };
  }, [smartInsert]);
  useEffect(() => {
    ui.insertCallableIntoEditor = insertCallable;
    return () => { if (ui.insertCallableIntoEditor === insertCallable) ui.insertCallableIntoEditor = null; };
  }, [insertCallable]);

  // SQL from outside this tab's text always lands in a new tab, which becomes active.
  const openInNewTab = useCallback((sql: string, autoRun: boolean) => {
    setDocState((prev) => {
      const next = addDoc(prev, sql);
      saveEditorState(next, serviceUrl);
      const newId = next.activeId!;
      // Run once the editor remounts with the new active doc.
      if (autoRun) setTimeout(() => runSql(sql, newId), 60);
      return next;
    });
  }, [runSql, serviceUrl]);

  // ---- externally-pushed SQL (example queries, AI panels, share links) -----
  useEffect(() => {
    if (!pendingSql) return;
    openInNewTab(pendingSql.sql, pendingSql.autoRun);
    onPendingConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSql]);

  const completionSource = useMemo(
    () => (settings.editorAutocomplete === false ? null : sqlAutoCompleteSource),
    [settings.editorAutocomplete],
  );

  return (
    <div className="flex flex-col h-full min-h-0 bg-background" data-testid="sql-editor-view">
      <ConfirmCloseQueryDialog
        pending={pendingClose}
        onCancel={() => setPendingClose(null)}
        onConfirm={(id) => { setPendingClose(null); closeTab(id); }}
      />
      <SqlEditorTabs
        docs={docState.docs}
        activeId={activeId}
        busyDocIds={aiBusyDocs}
        onSelect={handleSelectTab}
        onAdd={() => handleAddTab("")}
        onClose={handleCloseTab}
        onRename={handleRename}
      />
      <EditorToolbar
        running={activeResult.running}
        queryReady={queryReady}
        runBlocked={!!backgroundRun}
        hasSelection={hasSelection}
        onRun={handleRun}
        onRunAll={handleRunAll}
        onExplain={handleExplain}
        onRunInPerspective={handleRunInPerspective}
        perspectiveBusy={pivotBusy}
        onStop={handleStop}
        onFormat={handleFormat}
        onAskAI={() => dock.toggle("ai")}
        onInspector={() => dock.toggle("inspector")}
        inspectorActive={dock.open && dock.tab === "inspector"}
        onHistory={() => dock.toggle("history")}
        historyActive={dock.open && dock.tab === "history"}
        onShowShortcuts={() => setShortcutsOpen(true)}
        onAddToReport={handleAddToReport}
        aiActive={aiOpen}
        aiBusy={aiBusyDocs.size > 0}
        onDownloadSql={handleDownloadSql}
        onShareLink={handleShareLink}
        shareCopied={shareCopied}
      />
      <KeyboardShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      {backgroundRun && (
        <div role="status" className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-2 text-xs" data-testid="editor-background-run">
          <span>“{backgroundRun.name}” is running. Wait for it to finish or return to that tab to stop it.</span>
          <button type="button" className="shrink-0 underline" onClick={() => handleSelectTab(backgroundRun.id)}>Show running query</button>
        </div>
      )}
      {/* Horizontal split: editor+results on the left, Ask AI panel on the
          right. The panel stays mounted (display:none when closed) so its
          per-tab conversations survive open/close toggles. */}
      <div className="flex flex-col md:flex-row flex-1 min-h-0">
        <div ref={splitColRef} className={`flex flex-col flex-1 min-w-0 ${dock.open && isNarrow ? "min-h-0 basis-[55%]" : ""}`}>
          <div className="min-h-[120px] overflow-hidden" style={{ height: `${editorFrac * 100}%` }}>
            <CodeMirrorSql
              key={activeDoc?.id ?? "none"}
              ref={editorRef}
              initialDoc={activeDoc?.sql ?? ""}
              session={activeSession}
              onChange={handleDocChange}
              onRunStatement={handleRun}
              onSelectionChange={setHasSelection}
              onDropText={handleDropText}
              completionSource={completionSource}
              fontSize={settings.editorFontSize ?? 13}
              getCatalogIndex={getCatalogIndex}
            />
          </div>
          <div
            onPointerDown={onSplitResizeStart}
            className="h-1.5 shrink-0 cursor-row-resize bg-border hover:bg-accent/60 active:bg-accent transition-colors"
          />
          <div className="flex-1 min-h-0">
            <EditorResultsPane
              state={activeResult}
              onPopout={handlePopout}
              onExport={handleExport}
              onOpenInPerspective={handleOpenInPerspective}
              pivotBusy={pivotBusy}
              pivotError={pivotError}
            />
          </div>
        </div>
        <RightDock
          state={dock}
          isNarrow={isNarrow}
          aiBusy={aiBusyDocs.size > 0}
          inspector={
            <Inspector
              target={inspectorTarget}
              pinned={!!pinned}
              onTogglePin={() => setPinned((p) => (p ? null : inspectorTarget))}
              onOpenFullPage={(sel) => onOpenFullPage?.(sel)}
              onInsertText={applyInsertAtCursor}
              onInsertCallable={insertCallable}
              onInsertRelation={smartInsert}
            />
          }
          history={
            <HistoryPanel
              serviceUrl={serviceUrl}
              activeDocId={activeDoc?.id ?? null}
              onOpen={openInNewTab}
              onRestore={(sql) => { replacingBuffer("restore", () => applyReplaceDocument(sql)); editorRef.current?.focus(); }}
            />
          }
          ai={
            <EditorAiPanel
              docId={activeDoc?.id ?? "none"}
              catalogData={catalogData}
              attachedCatalogs={attachedCatalogs}
              serviceUrl={serviceUrl}
              getCurrentSql={getCurrentSql}
              apply={aiApply}
              runIdRef={runIdRef}
              setActiveResult={setActiveResult}
              onBusyChange={handleAiBusyChange}
            />
          }
        />
      </div>
    </div>
  );
}
