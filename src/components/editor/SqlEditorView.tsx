/**
 * DBeaver-style SQL editor surface: a tab strip of named query documents, a
 * CodeMirror editor with a run toolbar, and a results grid below. Coexists
 * with the xterm shell (shared DuckDB session via the bridge) and the catalog
 * sidebar (rendered by CatalogApp alongside this view).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { format as formatSql } from "sql-formatter";
import { tableFromIPC, tableToIPC } from "apache-arrow";
import { bridge, recordQuery, onBootChange } from "@/lib/shell-bridge";
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
import { treeIdToShellText } from "@/lib/tree";
import { exportResult, triggerDownload, safeFileStem, type ExportFormat } from "@/lib/editor/result-export";
import { CodeMirrorSql, type CodeMirrorSqlHandle } from "./CodeMirrorSql";
import { SqlEditorTabs } from "./SqlEditorTabs";
import { EditorToolbar } from "./EditorToolbar";
import { EditorResultsPane, emptyResult, type ResultState } from "./EditorResultsPane";
import { EditorAiPanel } from "./EditorAiPanel";
import type { SqlApplyActions } from "./EditorSqlToolCallBlock";

interface Props {
  catalogData: CatalogData;
  serviceUrl: string;
  /** Switch back to the catalog browser (used after "Open in shell"). */
  onExitEditor?: () => void;
  /** SQL pushed in from elsewhere (example queries, shell history). Opens a
   *  new tab and runs it; call onPendingConsumed once handled. */
  pendingSql?: string | null;
  onPendingConsumed?: () => void;
}

