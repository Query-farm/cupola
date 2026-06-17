/**
 * DBeaver-style SQL editor surface: a tab strip of named query documents, a
 * CodeMirror editor with a run toolbar, and a results grid below. Coexists
 * with the xterm shell (shared DuckDB session via the bridge) and the catalog
 * sidebar (rendered by CatalogApp alongside this view).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { format as formatSql } from "sql-formatter";
import { tableFromIPC, tableToIPC } from "apache-arrow";
import { bridge, recordQuery } from "@/lib/shell-bridge";
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
import { exportResult, type ExportFormat } from "@/lib/editor/result-export";
import { CodeMirrorSql, type CodeMirrorSqlHandle } from "./CodeMirrorSql";
import { SqlEditorTabs } from "./SqlEditorTabs";
import { EditorToolbar } from "./EditorToolbar";
import { EditorResultsPane, emptyResult, type ResultState } from "./EditorResultsPane";
import { AskAiSqlDialog } from "./AskAiSqlDialog";

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
  const [docState, setDocState] = useState<EditorDocState>(() => loadEditorState());
  const [results, setResults] = useState<Record<string, ResultState>>({});
  const [hasSelection, setHasSelection] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  // bridge.query availability — re-checked after the shell finishes booting.
  const [queryReady, setQueryReady] = useState<boolean>(() => !!bridge.query);

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

  const persist = useCallback((next: EditorDocState) => {
    setDocState(next);
    saveEditorState(next);
  }, []);

  // Flush any pending debounced save when the page is hidden/closed or the
  // editor unmounts (e.g. switching back to the catalog view).
  useEffect(() => {
    const flush = () => {
      if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
      saveEditorState(docStateRef.current);
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flush);
      flush();
    };
  }, []);

  // ---- document model -----------------------------------------------------
  const handleDocChange = useCallback((sql: string) => {
    if (!activeId) return;
    setDocState((prev) => {
      const next = updateDocSql(prev, activeId, sql);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => saveEditorState(next), 400);
      return next;
    });
  }, [activeId]);

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

  const handleOpenInShell = useCallback(() => {
    const sql = editorRef.current?.getDoc() ?? activeDoc?.sql ?? "";
    bridge.activateShell?.();
    if (sql.trim()) {
      // activateShell switches surfaces; give the terminal a tick to focus.
      setTimeout(() => bridge.runQuery?.(sql.trim()), 50);
    }
    onExitEditor?.();
  }, [activeDoc?.sql, onExitEditor]);

  // ---- sidebar click-to-insert --------------------------------------------
  useEffect(() => {
    const fn = (text: string) => editorRef.current?.insertAtCursor(text);
    bridge.insertIntoEditor = fn;
    return () => { if (bridge.insertIntoEditor === fn) bridge.insertIntoEditor = null; };
  }, []);

  // ---- externally-pushed SQL (example queries, shell history) -------------
  useEffect(() => {
    if (!pendingSql) return;
    setDocState((prev) => {
      const next = addDoc(prev, pendingSql);
      saveEditorState(next);
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
        hasResult={!!activeResult.table}
        hasSelection={hasSelection}
        onRun={handleRun}
        onStop={handleStop}
        onFormat={handleFormat}
        onExport={handleExport}
        onOpenInPerspective={handleOpenInPerspective}
        onOpenInShell={handleOpenInShell}
        onAskAI={() => setAiOpen(true)}
      />
      {/* Editor (top) + results (bottom). Fixed 45/55 split for v1. */}
      <div className="flex flex-col flex-1 min-h-0">
        <div className="h-[42%] min-h-[120px] border-b border-border overflow-hidden">
          <CodeMirrorSql
            key={activeDoc?.id ?? "none"}
            ref={editorRef}
            initialDoc={activeDoc?.sql ?? ""}
            onChange={handleDocChange}
            onRunStatement={handleRunStatementAtCursor}
            onSelectionChange={setHasSelection}
            completionSource={completionSource}
            fontSize={settings.editorFontSize ?? 13}
          />
        </div>
        <div className="flex-1 min-h-0">
          <EditorResultsPane state={activeResult} />
        </div>
      </div>

      <AskAiSqlDialog
        open={aiOpen}
        onOpenChange={setAiOpen}
        catalogData={catalogData}
        serviceUrl={serviceUrl}
        currentSql={(editorRef.current?.getSelectionText()?.trim() || editorRef.current?.getStatementAtCursor()?.text || activeDoc?.sql) ?? ""}
        onInsert={(sql) => editorRef.current?.insertAtCursor(sql)}
      />
    </div>
  );
}