export function SqlEditorView({ catalogData, serviceUrl, onExitEditor, pendingSql, onPendingConsumed }: Props) {
  const { settings } = useSettings();
  const [docState, setDocState] = useState<EditorDocState>(() => loadEditorState(serviceUrl));
  const [results, setResults] = useState<Record<string, ResultState>>({});
  const [hasSelection, setHasSelection] = useState(false);
  // Docked Ask AI panel (right side) — persisted open state + width.
  const AI_MIN = 320, AI_MAX = 720, AI_DEFAULT = 400;
  const [aiOpen, setAiOpen] = useState<boolean>(() => {
    try { return localStorage.getItem("vgi-editor-ai-open") === "1"; } catch { return false; }
  });
  const [aiWidth, setAiWidth] = useState<number>(() => {
    try { const n = parseInt(localStorage.getItem("vgi-editor-ai-width") || "", 10); if (n >= 320 && n <= 720) return n; } catch {}
    return 400;
  });
  useEffect(() => { try { localStorage.setItem("vgi-editor-ai-open", aiOpen ? "1" : "0"); } catch {} }, [aiOpen]);
  // Vertical editor/results split (fraction of the left column the editor pane
  // gets). Persisted; clamped so neither pane collapses.
  const SPLIT_MIN = 0.2, SPLIT_MAX = 0.8;
  const [editorFrac, setEditorFrac] = useState<number>(() => {
    try { const n = parseFloat(localStorage.getItem("vgi-editor-split") || ""); if (n >= SPLIT_MIN && n <= SPLIT_MAX) return n; } catch {}
    return 0.42;
  });
  const splitColRef = useRef<HTMLDivElement>(null);
  // bridge.query availability — re-checked after the shell finishes booting.
  const [queryReady, setQueryReady] = useState<boolean>(() => !!bridge.query);
  // Live engine boot phase (e.g. "Downloading DuckDB") shown in the toolbar
  // while the WASM engine initializes — the user can't see the shell boot
  // screen when the editor is the active surface.
  const [bootPhase, setBootPhase] = useState<string | null>(() => bridge.bootPhase);

  const editorRef = useRef<CodeMirrorSqlHandle | null>(null);
  const runIdRef = useRef(0);
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

  // Poll briefly for bridge.query becoming available (shell boots async).
  useEffect(() => {
    if (queryReady) return;
    const t = setInterval(() => {
      if (bridge.query) { setQueryReady(true); clearInterval(t); }
    }, 400);
    return () => clearInterval(t);
  }, [queryReady]);

  // Track the live boot phase while the engine initializes.
  useEffect(() => {
    if (queryReady) return;
    setBootPhase(bridge.bootPhase);
    return onBootChange(() => setBootPhase(bridge.bootPhase));
  }, [queryReady]);

  const persist = useCallback((next: EditorDocState) => {
    setDocState(next);
    saveEditorState(next, serviceUrl);
  }, [serviceUrl]);

  // Flush any pending debounced save when the page is hidden/closed or the
  // editor unmounts (e.g. switching back to the catalog view).
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

  const handleCloseTab = useCallback((id: string) => {
    persist(removeDoc(docState, id));
    setResults((prev) => { const { [id]: _drop, ...rest } = prev; return rest; });
  }, [docState, persist]);

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
    if (!trimmed) return;
    const myRun = ++runIdRef.current;
    setActiveResult(docId, { running: true, ran: true, error: null });

    if (bridge.attached) await bridge.attached;
    const q = bridge.query;
    if (!q) {
      setActiveResult(docId, { running: false, error: "DuckDB is still starting up. Try again in a moment." });
      return;
    }

    const t0 = performance.now();
    let res;
    try {
      res = await q(trimmed);
    } catch (e) {
      if (myRun !== runIdRef.current) return;
      setActiveResult(docId, { running: false, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    if (myRun !== runIdRef.current) return;
    const elapsedMs = Math.round(performance.now() - t0);

    if (!res.ok) {
      setActiveResult(docId, { running: false, error: res.error || "Query failed", ok: false, table: null });
      recordQuery({ sql: trimmed, executionTimeMs: elapsedMs, success: false, error: res.error });
      maybeSelectError(res.error);
      return;
    }

    const buf = res.arrowBuffers?.[0];
    const isEmpty = !buf || (buf instanceof ArrayBuffer ? buf.byteLength === 0 : (buf as Uint8Array).length === 0);
    if (isEmpty) {
      setActiveResult(docId, { running: false, error: null, ok: true, table: null, rowCount: 0, elapsedMs });
      recordQuery({ sql: trimmed, executionTimeMs: elapsedMs, success: true });
      return;
    }
    const table = tableFromIPC(buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf);
    // DDL/INSERT etc. come back as a single "Count" column.
    const fields = table.schema.fields;
    const isCount = fields.length === 1 && fields[0].name === "Count" && table.numRows <= 1;
    if (isCount) {
      setActiveResult(docId, { running: false, error: null, ok: true, table: null, rowCount: 0, elapsedMs });
      recordQuery({ sql: trimmed, executionTimeMs: elapsedMs, success: true });
      // A DDL statement likely changed the schema — refresh sidebar catalogs.
      bridge.refreshMemoryTables?.();
      bridge.onAttachedCatalogsChanged?.();
      return;
    }
    setActiveResult(docId, {
      running: false, error: null, ok: true, table, rowCount: table.numRows, elapsedMs,
    });
    recordQuery({ sql: trimmed, executionTimeMs: elapsedMs, success: true, rowCount: table.numRows });
  }, [setActiveResult]);

  /** Best-effort: if a DuckDB error names a character offset, select it. */
  const maybeSelectError = useCallback((errMsg?: string) => {
    if (!errMsg || !editorRef.current) return;
    const m = /(?:at|near) (?:character|position) (\d+)/i.exec(errMsg) ?? /LINE \d+:\s/.exec(errMsg);
    if (m && m[1]) {
      const pos = Number(m[1]);
      if (Number.isFinite(pos)) editorRef.current.selectRange(pos, pos + 1);
    }
  }, []);

  const handleRun = useCallback(() => {
    if (!editorRef.current || !activeId) return;
    const selection = editorRef.current.getSelectionText();
    if (selection.trim()) {
      runSql(selection, activeId);
      return;
    }
    const stmt = editorRef.current.getStatementAtCursor();
    if (stmt) runSql(stmt.text, activeId);
  }, [activeId, runSql]);

  const handleRunStatementAtCursor = useCallback(() => {
    if (!editorRef.current || !activeId) return;
    const stmt = editorRef.current.getStatementAtCursor();
    if (stmt) runSql(stmt.text, activeId);
  }, [activeId, runSql]);

  const handleStop = useCallback(() => {
    bridge.cancelQuery?.();
  }, []);

  // ---- toolbar actions ----------------------------------------------------
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
        if (doc.trim()) ed.setDoc(formatSql(doc, { language: "duckdb", keywordCase: "upper", tabWidth: 2 }));
      }
    } catch {
      // sql-formatter throws on unparseable input — leave the text untouched.
    }
  }, []);

  const handleExport = useCallback(async (fmt: ExportFormat) => {
    const table = activeResult.table;
    if (!table) return;
    await exportResult(table, fmt, activeDoc?.name ?? "query-result");
  }, [activeResult.table, activeDoc?.name]);

  const handleOpenInPerspective = useCallback(() => {
    const table = activeResult.table;
    if (!table || !bridge.showPerspective) return;
    // showPerspective wants an Arrow IPC ArrayBuffer; slice to detach a clean
    // buffer (the Uint8Array view may be a subarray of a larger allocation).
    const ipc = tableToIPC(table, "file");
    const ab = ipc.buffer.slice(ipc.byteOffset, ipc.byteOffset + ipc.byteLength) as ArrayBuffer;
    bridge.showPerspective(ab);
  }, [activeResult.table]);

  const handleDownloadSql = useCallback(() => {
    const sql = editorRef.current?.getDoc() ?? activeDoc?.sql ?? "";
    triggerDownload(new Blob([sql], { type: "text/plain;charset=utf-8" }), `${safeFileStem(activeDoc?.name ?? "query")}.sql`);
  }, [activeDoc?.name, activeDoc?.sql]);

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

  const handleOpenInShell = useCallback(() => {
    const sql = editorRef.current?.getDoc() ?? activeDoc?.sql ?? "";
    bridge.activateShell?.();
    if (sql.trim()) {
      // activateShell switches surfaces; give the terminal a tick to focus.
      setTimeout(() => bridge.runQuery?.(sql.trim()), 50);
    }
    onExitEditor?.();
  }, [activeDoc?.sql, onExitEditor]);

  // Smart insert (matches the shell): a bare table reference dropped/clicked
  // into an empty editor expands to a SELECT (geometry excluded); otherwise the
  // raw text is inserted at the cursor. A column/expression inserts verbatim.
  const smartInsert = useCallback((text: string) => {
    const ed = editorRef.current;
    if (!ed) return;
    if (isTableRef(text) && ed.getDoc().trim() === "") {
      ed.insertAtCursor(buildTableSelect(text, [catalogData, bridge.memoryCatalog]));
    } else {
      ed.insertAtCursor(text);
    }
  }, [catalogData]);

  // Drop of a sidebar tree id onto the editor — decode to a name, then insert.
  const handleDropText = useCallback((raw: string) => {
    const text = treeIdToShellText(raw) ?? (raw.includes("::") ? null : raw);
    if (text) smartInsert(text);
  }, [smartInsert]);

  // Apply-back actions handed to the AI panel (it lives inside this component,
  // so it calls our editor handlers directly).
  const aiApply = useMemo<SqlApplyActions>(() => ({
    replaceStatement: applyReplaceStatement,
    replaceDocument: applyReplaceDocument,
    insertAtCursor: applyInsertAtCursor,
    openInNewTab: (sql: string) => bridge.openInEditor?.(sql),
  }), [applyReplaceStatement, applyReplaceDocument, applyInsertAtCursor]);

  // Right-panel resize (inverted delta vs a left sidebar). Persist on release.
  const onAiResizeStart = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = aiWidth;
    e.currentTarget.setPointerCapture(e.pointerId);
    const onMove = (ev: globalThis.PointerEvent) => {
      setAiWidth(Math.min(AI_MAX, Math.max(AI_MIN, startW - (ev.clientX - startX))));
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      setAiWidth((w) => { try { localStorage.setItem("vgi-editor-ai-width", String(w)); } catch {} return w; });
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }, [aiWidth]);

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
    bridge.insertIntoEditor = smartInsert;
    return () => { if (bridge.insertIntoEditor === smartInsert) bridge.insertIntoEditor = null; };
  }, [smartInsert]);

  // ---- externally-pushed SQL (example queries, shell history) -------------
  useEffect(() => {
    if (!pendingSql) return;
    setDocState((prev) => {
      const next = addDoc(prev, pendingSql);
      saveEditorState(next, serviceUrl);
      const newId = next.activeId!;
      // Run once the editor remounts with the new active doc.
      setTimeout(() => runSql(pendingSql, newId), 60);
      return next;
    });
    onPendingConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSql]);

  const completionSource = useMemo(
    () => (settings.editorAutocomplete === false ? null : sqlAutoCompleteSource),
    [settings.editorAutocomplete],
  );

  return (
    <div className="flex flex-col h-full min-h-0 bg-background" data-testid="sql-editor-view">
      <SqlEditorTabs
        docs={docState.docs}
        activeId={activeId}
        onSelect={handleSelectTab}
        onAdd={() => handleAddTab("")}
        onClose={handleCloseTab}
        onRename={handleRename}
      />
      <EditorToolbar
        running={activeResult.running}
        queryReady={queryReady}
        bootPhase={bootPhase}
        hasResult={!!activeResult.table}
        hasSelection={hasSelection}
        onRun={handleRun}
        onStop={handleStop}
        onFormat={handleFormat}
        onExport={handleExport}
        onOpenInPerspective={handleOpenInPerspective}
        onOpenInShell={handleOpenInShell}
        onAskAI={() => setAiOpen((o) => !o)}
        aiActive={aiOpen}
        onDownloadSql={handleDownloadSql}
      />
      {/* Horizontal split: editor+results on the left, Ask AI panel on the
          right. The panel stays mounted (display:none when closed) so its
          per-tab conversations survive open/close toggles. */}
      <div className="flex flex-1 min-h-0">
        <div ref={splitColRef} className="flex flex-col flex-1 min-w-0">
          <div className="min-h-[120px] overflow-hidden" style={{ height: `${editorFrac * 100}%` }}>
            <CodeMirrorSql
              key={activeDoc?.id ?? "none"}
              ref={editorRef}
              initialDoc={activeDoc?.sql ?? ""}
              onChange={handleDocChange}
              onRunStatement={handleRunStatementAtCursor}
              onSelectionChange={setHasSelection}
              onDropText={handleDropText}
              completionSource={completionSource}
              fontSize={settings.editorFontSize ?? 13}
            />
          </div>
          <div
            onPointerDown={onSplitResizeStart}
            className="h-1.5 shrink-0 cursor-row-resize bg-border hover:bg-accent/60 active:bg-accent transition-colors"
          />
          <div className="flex-1 min-h-0">
            <EditorResultsPane state={activeResult} />
          </div>
        </div>
        {aiOpen && (
          <div
            onPointerDown={onAiResizeStart}
            className="w-1.5 shrink-0 cursor-col-resize bg-border hover:bg-accent/60 active:bg-accent transition-colors"
          />
        )}
        <div
          className="shrink-0 overflow-hidden"
          style={aiOpen ? { width: aiWidth } : { width: 0, display: "none" }}
        >
          <EditorAiPanel
            docId={activeDoc?.id ?? "none"}
            catalogData={catalogData}
            serviceUrl={serviceUrl}
            getCurrentSql={getCurrentSql}
            apply={aiApply}
            runIdRef={runIdRef}
            setActiveResult={setActiveResult}
            onClose={() => setAiOpen(false)}
          />
        </div>
      </div>
    </div>
  );
}
