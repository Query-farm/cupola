/**
 * DuckDB-WASM Shell React component.
 * Loads xterm.js + addons from CDN to avoid SSR/bundling issues.
 * Shell logic adapted from public/shell/index.html.
 */
import { useEffect, useRef, useState, useCallback, lazy, Suspense } from "react";
import { Maximize2, Minimize2, ChevronDown, ChevronUp, BarChart3, Map as MapIcon, History, Table2, Sparkles } from "lucide-react";
const AskAIChat = lazy(() => import("./AskAIChat").then(m => ({ default: m.AskAIChat })));
import { DataPreview } from "./content/DataPreview";
import { getColumns } from "@/lib/service";
import { VgiDuckDBHandler } from "@/lib/perspective-duckdb-handler";
import { getAuthToken, getOAuthMeta, redirectToAuth } from "@/lib/auth";
import { useSettings } from "@/lib/settings";
import {
  runAgentTurn,
  buildSystemPrompt,
  executeListTables,
  executeDescribeTable,
  executeReadQueryResults,
  formatArrowTableAsJson,
  type MessageParam,
} from "@/lib/ai-agent";
import { createMarkdownRenderer } from "@/lib/markdown-ansi";
import { estimateCost, formatCost } from "@/lib/pricing";
import { formatCellValue, safeGetArrowValue } from "@/lib/format";
import { printBoxTable, printLineTable, type TerminalOutput } from "@/lib/shell-table-renderer";
import { handleDotCommand, type ShellState, type ShellIO } from "@/lib/shell-commands";
import { bridge } from "@/lib/shell-bridge";
import { getTerminalTheme } from "@/lib/theme";
import {
  saveSession, saveAutoSave, loadSession, getAutoSave,
  listSessions, deleteSession, decompressMemory,
  AUTOSAVE_NAME, type SavedSession,
} from "@/lib/session-store";

const KeplerMap = lazy(() => import("./KeplerMap").then((m) => ({ default: m.KeplerMap })));

import type { CatalogData } from "@/lib/service";

export interface QueryHistoryEntry {
  id: number;
  timestamp: number;
  sql: string;
  executionTimeMs: number;
  success: boolean;
  error?: string;
  rowCount?: number;
  userQuestion?: string;
  /** Groups queries from the same AI conversation session. */
  conversationId?: string;
  /** Display name for the AI conversation. */
  conversationName?: string;
}

export type ShellMode = "minimized" | "panel" | "maximized" | "fullscreen";

interface Props {
  serviceUrl: string;
  catalogName: string;
  mode: ShellMode;
  onModeChange: (mode: ShellMode) => void;
  /** Called when the shell is ready, with a function to insert text into the terminal. */
  onShellReady?: (insertText: (text: string) => void) => void;
  /** Catalog metadata for AI agent tools. */
  catalogData?: CatalogData;
  /** Current selection — used for Data Preview tab when a table is selected. */
  selection?: import("@/lib/tree").Selection | null;
}

// CDN script URLs (matching public/shell/index.html versions)
const CDN_SCRIPTS = [
  "https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js",
  "https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js",
  "https://cdn.jsdelivr.net/npm/xterm-addon-web-links@0.9.0/lib/xterm-addon-web-links.min.js",
  "https://cdn.jsdelivr.net/npm/xterm-addon-webgl@0.16.0/lib/xterm-addon-webgl.min.js",
];
const CDN_CSS = "https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.min.css";

// Module imports loaded dynamically
const ARROW_CDN = "https://cdn.jsdelivr.net/npm/apache-arrow@18.1.0/+esm";
const READLINE_CDN = "https://cdn.jsdelivr.net/npm/xterm-readline@1.1.2/+esm";

let scriptsLoaded = false;
let scriptsLoading: Promise<void> | null = null;

/** Load CDN scripts once (idempotent). */
function loadScripts(): Promise<void> {
  if (scriptsLoaded) return Promise.resolve();
  if (scriptsLoading) return scriptsLoading;

  scriptsLoading = (async () => {
    // CSS
    if (!document.querySelector(`link[href="${CDN_CSS}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = CDN_CSS;
      document.head.appendChild(link);
    }

    // Scripts (sequential — each depends on previous)
    for (const src of CDN_SCRIPTS) {
      if (document.querySelector(`script[src="${src}"]`)) continue;
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        script.src = src;
        script.crossOrigin = "anonymous";
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Failed to load ${src}`));
        document.head.appendChild(script);
      });
    }
    scriptsLoaded = true;
  })();

  return scriptsLoading;
}

export function DuckDBShell({ serviceUrl, catalogName, mode, onModeChange, onShellReady, catalogData, selection }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const perspectiveRef = useRef<HTMLDivElement>(null);
  const { settings } = useSettings();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const [activeTab, setActiveTab] = useState<"shell" | "askai" | "preview" | "perspective" | "map" | "queries">("shell");
  const [termSize, setTermSize] = useState<{ rows: number; cols: number } | null>(null);
  const [queryHistory, setQueryHistory] = useState<QueryHistoryEntry[]>([]);

  // Expose query history setter for the initShell closure
  bridge.addQueryHistoryEntry = (entry: QueryHistoryEntry) => {
    setQueryHistory(prev => [...prev, entry]);
  };
  const [perspectiveLoading, setPerspectiveLoading] = useState(false);
  const [perspectiveHasData, setPerspectiveHasData] = useState(false);

  // Resolve selected table or view for Data Preview and Perspective tabs
  // Search both VGI catalog and memory catalog
  const allCatalogs = [catalogData, bridge.memoryCatalog].filter(Boolean);
  const findInCatalogs = (type: "table" | "view", name?: string, schema?: string) => {
    if (!name || !schema) return null;
    for (const cat of allCatalogs) {
      const s = cat.schemas.find((s: any) => s.info.name === schema);
      if (type === "table") { const t = s?.tables.find((t: any) => t.name === name); if (t) return t; }
      if (type === "view") { const v = s?.views.find((v: any) => v.name === name); if (v) return v; }
    }
    return null;
  };
  const selectedTable = selection?.type === "table" ? findInCatalogs("table", selection.name, selection.schema) : null;
  const selectedView = selection?.type === "view" ? findInCatalogs("view", selection.name, selection.schema) : null;
  const hasSelectedTableOrView = !!(selectedTable || selectedView || (selection && (selection.type === "table" || selection.type === "view")));

  // Expose a function to switch to the shell tab and ensure it's visible
  bridge.activateShell = () => {
    setActiveTab("shell");
    if (mode === "minimized") onModeChange("panel");
  };

  // Expose a callback for the shell to trigger Perspective view
  useEffect(() => {
    bridge.showPerspective = async (arrowBuffer: Uint8Array) => {
      setActiveTab("perspective");
      setPerspectiveLoading(true);
      setPerspectiveHasData(true);
      try {
        await loadPerspective(perspectiveRef.current!, arrowBuffer);
      } catch (e: any) {
        console.error("Perspective load error:", e);
      } finally {
        setPerspectiveLoading(false);
      }
    };
    bridge.showKepler = () => {
      setActiveTab("map");
    };
    return () => {
      bridge.showPerspective = null;
      bridge.showKepler = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        await loadScripts();
        if (cancelled || !containerRef.current) return;

        // Dynamic ESM imports
        const [arrowModule, { Readline }] = await Promise.all([
          import(/* @vite-ignore */ ARROW_CDN),
          import(/* @vite-ignore */ READLINE_CDN),
        ]);
        if (cancelled || !containerRef.current) return;

        setLoading(false);

        // Use RecordBatchFileReader for proper dictionary batch handling.
        // tableFromIPC doesn't populate dictionary data from IPC file format.
        const { tableFromIPC: _origTableFromIPC, RecordBatchFileReader, Table: ArrowTable } = arrowModule;
        const tableFromIPC = (buf: any) => {
          try {
            const reader = RecordBatchFileReader.from(buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf);
            const batches = [...reader];
            if (batches.length === 0) return _origTableFromIPC(buf);
            return new ArrowTable(batches);
          } catch {
            return _origTableFromIPC(buf);
          }
        };

        const shellToken = getAuthToken();
        console.log("[shell] Initializing DuckDB shell, token:", shellToken ? shellToken.substring(0, 20) + "..." : "NONE");
        const { cleanup, insertText } = initShell(
          containerRef.current,
          { serviceUrl, catalogName, token: shellToken, fontSize: settings.shellFontSize, catalogData, aiApiKey: settings.anthropicApiKey, aiModel: settings.aiModel },
          { tableFromIPC, Readline }
        );
        cleanupRef.current = cleanup;
        onShellReady?.(insertText);
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load shell");
      }
    })();

    return () => {
      cancelled = true;
      cleanupRef.current?.();
    };
  }, [serviceUrl, catalogName]);

  // Track terminal dimensions
  const updateTermSize = useCallback(() => {
    const term = bridge.shellTerm;
    if (term) setTermSize({ rows: term.rows, cols: term.cols });
  }, []);

  // Refit terminal when mode changes or switching back to shell tab
  useEffect(() => {
    if (mode !== "minimized" && activeTab === "shell" && bridge.shellFitAddon) {
      const fit = () => {
        bridge.shellFitAddon?.fit();
        updateTermSize();
      };
      const fitAndRefresh = () => {
        fit();
        // Force xterm to redraw all visible rows so the prompt isn't truncated
        const term = bridge.shellTerm;
        if (term) {
          term.refresh(0, term.rows - 1);
        }
      };
      requestAnimationFrame(fit);
      const t1 = setTimeout(fitAndRefresh, 50);
      const t2 = setTimeout(fitAndRefresh, 150);
      const t3 = setTimeout(fitAndRefresh, 300);
      return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
    }
  }, [mode, activeTab, updateTermSize]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (mode !== "minimized" && activeTab === "shell" && bridge.shellFitAddon) {
        bridge.shellFitAddon.fit();
        updateTermSize();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [mode, activeTab, updateTermSize]);

  // Auto-load Perspective virtual server when tab is active and a table is selected
  const perspectiveTableRef = useRef<string | null>(null);
  // Clear perspective state when switching away so it reloads fresh on return
  useEffect(() => {
    if (activeTab !== "perspective") {
      perspectiveTableRef.current = null;
    }
  }, [activeTab]);
  useEffect(() => {
    if (mode === "minimized" || activeTab !== "perspective" || !selectedTable) return;
    const tableId = `${selection?.catalog || catalogName}.${selectedTable.schemaName}.${selectedTable.name}`;
    // Don't reload if already showing this table
    if (perspectiveTableRef.current === tableId) return;

    let cancelled = false;
    setPerspectiveLoading(true);

    (async () => {
      try {
        // Ensure Perspective CDN scripts are loaded
        if (!perspectiveLoaded) {
          const perspective = await import(/* @vite-ignore */ getPerspectiveCDN()[0]);
          await Promise.all(getPerspectiveCDN().slice(1).map(url => import(/* @vite-ignore */ url)));
          perspectiveMod = perspective.default;
          perspectiveWorker = await perspectiveMod.worker();
          perspectiveLoaded = true;
        }

        if (cancelled) return;

        // Wait for DuckDB to be fully ready (ATTACH complete, readLoop started)
        if (!bridge.runQuery) {
          await new Promise<void>((resolve) => {
            const onReady = () => { resolve(); window.removeEventListener("duckdb-ready", onReady); };
            window.addEventListener("duckdb-ready", onReady);
            // Check again in case it became ready between the check and the listener
            if (bridge.runQuery) onReady();
          });
        }
        if (cancelled) return;

        // Load Perspective CSS (themes + pro theme)
        for (const css of ["/perspective/themes.css", "/perspective/pro.css"]) {
          if (!document.querySelector(`link[href="${css}"]`)) {
            const link = document.createElement("link");
            link.rel = "stylesheet";
            link.href = css;
            document.head.appendChild(link);
          }
        }

        const container = perspectiveRef.current;
        if (!container || cancelled) return;

        // Ensure WASM is initialized by creating a throwaway worker first
        // (perspectiveMod.worker() triggers WASM init internally)
        if (!perspectiveWorker) {
          perspectiveWorker = await perspectiveMod.worker();
        }

        // Create handler and message port
        const handler = new VgiDuckDBHandler(perspectiveMod);
        const messagePort = await perspectiveMod.createMessageHandler(handler);

        // Create client connected to our DuckDB virtual server
        const client = await perspectiveMod.worker(messagePort);

        if (cancelled) return;

        // Clean up stale viewer — must call delete() to release WASM virtual server views
        const oldViewer = container.querySelector("perspective-viewer") as any;
        if (oldViewer) {
          try { await oldViewer.delete(); } catch { /* ignore cleanup errors */ }
          oldViewer.remove();
        }

        const viewer = document.createElement("perspective-viewer") as any;
        viewer.setAttribute("theme", "Pro Light");
        viewer.style.width = "100%";
        viewer.style.height = "100%";
        container.appendChild(viewer);

        await viewer.load(client);

        // Build initial config
        const restoreConfig: any = { table: tableId, title: tableId };
        if (selectedTable) {
          const cols = getColumns(selectedTable);
          const pkIndices = new Set(selectedTable.primaryKeyConstraints.flatMap((pk: number[]) => pk));
          if (pkIndices.size > 0) {
            // Set PK columns to "any_value" aggregate so they don't get summed when grouping
            const aggregates: Record<string, string> = {};
            // Default to showing only PK columns (user can add more from the config panel)
            const pkColumns: string[] = [];
            for (const idx of pkIndices) {
              if (cols[idx]) {
                const pspName = cols[idx].name.replace(/_/g, "-");
                aggregates[pspName] = "any_value";
                pkColumns.push(pspName);
              }
            }
            restoreConfig.aggregates = aggregates;
            restoreConfig.columns = pkColumns;
          }
        }

        await viewer.restore(restoreConfig);
        await viewer.toggleConfig(true);
        perspectiveTableRef.current = tableId;
      } catch (e: any) {
        console.error("Perspective virtual server error:", e);
      } finally {
        if (!cancelled) setPerspectiveLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [mode, activeTab, selectedTable, selection, catalogName]);

  const tabCls = (tab: string) => {
    const active = activeTab === tab;
    return `inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium cursor-pointer transition-colors rounded-t-md ${
      active
        ? "bg-card text-primary border border-border border-b-0 relative z-10"
        : "text-muted-foreground hover:text-foreground border border-transparent hover:bg-secondary"
    }`;
  };

  const handleTabClick = (tab: typeof activeTab) => {
    if (tab === activeTab && mode !== "minimized") {
      onModeChange("minimized");
    } else {
      setActiveTab(tab);
      if (mode === "minimized") onModeChange("panel");
    }
  };

  return (
    <div ref={rootRef} className="flex flex-col h-full bg-terminal-bg">
      {/* Header bar — always visible, acts as minimized view */}
      <div
        className="flex items-center justify-between px-2 pt-1 bg-secondary shrink-0 border-b border-border"
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          if (mode === "minimized") onModeChange("panel");
        }}
        onDrop={(e) => {
          e.preventDefault();
          const data = e.dataTransfer.getData("text/plain");
          if (data) {
            const text = treeIdToShellText(data);
            if (text) bridge.insertText?.(text);
          }
        }}
      >
        <div className="flex items-end gap-0.5 -mb-px">
          <button role="tab" aria-selected={activeTab === "shell"} className={tabCls("shell")} onClick={() => handleTabClick("shell")}>
            <img src="/duckdb-icon-light.svg" alt="" className="h-4 w-4" />
            SQL Shell
          </button>
          <button role="tab" aria-selected={activeTab === "askai"} className={tabCls("askai")} onClick={() => handleTabClick("askai")}>
            <Sparkles className="h-3.5 w-3.5" />
            Ask AI
          </button>
          {hasSelectedTableOrView && (
            <button role="tab" aria-selected={activeTab === "preview"} className={tabCls("preview")} onClick={() => handleTabClick("preview")}>
              <Table2 className="h-3.5 w-3.5" />
              Preview
            </button>
          )}
          {queryHistory.length > 0 && (
            <button role="tab" aria-selected={activeTab === "queries"} className={tabCls("queries")} onClick={() => handleTabClick("queries")}>
              <History className="h-3.5 w-3.5" />
              Queries ({queryHistory.length})
            </button>
          )}
          <button
            role="tab" aria-selected={activeTab === "perspective"}
            className={`${tabCls("perspective")} ${!hasSelectedTableOrView && !perspectiveHasData ? "opacity-30 cursor-not-allowed" : ""}`}
            onClick={() => { if (hasSelectedTableOrView || perspectiveHasData) handleTabClick("perspective"); }}
          >
            <BarChart3 className="h-3.5 w-3.5" />
            Perspective
          </button>
          <button role="tab" aria-selected={activeTab === "map"} className={tabCls("map")} onClick={() => handleTabClick("map")}>
            <MapIcon className="h-3.5 w-3.5" />
            Map
          </button>
        </div>
        <div className="flex items-center gap-1 pb-1">
          {mode === "minimized" && (
            <button
              onClick={() => onModeChange("panel")}
              className="p-1 text-muted-foreground hover:text-foreground transition-colors"
              title="Expand"
              aria-label="Expand shell panel"
            >
              <ChevronUp className="h-3.5 w-3.5" />
            </button>
          )}
          {mode !== "minimized" && (
            <button
              onClick={() => onModeChange("minimized")}
              className="p-1 text-muted-foreground hover:text-foreground transition-colors"
              title="Minimize"
              aria-label="Minimize shell panel"
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            onClick={() => onModeChange(mode === "fullscreen" ? "panel" : "fullscreen")}
            className="p-1 text-muted-foreground hover:text-foreground transition-colors"
            title={mode === "fullscreen" ? "Restore" : "Full Screen"}
            aria-label={mode === "fullscreen" ? "Exit full screen" : "Enter full screen"}
          >
            {mode === "fullscreen" ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {/* Terminal container */}
      {mode !== "minimized" && loading && !error && activeTab === "shell" && (
        <div className="flex-1 flex items-center justify-center text-terminal-accent text-sm">
          Loading DuckDB-WASM...
        </div>
      )}
      {mode !== "minimized" && error && activeTab === "shell" && (
        <div className="flex-1 flex items-center justify-center text-red-400 text-sm">
          {error}
        </div>
      )}
      <div
        className={`flex-1 min-h-0 overflow-hidden relative ${mode === "minimized" || loading ? "hidden" : ""}`}
        style={{
          padding: "8px 12px 0 12px",
          ...(activeTab !== "shell" ? { visibility: "hidden" as const, position: "absolute" as const, inset: 0, zIndex: -1 } : {}),
        }}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
        onDrop={(e) => {
          e.preventDefault();
          const data = e.dataTransfer.getData("text/plain");
          if (data) {
            const text = treeIdToShellText(data);
            if (text) {
              bridge.insertText?.(text);
            }
          }
        }}
      >
        <div ref={containerRef} className="h-full w-full overflow-hidden" />
      </div>

      {/* Data Preview */}
      {mode !== "minimized" && activeTab === "preview" && hasSelectedTableOrView && (
        <div className="flex-1 min-h-0 overflow-hidden bg-card">
          <DataPreview
            tablePath={`${selection?.catalog || catalogName}.${selection?.schema || (selectedTable || selectedView)?.schemaName || "main"}.${selection?.name || (selectedTable || selectedView)?.name}`}
          />
        </div>
      )}

      {/* Perspective viewer */}
      <div
        ref={perspectiveRef}
        className={`flex-1 min-h-0 overflow-hidden bg-white ${mode === "minimized" || activeTab !== "perspective" ? "hidden" : ""}`}
      >
        {perspectiveLoading && (
          <div className="flex items-center justify-center h-full text-terminal-accent text-sm">
            Loading Perspective...
          </div>
        )}
        {!perspectiveLoading && activeTab === "perspective" && !perspectiveRef.current?.querySelector("perspective-viewer") && (
          <div className="flex items-center justify-center h-full text-terminal-fg/40 text-sm font-mono">
            {selectedTable
              ? "Loading table into Perspective..."
              : "Run a query then type .perspective to view results here"}
          </div>
        )}
      </div>

      {/* Kepler.gl map */}
      {/* Ask AI chat panel — always mounted to preserve conversation state */}
      <div
        className={`flex-1 min-h-0 overflow-hidden ${mode === "minimized" ? "hidden" : ""}`}
        style={activeTab !== "askai" ? { visibility: "hidden", position: "absolute", inset: 0, zIndex: -1 } : {}}
      >
        <Suspense fallback={
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            Loading...
          </div>
        }>
          <AskAIChat
            catalogData={catalogData}
            serviceUrl={serviceUrl}
            catalogName={catalogName}
            isActive={activeTab === "askai"}
          />
        </Suspense>
      </div>

      {/* Kepler.gl map — always mounted to preserve state */}
      <div
        className={`flex-1 min-h-0 overflow-hidden ${mode === "minimized" ? "hidden" : ""}`}
        style={activeTab !== "map" ? { visibility: "hidden", position: "absolute", inset: 0, zIndex: -1 } : {}}
      >
        <Suspense fallback={
          <div className="flex items-center justify-center h-full text-gray-500 text-sm bg-white">
            Loading Kepler.gl...
          </div>
        }>
          <KeplerMap />
        </Suspense>
      </div>

      {/* Query History panel */}
      {mode !== "minimized" && activeTab === "queries" && (() => {
        const handleRerun = (sql: string) => {
          setActiveTab("shell");
          const run = () => {
            const tryRun = () => {
              if (bridge.runQuery) {
                bridge.runQuery(sql);
              } else {
                requestAnimationFrame(tryRun);
              }
            };
            tryRun();
          };
          // If in AI mode, exit it first by simulating Ctrl+D
          if (bridge.inAiMode) {
            const term = bridge.shellTerm;
            if (term) {
              term.paste("\x04"); // Ctrl+D to exit AI mode
              // Wait for AI mode to exit, then run the query
              const waitForSql = () => {
                if (!bridge.inAiMode) {
                  setTimeout(run, 100);
                } else {
                  requestAnimationFrame(waitForSql);
                }
              };
              requestAnimationFrame(waitForSql);
            }
          } else {
            run();
          }
        };
        return (
        <div className="flex-1 min-h-0 overflow-y-auto bg-terminal-bg p-3">
          {queryHistory.length === 0 ? (
            <div className="flex items-center justify-center h-full text-terminal-fg/40 text-sm font-mono">
              No queries yet. Use .ai mode to generate queries.
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {(() => {
                // Group queries by conversationId, preserving order (newest conversation first)
                const groups: { conversationId: string | null; question: string | undefined; name: string | undefined; entries: QueryHistoryEntry[] }[] = [];
                const convMap = new Map<string, typeof groups[number]>();
                for (const entry of queryHistory) {
                  const cid = entry.conversationId ?? null;
                  if (cid && convMap.has(cid)) {
                    const g = convMap.get(cid)!;
                    g.entries.push(entry);
                    // Update name if a later entry has one (e.g., user named it mid-session)
                    if (entry.conversationName) g.name = entry.conversationName;
                  } else {
                    const group = { conversationId: cid, question: entry.userQuestion, name: entry.conversationName, entries: [entry] };
                    groups.push(group);
                    if (cid) convMap.set(cid, group);
                  }
                }
                return [...groups].reverse().map((group, gi) => {
                  if (!group.conversationId || group.entries.length === 1) {
                    // Standalone query — render flat
                    const entry = group.entries[0];
                    return <QueryCard key={entry.id} entry={entry} onRerun={handleRerun} />;
                  }
                  // Threaded conversation
                  return (
                    <div key={group.conversationId} className="border border-[#3a3a28] rounded-md bg-[#1e1e14] overflow-hidden">
                      {/* Conversation header */}
                      <div className="px-3 py-2 bg-[#24241a] border-b border-[#3a3a28] flex items-center gap-2">
                        <span className="text-terminal-accent text-xs font-mono font-semibold shrink-0">AI</span>
                        <span className="text-terminal-fg/60 text-xs truncate">
                          {group.name || group.question || "Unnamed conversation"}
                        </span>
                        <span className="text-terminal-fg/20 text-xs font-mono ml-auto shrink-0">{group.entries.length} queries</span>
                      </div>
                      {/* Threaded queries */}
                      <div className="flex flex-col">
                        {group.entries.map((entry, i) => (
                          <div key={entry.id} className="flex">
                            {/* Thread line */}
                            <div className="w-6 shrink-0 flex flex-col items-center">
                              <div className={`w-px flex-1 ${i === 0 ? "bg-transparent" : "bg-[#3a3a28]"}`} />
                              <div className="w-2 h-2 rounded-full bg-[#3a3a28] shrink-0" />
                              <div className={`w-px flex-1 ${i === group.entries.length - 1 ? "bg-transparent" : "bg-[#3a3a28]"}`} />
                            </div>
                            <div className="flex-1 min-w-0 py-2 pr-3">
                              <QueryCard entry={entry} compact onRerun={handleRerun} />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          )}
        </div>
        );
      })()}

    </div>
  );
}

function QueryCard({ entry, compact, onRerun }: { entry: QueryHistoryEntry; compact?: boolean; onRerun?: (sql: string) => void }) {
  const isAI = !!entry.conversationId;
  return (
    <div className={compact ? "" : `border rounded-md p-3 ${isAI ? "border-[#3a3a28] bg-[#24241a]" : "border-[#2a3a28] bg-[#1e241a]"}`}>
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          {!compact && (
            <span className={`text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded ${isAI ? "bg-[#35304a] text-purple-300" : "bg-[#2a3a2a] text-green-300"}`}>
              {isAI ? "AI" : "SQL"}
            </span>
          )}
          {!compact && entry.userQuestion && (
            <span className="text-terminal-fg/50 text-xs italic truncate">
              &ldquo;{entry.userQuestion}&rdquo;
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <span className="text-terminal-fg/30 text-xs font-mono">
            {new Date(entry.timestamp).toLocaleTimeString()}
          </span>
          <button
            className="p-1 text-terminal-fg/30 hover:text-terminal-accent transition-colors cursor-pointer"
            title="Copy SQL"
            onClick={() => navigator.clipboard.writeText(entry.sql)}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
          </button>
          {onRerun && (
            <button
              className="p-1 text-terminal-fg/30 hover:text-terminal-accent transition-colors cursor-pointer"
              title="Re-run query"
              onClick={() => onRerun(entry.sql)}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            </button>
          )}
        </div>
      </div>
      <pre className={`text-xs font-mono whitespace-pre-wrap break-all leading-relaxed ${isAI ? "text-purple-300" : "text-terminal-accent"}`}>
        {entry.sql}
      </pre>
      <div className="mt-1 text-xs font-mono">
        {entry.success ? (
          <span className="text-terminal-accent">
            {entry.rowCount != null ? `${entry.rowCount.toLocaleString()} row${entry.rowCount !== 1 ? "s" : ""}` : "OK"}
          </span>
        ) : (
          <span className="text-red-400">
            {entry.error || "Failed"}
          </span>
        )}
        <span className="text-terminal-fg/30 ml-2">
          {entry.executionTimeMs >= 1000
            ? `${(entry.executionTimeMs / 1000).toFixed(1)}s`
            : `${Math.round(entry.executionTimeMs)}ms`}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shell initialization (adapted from public/shell/index.html)
// ---------------------------------------------------------------------------

function initShell(
  container: HTMLElement,
  config: { serviceUrl: string; catalogName: string; token: string | null; fontSize?: number; catalogData?: CatalogData; aiApiKey?: string; aiModel?: string },
  modules: { tableFromIPC: any; Readline: any }
): { cleanup: () => void; insertText: (text: string) => void } {
  const { tableFromIPC, Readline } = modules;
  const T = (window as any).Terminal;
  const FA = (window as any).FitAddon;
  const WLA = (window as any).WebLinksAddon;
  const WGA = (window as any).WebglAddon;

  // Singleton terminal — reuse across shell instances
  const isNewTerminal = !bridge.shellTerm;
  let term: any, fitAddon: any, rl: any;

  if (isNewTerminal) {
    term = new T({
      cursorBlink: true,
      fontSize: config.fontSize || 13,
      fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
      theme: (() => { const t = getTerminalTheme(); return { background: t.background, foreground: t.foreground, cursor: t.cursor, selectionBackground: t.selection }; })(),
      allowProposedApi: true,
    });
    fitAddon = new FA.FitAddon();
    rl = new Readline();
    term.loadAddon(fitAddon);
    term.loadAddon(new WLA.WebLinksAddon());
    term.loadAddon(rl);
    term.open(container);
    try { term.loadAddon(new WGA.WebglAddon()); } catch { /* canvas fallback */ }

    // Batch writes within the same microtask to prevent flicker.
    // xterm-readline clears + redraws the line in separate write() calls;
    // this combines them into a single write so they render in one frame.
    const _origWrite = term.write.bind(term);
    let _writeBuf = "";
    let _flushScheduled = false;
    term.write = function(data: any) {
      _writeBuf += data;
      if (!_flushScheduled) {
        _flushScheduled = true;
        queueMicrotask(() => {
          _origWrite(_writeBuf);
          _writeBuf = "";
          _flushScheduled = false;
        });
      }
    };

    // ---- Tab completion state ----
    const comp = {
      active: false, items: [] as any[], idx: 0, start: 0, original: "",
      menuLines: 0, numCols: 1, numRows: 1, colWidth: 10,
    };

    function computeLayout() {
      const maxLen = Math.max(...comp.items.map((c: any) => c.suggestion.length));
      comp.colWidth = maxLen + 2;
      comp.numCols = Math.max(1, Math.floor(term.cols / comp.colWidth));
      comp.numRows = Math.ceil(comp.items.length / comp.numCols);
    }

    function clearCompletionMenu() {
      if (comp.menuLines > 0) {
        for (let i = 0; i < comp.menuLines; i++) {
          term.write("\r\n\x1b[2K");
        }
        term.write(`\x1b[${comp.menuLines}A`);
        comp.menuLines = 0;
      }
    }

    function renderCompletionMenu() {
      clearCompletionMenu();
      const lines: string[] = [];
      for (let row = 0; row < comp.numRows; row++) {
        let line = "";
        for (let col = 0; col < comp.numCols; col++) {
          const i = row * comp.numCols + col;
          if (i >= comp.items.length) continue;
          const text = comp.items[i].suggestion.padEnd(comp.colWidth);
          line += i === comp.idx ? `\x1b[7m${text}\x1b[0m` : text;
        }
        lines.push(line);
      }
      for (const line of lines) {
        term.write("\r\n\x1b[2K" + line);
      }
      if (lines.length > 0) {
        term.write(`\x1b[${lines.length}A\r`);
      }
      comp.menuLines = lines.length;
      if (rl.state) rl.state.refresh();
    }

    function applyCompletion(idx: number) {
      if (!rl.state) return;
      const c = comp.items[idx];
      const before = comp.original.slice(0, comp.start);
      rl.state.update(before + c.suggestion);
    }

    function exitCompletionMode(accept: boolean) {
      if (!comp.active) return;
      comp.active = false;
      if (!accept && rl.state) rl.state.update(comp.original);
      clearCompletionMenu();
      if (rl.state) rl.state.refresh();
    }

    function enterCompletionMode(items: any[], start: number, original: string) {
      comp.active = true;
      comp.items = items;
      comp.idx = 0;
      comp.start = start;
      comp.original = original;
      comp.menuLines = 0;
      computeLayout();
      applyCompletion(0);
      renderCompletionMenu();
    }

    function moveCompletion(newIdx: number) {
      if (newIdx < 0 || newIdx >= comp.items.length) return;
      comp.idx = newIdx;
      applyCompletion(comp.idx);
      renderCompletionMenu();
    }

    // ---- Ctrl+R reverse history search state ----
    let reverseSearchActive = false;
    let reverseSearchTerm = "";
    let reverseSearchIdx = -1;
    let reverseSearchMatch = "";
    let reverseSearchPreBuffer = "";
    let reverseSearchLineShown = false;

    function renderSearchLine() {
      if (!rl.state) return;
      // Combine search indicator + match into the readline buffer itself
      // This lets readline handle all wrapping and redrawing
      const prefix = `\x1b[33m(reverse-i-search)\x1b[0m "\x1b[1m${reverseSearchTerm}\x1b[0m":  `;
      rl.state.update(prefix + (reverseSearchMatch || ""));
      rl.state.refresh();
      reverseSearchLineShown = true;
    }

    function clearSearchLine() {
      reverseSearchLineShown = false;
    }

    function doReverseSearch() {
      const needle = reverseSearchTerm.toLowerCase();
      if (!needle) { reverseSearchMatch = ""; return; }
      // xterm-readline stores history as rl.history (array) or rl.history.entries
      const entries: string[] = Array.isArray(rl.history) ? rl.history : (rl.history?.entries ?? []);
      const start = reverseSearchIdx >= 0 ? reverseSearchIdx + 1 : 0;
      for (let i = start; i < entries.length; i++) {
        if (entries[i].toLowerCase().includes(needle)) {
          reverseSearchIdx = i;
          reverseSearchMatch = entries[i];
          return;
        }
      }
      // No new match — keep current
    }

    function exitReverseSearch(accept: boolean) {
      reverseSearchActive = false;
      clearSearchLine();
      if (rl.state) {
        rl.state.update(accept && reverseSearchMatch ? reverseSearchMatch : reverseSearchPreBuffer);
        rl.state.refresh();
      }
      reverseSearchTerm = "";
      reverseSearchIdx = -1;
      reverseSearchMatch = "";
      reverseSearchPreBuffer = "";
    }

    // Key event handler: tab completion, Ctrl+R reverse search, Ctrl+K
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type !== "keydown") {
        // Suppress keyup for keys we handle during completion or search
        if (comp.active && ["Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Escape", "Enter"].includes(e.key)) {
          return false;
        }
        if (reverseSearchActive && !e.ctrlKey) return false;
        return true;
      }

      // ---- Tab completion navigation ----
      if (comp.active) {
        if (e.key === "ArrowRight" || (e.key === "Tab" && !e.shiftKey)) {
          e.preventDefault();
          moveCompletion((comp.idx + 1) % comp.items.length);
          return false;
        }
        if (e.key === "ArrowLeft" || (e.key === "Tab" && e.shiftKey)) {
          e.preventDefault();
          moveCompletion((comp.idx - 1 + comp.items.length) % comp.items.length);
          return false;
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          const next = comp.idx + comp.numCols;
          moveCompletion(next < comp.items.length ? next : comp.idx);
          return false;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          const prev = comp.idx - comp.numCols;
          moveCompletion(prev >= 0 ? prev : comp.idx);
          return false;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          exitCompletionMode(true);
          return false;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          exitCompletionMode(false);
          return false;
        }
        // Any other key accepts current completion and passes through
        exitCompletionMode(true);
        return true;
      }

      // ---- Ctrl+K clears terminal ----
      if (e.key === "k" && (e.ctrlKey || e.metaKey)) {
        term.clear();
        return false;
      }

      // ---- Ctrl+C during reverse search cancels it ----
      if (e.key === "c" && e.ctrlKey && reverseSearchActive) {
        exitReverseSearch(false);
        return false;
      }

      // ---- Ctrl+R — start or continue reverse search ----
      if (e.key === "r" && e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        if (!reverseSearchActive) {
          reverseSearchActive = true;
          reverseSearchTerm = "";
          reverseSearchIdx = -1;
          reverseSearchMatch = "";
          reverseSearchPreBuffer = rl.state ? rl.state.buffer?.() || "" : "";
          renderSearchLine();
        } else {
          doReverseSearch();
          renderSearchLine();
        }
        return false;
      }

      // ---- Keys during reverse search ----
      if (reverseSearchActive) {
        if (e.key === "Enter") { exitReverseSearch(true); return false; }
        if (e.key === "Escape") { exitReverseSearch(false); return false; }
        if (e.key === "Backspace") {
          reverseSearchTerm = reverseSearchTerm.slice(0, -1);
          reverseSearchIdx = -1;
          doReverseSearch();
          renderSearchLine();
          return false;
        }
        if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
          reverseSearchTerm += e.key;
          reverseSearchIdx = -1;
          doReverseSearch();
          renderSearchLine();
          return false;
        }
        if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return false;
        exitReverseSearch(true);
        return true;
      }

      // ---- Tab triggers completion ----
      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        const state = rl.state;
        if (state) {
          const buf = state.buffer();
          if (buf.trim()) {
            onCompletionsReceived = (completions) => {
              if (!completions || completions.length === 0) return;
              const currentBuf = state.buffer();
              const hasTies = completions.length > 1 &&
                completions[0].score === completions[1].score;

              if (!hasTies) {
                // Single best match — auto-insert
                const c = completions[0];
                const typed = currentBuf.slice(c.start);
                const toInsert = c.suggestion.slice(typed.length);
                if (toInsert) state.editInsert(toInsert);
              } else {
                // Multiple tied matches — insert common prefix or show menu
                const start = completions[0].start;
                const typed = currentBuf.slice(start);
                let common = completions[0].suggestion;
                for (let i = 1; i < completions.length; i++) {
                  let j = 0;
                  while (j < common.length && j < completions[i].suggestion.length &&
                    common[j].toLowerCase() === completions[i].suggestion[j].toLowerCase()) j++;
                  common = common.slice(0, j);
                }
                const toInsert = common.slice(typed.length);
                if (toInsert) {
                  state.editInsert(toInsert);
                } else {
                  enterCompletionMode(completions, start, currentBuf);
                }
              }
            };
            worker.postMessage({ type: "complete", text: buf });
          }
        }
        return false;
      }

      return true;
    });

    bridge.shellTerm = term;
    bridge.shellFitAddon = fitAddon;
    bridge.shellReadline = rl;
  } else {
    term = bridge.shellTerm;
    fitAddon = bridge.shellFitAddon;
    rl = bridge.shellReadline;
    // Reparent the terminal DOM element to the new container
    const termEl = term.element?.parentElement;
    if (termEl && termEl !== container) {
      container.appendChild(termEl);
    }
  }

  let fitTimer: ReturnType<typeof setTimeout> | null = null;
  const safeFit = () => {
    try {
      if (container.offsetWidth > 0 && container.offsetHeight > 0) {
        fitAddon?.fit();
      }
    } catch {}
  };
  const debouncedFit = () => {
    if (fitTimer) clearTimeout(fitTimer);
    fitTimer = setTimeout(safeFit, 50);
  };
  const resizeObserver = new ResizeObserver(debouncedFit);
  resizeObserver.observe(container);

  // Fit after reparenting
  safeFit();
  requestAnimationFrame(safeFit);
  setTimeout(safeFit, 100);

  // Write helpers
  function writeln(msg: string, color?: string) {
    const c = color ? `\x1b[${color}m` : "";
    const r = color ? "\x1b[0m" : "";
    rl.println(c + msg + r);
  }

  // Progress bar
  let progressLine = false;
  function renderProgressBar(pct: number) {
    const label = ` ${String(Math.round(pct)).padStart(3)}%`;
    const barWidth = Math.max(10, term.cols - label.length - 2);
    const filled = Math.round((pct / 100) * barWidth);
    const bar = " \x1b[32m" + "█".repeat(filled) + "\x1b[2m" + "░".repeat(barWidth - filled) + "\x1b[0m";
    term.write(`\r${bar}${label}\x1b[K`);
    progressLine = true;
  }
  function clearProgressBar() {
    if (progressLine) {
      term.write("\r\x1b[K");
      progressLine = false;
    }
  }

  // Singleton worker — shared across all DuckDBShell instances
  const isNewWorker = !bridge.worker;
  const worker = bridge.worker || new Worker("/shell/worker.js");
  bridge.worker = worker;
  let currentWasmVersion = "";

  // Only set up SABs and init for new workers
  let cancelInt32: Int32Array | null = null;
  if (isNewWorker) {
    (bridge as any)._oauthSAB = typeof SharedArrayBuffer !== "undefined" ? new SharedArrayBuffer(8192) : null;
    if ((bridge as any)._oauthSAB) worker.postMessage({ type: "init-oauth-sab", sab: (bridge as any)._oauthSAB });

    const cancelSAB = typeof SharedArrayBuffer !== "undefined" ? new SharedArrayBuffer(4) : null;
    if (cancelSAB) worker.postMessage({ type: "init-cancel-sab", sab: cancelSAB });

    cancelInt32 = cancelSAB ? new Int32Array(cancelSAB) : null;
    bridge.cancelQuery = () => {
      if (cancelInt32) Atomics.store(cancelInt32, 0, 1);
    };
  }

  let queryRunning = false;
  let outputMode: "box" | "line" = "box";
  let maxDisplayRows = 40;
  let lastTable: any = null;
  let lastArrowBuffer: Uint8Array | null = null;
  let lastAutoSave = 0; // timestamp of last auto-save
  let autoSaveEnabled = true;

  /** Take a snapshot from the worker. */
  function takeSnapshot(): Promise<{ memory: ArrayBuffer; size: number; connHdl: number; wasmVersion: string }> {
    return new Promise((resolve, reject) => {
      const handler = (e: MessageEvent) => {
        if (e.data.type === "snapshot") {
          worker.removeEventListener("message", handler);
          resolve(e.data);
        }
      };
      worker.addEventListener("message", handler);
      worker.postMessage({ type: "snapshot" });
      setTimeout(() => { worker.removeEventListener("message", handler); reject(new Error("Snapshot timed out")); }, 30000);
    });
  }

  /** Restore a snapshot to the worker. */
  function restoreSnapshot(memory: ArrayBuffer, size: number, snapConnHdl: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const handler = (e: MessageEvent) => {
        if (e.data.type === "restored") {
          worker.removeEventListener("message", handler);
          resolve();
        } else if (e.data.type === "log" && e.data.cls === "err") {
          worker.removeEventListener("message", handler);
          reject(new Error(e.data.msg));
        }
      };
      worker.addEventListener("message", handler);
      worker.postMessage({ type: "restore", memory, size, connHdl: snapConnHdl }, [memory]);
      setTimeout(() => { worker.removeEventListener("message", handler); reject(new Error("Restore timed out")); }, 30000);
    });
  }

  /** Auto-save the current session to IndexedDB. */
  async function autoSave() {
    if (!config.serviceUrl || !autoSaveEnabled) return;
    try {
      const snap = await takeSnapshot();
      await saveAutoSave(config.serviceUrl, snap.wasmVersion, snap.memory, snap.connHdl);
      lastAutoSave = Date.now();
      console.log("[session] Auto-saved");
    } catch (err) {
      console.warn("[session] Auto-save failed:", err);
    }
  }

  // Shared callback for tab completion — set by key handler, called by worker.onmessage
  let onCompletionsReceived: ((completions: any[]) => void) | null = null;

  worker.onmessage = (e: MessageEvent) => {
    const d = e.data;

    if (d.type === "open-auth-url") {
      const oauthSAB = (bridge as any)._oauthSAB as SharedArrayBuffer | null;
      console.log("[shell] DuckDB requesting auth, token available:", !!config.token, "SAB available:", !!oauthSAB);
      if (config.token && oauthSAB) {
        // Token interception — pass cached token directly via SharedArrayBuffer
        console.log("[shell] Passing token to DuckDB via SAB:", config.token.substring(0, 20) + "...");
        const int32 = new Int32Array(oauthSAB);
        const bytes = new Uint8Array(oauthSAB);
        const encoded = new TextEncoder().encode(config.token);
        const maxTokenBytes = oauthSAB.byteLength - 8; // 8 bytes reserved for header
        if (encoded.length > maxTokenBytes) {
          console.error("[shell] Token too large for SAB:", encoded.length, "bytes, max:", maxTokenBytes);
          window.open(d.url, "_blank", "popup,width=500,height=700");
        } else {
          new DataView(oauthSAB).setInt32(4, encoded.length, true);
          bytes.set(encoded, 8);
          Atomics.store(int32, 0, 1);
          Atomics.notify(int32, 0);
        }
      } else {
        console.log("[shell] No token — opening auth popup:", d.url?.substring(0, 80));
        window.open(d.url, "_blank", "popup,width=500,height=700");
      }
      return;
    }

    if (d.type === "log") {
      const colorMap: Record<string, string> = { ok: "32", err: "31", info: "33" };
      if (d.msg) writeln(d.msg, colorMap[d.cls]);
      return;
    }

    if (d.type === "ready") {
      currentWasmVersion = d.wasmVersion || "";
      (async () => {
        // Try to restore previous session from IndexedDB
        // Skip restore if ?noreset or ?fresh is in the URL (escape hatch for corrupted snapshots)
        const skipRestore = new URLSearchParams(window.location.search).has("fresh");
        let restored = false;
        if (skipRestore && config.serviceUrl) {
          // Delete the saved snapshot so next load is clean
          try { await deleteSession(`${config.serviceUrl}::${AUTOSAVE_NAME}`); } catch { /* ignore */ }
          writeln("Fresh start — cleared saved session.", "33");
        }
        if (config.serviceUrl && !skipRestore) {
          try {
            const autoSaveSession = await getAutoSave(config.serviceUrl);
            if (autoSaveSession && autoSaveSession.wasmVersion === currentWasmVersion) {
              const memory = await decompressMemory(autoSaveSession);
              await restoreSnapshot(memory, memory.byteLength, autoSaveSession.connHdl);
              const when = new Date(autoSaveSession.timestamp).toLocaleString();
              writeln(`Restored previous session (saved ${when})`, "32");
              restored = true;

              // Re-attach the catalog with a fresh token if auth is in use
              if (config.catalogName && config.token) {
                const oauthMeta = getOAuthMeta();
                const esc = (s: string) => s.replace(/'/g, "''");
                const escId = (s: string) => `"${s.replace(/"/g, '""')}"`;
                await runQueryAsync(`USE memory`);
                let attachSql = `ATTACH OR REPLACE '${esc(config.catalogName)}' AS ${escId(config.catalogName)} (TYPE vgi, LOCATION '${esc(config.serviceUrl!)}'`;
                if (oauthMeta?.refreshToken) {
                  attachSql += `, oauth_refresh_token '${esc(oauthMeta.refreshToken)}'`;
                }
                attachSql += `)`;
                console.log("[shell] Re-attach SQL:", attachSql.replace(/oauth_refresh_token '[^']*'/, "oauth_refresh_token '***'"));
                const reattach = await runQueryAsync(attachSql);
                if (reattach.ok) {
                  // Silent — user doesn't need to know about credential refresh
                } else {
                  const errStr = reattach.error ?? "";
                  console.log("[shell] Re-attach failed:", errStr);
                  const isAuthError = /oauth|auth|401|403|invalid_grant|token.*expired|token.*failed/i.test(errStr);
                  if (isAuthError) {
                    console.log("[shell] Re-attach auth error, redirecting");
                    redirectToAuth(config.serviceUrl!);
                    return;
                  }
                  writeln(`Re-attach failed: ${errStr}`, "31");
                }
              }

              // Refresh sidebar to show in-memory tables from the restored snapshot
              bridge.refreshMemoryTables?.();
            }
          } catch (err: any) {
            console.warn("[session] Auto-restore failed:", err);
            writeln("Previous session expired, starting fresh.", "33");
            // Delete the bad auto-save so it doesn't fail again on next load
            try {
              await deleteSession(`${config.serviceUrl}::${AUTOSAVE_NAME}`);
            } catch { /* ignore cleanup errors */ }
          }
        }

        if (!restored && config.serviceUrl && config.catalogName) {
          writeln(`Connecting to ${config.catalogName}...`, "33");
          // Build ATTACH SQL — include oauth_refresh_token if we have it from the frontend OAuth redirect
          const oauthMeta = getOAuthMeta();
          const esc = (s: string) => s.replace(/'/g, "''");
          let attachSql = `ATTACH OR REPLACE '${esc(config.catalogName)}' AS ${config.catalogName} (TYPE vgi, LOCATION '${esc(config.serviceUrl)}'`;
          if (oauthMeta?.refreshToken) {
            attachSql += `, oauth_refresh_token '${esc(oauthMeta.refreshToken)}'`;
            console.log("[shell] Including oauth_refresh_token in ATTACH");
          }
          attachSql += `)`;
          console.log("[shell] ATTACH SQL:", attachSql.replace(/oauth_refresh_token '[^']*'/, "oauth_refresh_token '***'"));
          const result = await runQueryAsync(attachSql);
          if (result.ok) {
            await runQueryAsync(`USE ${config.catalogName}`);
            writeln(`Connected to ${config.catalogName}`, "32");
          } else {
            const errStr = result.error ?? "";
            console.log("[shell] ATTACH failed:", errStr);
            const isAuthError = /oauth|auth|401|403|invalid_grant|token.*expired|token.*failed/i.test(errStr);
            if (isAuthError) {
              console.log("[shell] Auth error detected, redirecting. config.token:", config.token ? config.token.substring(0, 20) + "..." : "NONE");
              redirectToAuth(config.serviceUrl);
              return;
            }
            writeln(`Attach failed: ${errStr}`, "31");
          }
          writeln("");
        } else if (!restored) {
          writeln("");
          writeln("Type SQL queries below.", "33");
          writeln("");
        } else {
          writeln("");
        }

        // Set up periodic auto-save (every 5 minutes)
        setInterval(() => {
          if (config.serviceUrl && Date.now() - lastAutoSave > 60_000) {
            autoSave();
          }
        }, 300_000);

        // Auto-save on page unload
        window.addEventListener("beforeunload", () => { autoSave(); });

        // Query DuckDB's timezone setting for timestamp_tz formatting
        try {
          const tzResult = await runQueryAsync("SELECT current_setting('TimeZone') as tz");
          if (tzResult.ok && tzResult.arrowBuffers?.length) {
            const tzTable = tableFromIPC(tzResult.arrowBuffers[0]);
            const tzVal = tzTable.getChildAt(0)?.get(0);
            if (tzVal) {
              const { setDuckDBTimezone } = await import("@/lib/format");
              setDuckDBTimezone(String(tzVal));
            }
          }
        } catch { /* ignore — will fall back to browser timezone */ }

        // Shell is fully ready — expose runQuery for external callers
        bridge.runQuery = runQuery;
        window.dispatchEvent(new Event("duckdb-ready"));
        readLoop();
      })();
      return;
    }

    if (d.type === "completions") {
      if (onCompletionsReceived) {
        const completions: any[] = [];
        if (d.arrowBuffers) {
          try {
            for (const buf of d.arrowBuffers) {
              const table = tableFromIPC(new Uint8Array(buf));
              const sugCol = table.getChild("suggestion");
              const startCol = table.getChild("suggestion_start");
              const scoreCol = table.getChild("suggestion_score");
              for (let i = 0; i < table.numRows; i++) {
                completions.push({
                  suggestion: sugCol ? String(sugCol.get(i)) : "",
                  start: startCol ? Number(startCol.get(i)) : 0,
                  score: scoreCol ? Number(scoreCol.get(i)) : 0,
                });
              }
            }
          } catch { /* ignore parse errors */ }
        }
        const cb = onCompletionsReceived;
        onCompletionsReceived = null;
        cb(completions);
      }
      return;
    }

    if (d.type === "progress") {
      if (queryRunning) renderProgressBar(d.percentage);
      // Also notify external listeners (e.g., KeplerMap loading overlay)
      const progressCb = bridge.progress;
      if (progressCb) progressCb(d.percentage);
      return;
    }
  };

  // Query execution
  let nextQueryId = 1;
  function runQueryAsync(sql: string): Promise<any> {
    const queryId = nextQueryId++;
    return new Promise((resolve) => {
      const handler = (e: MessageEvent) => {
        if (e.data.type === "result" && e.data.queryId === queryId) {
          worker.removeEventListener("message", handler);
          resolve(e.data);
        }
      };
      worker.addEventListener("message", handler);
      worker.postMessage({ type: "query", sql, queryId });
    });
  }

  // Synchronous query — uses duckdb_web_query_run (single Arrow IPC buffer, no streaming chunks)
  // Required by Perspective's dataSlice.fromArrowIpc() which expects the non-streaming format
  function runQuerySync(sql: string): Promise<any> {
    const queryId = nextQueryId++;
    return new Promise((resolve) => {
      const handler = (e: MessageEvent) => {
        if (e.data.type === "result" && e.data.queryId === queryId) {
          worker.removeEventListener("message", handler);
          resolve(e.data);
        }
      };
      worker.addEventListener("message", handler);
      worker.postMessage({ type: "query-sync", sql, queryId });
    });
  }

  // Current catalog/schema for prompt
  let currentCatalog = "";
  let currentSchema = "";
  async function refreshCatalog() {
    try {
      const r = await runQueryAsync("SELECT current_catalog(), current_schema()");
      if (r.ok && r.arrowBuffers?.length) {
        const t = tableFromIPC(r.arrowBuffers[0]);
        if (t.numRows > 0) {
          currentCatalog = String(t.getChildAt(0)?.get(0) ?? "");
          currentSchema = String(t.getChildAt(1)?.get(0) ?? "");
        }
      }
    } catch {}
  }

  // Persistent AI conversation state (survives across .ai mode entries)
  let aiMessages: MessageParam[] = [];
  let aiConversationId = `ai-${Date.now()}`;
  let aiConversationName = "";

  // Read loop
  let prefillText = "";
  let prefillCursorPos = -1;
  let promptInputEmpty = true;
  // Track whether user has typed anything at the current prompt
  const inputTracker = term.onData((data: string) => {
    // Printable characters (not control sequences) mean the user typed something
    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      promptInputEmpty = false;
    }
  });

  async function readLoop() {
    await refreshCatalog();
    while (true) {
      promptInputEmpty = true;
      const ctx = currentCatalog
        ? `\x1b[2m${currentCatalog}.${currentSchema}\x1b[0m`
        : "";
      const prompt = ctx ? `\x1b[32mD\x1b[0m ${ctx} > ` : `\x1b[32mD\x1b[0m > `;
      const readPromise = rl.read(prompt);
      if (prefillText) {
        const text = prefillText;
        const cursorPos = prefillCursorPos;
        prefillText = "";
        prefillCursorPos = -1;
        setTimeout(() => {
          term.paste(text);
          // Move cursor to error position if specified
          if (cursorPos >= 0 && cursorPos < text.length) {
            const movesLeft = text.length - cursorPos;
            for (let i = 0; i < movesLeft; i++) {
              term.paste("\x1b[D"); // left arrow
            }
          }
        }, 10);
      }
      const sql = await readPromise;
      const trimmed = sql.trim();
      if (!trimmed) {
        // Remove blank entry that readline already pushed to history
        if (rl.history?.length) rl.history.pop();
        continue;
      }
      // Dot-command dispatch (delegated to shell-commands.ts)
      if (trimmed.startsWith(".") || trimmed.startsWith("\\")) {
        const shellState: ShellState = {
          get maxDisplayRows() { return maxDisplayRows; },
          set maxDisplayRows(n) { maxDisplayRows = n; },
          get outputMode() { return outputMode; },
          set outputMode(m) { outputMode = m; },
          get autoSaveEnabled() { return autoSaveEnabled; },
          set autoSaveEnabled(v) { autoSaveEnabled = v; },
          lastTable,
          lastArrowBuffer,
          currentWasmVersion,
        };
        const shellIO: ShellIO = { writeln, serviceUrl: config.serviceUrl, runQueryAsync, tableFromIPC, takeSnapshot, downloadFile };
        if (await handleDotCommand(trimmed, shellState, shellIO)) continue;
      }

      // -----------------------------------------------------------------------
      // AI mode
      // -----------------------------------------------------------------------
      if (trimmed === ".ai" || trimmed === ".ai new" || trimmed.startsWith(".ai name ")) {
        // Handle .ai name <text> — set conversation name without entering AI mode
        if (trimmed.startsWith(".ai name ")) {
          aiConversationName = trimmed.slice(9).trim();
          writeln(`Conversation named: ${aiConversationName}`, "33");
          continue;
        }

        // Read API key fresh from localStorage (user may have set it after shell opened)
        let aiApiKey = config.aiApiKey || "";
        let aiModel = config.aiModel || "claude-sonnet-4-20250514";
        let aiMaxToolRounds = 20;
        try {
          const stored = localStorage.getItem("vgi-frontend-settings");
          if (stored) {
            const s = JSON.parse(stored);
            if (s.anthropicApiKey) aiApiKey = s.anthropicApiKey;
            if (s.aiModel) aiModel = s.aiModel;
            if (s.aiMaxToolRounds) aiMaxToolRounds = s.aiMaxToolRounds;
          }
        } catch {}

        if (!aiApiKey) {
          writeln("No API key configured. Set your Anthropic API key in Settings.", "31");
          continue;
        }
        if (!config.catalogData) {
          writeln("Catalog data not available. Try again after the catalog loads.", "31");
          continue;
        }

        // .ai new → start fresh conversation
        if (trimmed === ".ai new") {
          aiMessages = [];
          aiConversationId = `ai-${Date.now()}`;
          aiConversationName = "";
          writeln("Starting new AI conversation. Type .exit to return to SQL.", "35");
        } else if (aiMessages.length > 0) {
          // Resume existing conversation
          const msgCount = aiMessages.length;
          const nameHint = aiConversationName ? ` (${aiConversationName})` : "";
          writeln(`Resuming AI conversation${nameHint} — ${msgCount} messages. Type .ai new for a fresh start.`, "35");
        } else {
          writeln("Entering AI mode. Type .exit to return to SQL.", "35");
        }
        writeln("");
        bridge.inAiMode = true;

        const systemPrompt = buildSystemPrompt(config.catalogData, config.serviceUrl, bridge.memoryCatalog);
        let aiAbort: AbortController | null = null;

        // Braille spinner
        const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
        let spinnerInterval: ReturnType<typeof setInterval> | null = null;
        let spinnerFrame = 0;
        let spinnerLabel = "";

        function startSpinner(label: string) {
          spinnerLabel = label;
          spinnerFrame = 0;
          if (spinnerInterval) return; // already running, just update label
          spinnerInterval = setInterval(() => {
            // Don't write spinner when terminal is hidden — \r won't work on zero-width terminal
            if (term.cols < 2) return;
            const frame = spinnerFrames[spinnerFrame % spinnerFrames.length];
            term.write(`\r\x1b[1;35m${frame} ${spinnerLabel}\x1b[0m\x1b[K`);
            spinnerFrame++;
          }, 100);
        }

        function stopSpinner() {
          if (spinnerInterval) {
            clearInterval(spinnerInterval);
            spinnerInterval = null;
            term.write("\r\x1b[K"); // Clear the spinner line
          }
        }

        // Ctrl+D or Escape exits AI mode
        let ctrlDExit = false;
        const ctrlDDisposable = term.onData((data: string) => {
          if (data === "\x04" || data === "\x1b") { // Ctrl+D or Escape
            ctrlDExit = true;
            // Submit empty line to unblock rl.read()
            term.paste("\r");
          }
        });

        // AI read loop
        aiLoop: while (true) {
          const userInput = await rl.read("\x1b[1;36mAI\x1b[0m > ");

          if (ctrlDExit) {
            ctrlDExit = false;
            ctrlDDisposable.dispose();
            writeln("Exiting AI mode.", "35");
            writeln("");
            break;
          }

          const aiTrimmed = userInput.trim();

          if (!aiTrimmed) {
            if (rl.history?.length) rl.history.pop();
            continue;
          }

          if (aiTrimmed === ".help" || aiTrimmed === "/help") {
            writeln("/new               Start a new conversation");
            writeln("/name <text>       Name this conversation");
            writeln("/clear             Clear conversation history");
            writeln("/exit              Return to SQL mode");
            writeln("/help              Show this help");
            continue;
          }

          if (aiTrimmed === "/new") {
            aiMessages = [];
            aiConversationId = `ai-${Date.now()}`;
            aiConversationName = "";
            writeln("Started new conversation.", "33");
            continue;
          }

          if (aiTrimmed === ".clear" || aiTrimmed === "/clear") {
            aiMessages = [];
            aiConversationId = `ai-${Date.now()}`;
            aiConversationName = "";
            writeln("Conversation cleared.", "33");
            continue;
          }

          if (aiTrimmed.startsWith(".name ") || aiTrimmed.startsWith("/name ")) {
            aiConversationName = aiTrimmed.slice(6).trim();
            writeln(`Conversation named: ${aiConversationName}`, "33");
            continue;
          }

          if (aiTrimmed === ".exit" || aiTrimmed === "/exit") {
            ctrlDDisposable.dispose();
            writeln("Exiting AI mode.", "35");
            writeln("");
            break;
          }

          aiMessages.push({ role: "user", content: aiTrimmed });
          // Auto-name conversation from first user question if not explicitly named
          if (!aiConversationName) {
            aiConversationName = aiTrimmed.length > 50 ? aiTrimmed.slice(0, 50) + "…" : aiTrimmed;
          }
          aiAbort = new AbortController();
          let textBuffer = "";

          // Ctrl+C / Escape handler — abort the in-flight request
          const cancelDisposable = term.onData((data: string) => {
            if ((data === "\x03" || data === "\x1b") && aiAbort) { // Ctrl+C or Escape
              aiAbort.abort();
            }
          });

          startSpinner("Thinking...");

          try {
            // Tool executor
            const executeTool = async (name: string, input: any): Promise<string> => {
              if (name === "run_sql") {
                stopSpinner();
                queryRunning = true;
                const t0 = performance.now();
                const result = await runQueryAsync(input.sql);
                const elapsed = performance.now() - t0;
                clearProgressBar();
                queryRunning = false;
                if (cancelInt32) Atomics.store(cancelInt32, 0, 0);

                // Find user question for context
                const lastUserMsg = aiMessages.filter(m => m.role === 'user').pop();
                const userQuestion = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : undefined;

                if (!result.ok) {
                  const errMsg = result.error || "Query failed";
                  rl.println(`\x1b[31m  Error: ${errMsg}\x1b[0m`);

                  // Track failed query in history
                  bridge.addQueryHistoryEntry?.({
                    id: Date.now(),
                    timestamp: Date.now(),
                    sql: input.sql,
                    executionTimeMs: elapsed,
                    success: false,
                    error: errMsg,
                    userQuestion,
                    conversationId: aiConversationId,
                    conversationName: aiConversationName,
                  });

                  // HTTP errors mean the VGI server connection is broken — abort the agent loop
                  if (errMsg.includes("HTTP Error") || errMsg.includes("HTTP 5")) {
                    // TODO: Report this error to the developer for exception tracking
                    const fatal = new Error(`VGI connection error: ${errMsg}`);
                    (fatal as any).fatal = true;
                    throw fatal;
                  }

                  throw new Error(errMsg);
                }
                if (!result.arrowBuffers?.length) {
                  rl.println(`\x1b[2m  OK (no results)\x1b[0m`);
                  bridge.addQueryHistoryEntry?.({
                    id: Date.now(),
                    timestamp: Date.now(),
                    sql: input.sql,
                    executionTimeMs: elapsed,
                    success: true,
                    rowCount: 0,
                    userQuestion,
                    conversationId: aiConversationId,
                    conversationName: aiConversationName,
                  });
                  return JSON.stringify({ ok: true, message: "Query executed successfully (no results)" });
                }
                const table = tableFromIPC(result.arrowBuffers[0]);
                await printTable(table);
                const { json } = formatArrowTableAsJson(table);

                // Track successful query in history
                bridge.addQueryHistoryEntry?.({
                  id: Date.now(),
                  timestamp: Date.now(),
                  sql: input.sql,
                  executionTimeMs: elapsed,
                  success: true,
                  rowCount: table.numRows,
                  userQuestion,
                  conversationId: aiConversationId,
                  conversationName: aiConversationName,
                });

                return json;
              }
              if (name === "read_query_results") {
                return executeReadQueryResults(input.result_id, input.offset, input.limit);
              }
              if (name === "list_tables") {
                return executeListTables(config.catalogData!);
              }
              if (name === "describe_table") {
                return executeDescribeTable(config.catalogData!, input.schema, input.table);
              }
              if (name === "ask_user") {
                stopSpinner();
                // Display question and options
                rl.println("");
                rl.println(`\x1b[1m${input.question}\x1b[0m`);
                const options: string[] = input.options || [];
                for (let i = 0; i < options.length; i++) {
                  rl.println(`  \x1b[33m${i + 1}.\x1b[0m ${options[i]}`);
                }
                rl.println("");
                const choice = await rl.read("Select: ");
                const idx = parseInt(choice.trim(), 10) - 1;
                if (idx >= 0 && idx < options.length) {
                  return `User selected: ${options[idx]}`;
                }
                return `User responded: ${choice.trim()}`;
              }
              return JSON.stringify({ error: `Unknown tool: ${name}` });
            };

            await runAgentTurn(
              aiApiKey,
              aiModel,
              aiMessages,
              systemPrompt,
              executeTool,
              {
                onText: (chunk) => {
                  textBuffer += chunk;
                },
                onToolCall: (name, input) => {
                  stopSpinner();
                  // Render any buffered text before showing tool call
                  if (textBuffer) {
                    rl.println("");
                    const md = createMarkdownRenderer(term.cols);
                    term.write(md.push(textBuffer + "\n"));
                    term.write(md.end());
                    textBuffer = "";
                  }
                  rl.println("");
                  if (name === "run_sql") {
                    const sqlLabel = "── SQL ";
                    const lineWidth = Math.max(0, term.cols - sqlLabel.length - 1);
                    rl.println(`\x1b[2m${sqlLabel}${"─".repeat(lineWidth)}\x1b[0m`);
                    rl.println(`\x1b[33m${input.sql}\x1b[0m`);
                    rl.println("");
                  } else if (name === "describe_table") {
                    rl.println(`\x1b[2m  📋 Describing ${input.schema}.${input.table}\x1b[0m`);
                  } else if (name === "list_tables") {
                    rl.println(`\x1b[2m  📋 Listing tables\x1b[0m`);
                  } else if (name === "ask_user") {
                    // Handled in executeTool
                  } else {
                    rl.println(`\x1b[2m  [${name}]\x1b[0m`);
                  }
                },
                onToolResult: () => {
                  rl.println("");
                  startSpinner("Thinking...");
                },
                onDone: (usage) => {
                  stopSpinner();
                  // Render the complete response with markdown formatting
                  if (textBuffer) {
                    rl.println("");
                    const md = createMarkdownRenderer(term.cols);
                    term.write(md.push(textBuffer + "\n"));
                    term.write(md.end());
                    textBuffer = "";
                  }
                  rl.println("");
                  if (usage) {
                    const cost = estimateCost(aiModel, usage.inputTokens, usage.outputTokens);
                    const costStr = formatCost(cost);
                    rl.println(`\x1b[2m  tokens: ${usage.inputTokens.toLocaleString()} in, ${usage.outputTokens.toLocaleString()} out (${costStr})\x1b[0m`);
                  }
                  rl.println("");
                  rl.println("");
                },
                onError: (error) => {
                  stopSpinner();
                  rl.println("");
                  writeln(`Error: ${error}`, "31");
                  rl.println("");
                },
                onRetry: (message) => {
                  if (message) {
                    startSpinner(message);
                  } else {
                    startSpinner("Thinking...");
                  }
                },
              },
              aiAbort.signal,
              aiMaxToolRounds
            );
          } catch (err: any) {
            stopSpinner();
            if (err.name === "AbortError" || err.message === "Cancelled.") {
              rl.println("");
              writeln("Cancelled.", "33");
              rl.println("");
              // Remove the partial assistant message from history
              if (aiMessages.length && aiMessages[aiMessages.length - 1].role === "user") {
                // User message was added but no response — keep it for retry
              }
            } else {
              rl.println("");
              writeln(`Error: ${err.message || err}`, "31");
              rl.println("");
            }
          } finally {
            cancelDisposable.dispose();
          }
        }

        bridge.inAiMode = false;
        continue; // Back to SQL readLoop
      }

      queryRunning = true;
      const t0 = performance.now();
      const result = await runQueryAsync(trimmed);
      const elapsed = performance.now() - t0;
      clearProgressBar();
      queryRunning = false;
      if (cancelInt32) Atomics.store(cancelInt32, 0, 0); // reset cancel flag for next query

      if (!result.ok) {
        const errStr = result.error || "unknown";
        // Try to parse structured DuckDB error JSON
        let errMsg = errStr;
        let errPos = -1;
        try {
          const parsed = JSON.parse(errStr);
          if (parsed.exception_message) {
            errMsg = parsed.exception_message;
            if (parsed.position) errPos = parseInt(parsed.position, 10);
          }
        } catch {
          // Not JSON — check for plain position hint like "... at position 15"
        }

        writeln(`Error: ${errMsg}`, "31");

        // Show position indicator under the query
        if (errPos >= 0) {
          rl.println(`\x1b[2m${trimmed}\x1b[0m`);
          rl.println(`\x1b[31m${" ".repeat(Math.max(0, errPos - 1))}^\x1b[0m`);
          // Pre-fill next prompt with the query, cursor at error position
          prefillText = trimmed;
          prefillCursorPos = errPos - 1; // position is 1-based
        }
      } else if (result.arrowBuffers && result.arrowBuffers.length > 0) {
        try {
          lastArrowBuffer = result.arrowBuffers[0];
          const table = tableFromIPC(lastArrowBuffer);
          lastTable = table;
          const fields = table.schema.fields;
          const fieldNames = fields.map((f: any) => f.name);

          // DDL statements (CREATE, DROP, ALTER) return a single "Count" column — just show OK
          if (fields.length === 1 && fieldNames[0] === "Count" && table.numRows <= 1) {
            const elapsedStr = elapsed >= 1000 ? `${(elapsed / 1000).toFixed(1)}s` : `${Math.round(elapsed)}ms`;
            writeln(`OK (${elapsedStr})`, "32");
            // DDL — refresh sidebar, handle navigation, and auto-save
            autoSave();
            bridge.refreshMemoryTables?.().then?.(() => {
              const createMatch = trimmed.match(/CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?(?:TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:memory\.)?(?:(\w+)\.)?(\w+)/i);
              if (createMatch) {
                const schema = createMatch[1] || "main";
                const name = createMatch[2];
                bridge.navigateToSelection?.({ type: "table", name, schema, catalog: "memory" });
              }
              const dropMatch = trimmed.match(/DROP\s+(?:TABLE|VIEW|SCHEMA)\s+(?:IF\s+EXISTS\s+)?(?:memory\.)?(?:(\w+)\.)?(\w+)/i);
              if (dropMatch) {
                const isSchemaLevel = /DROP\s+SCHEMA/i.test(trimmed);
                if (isSchemaLevel) {
                  bridge.navigateToSelection?.({ type: "catalog", name: "memory", catalog: "memory" });
                } else {
                  const schema = dropMatch[1] || "main";
                  bridge.navigateToSelection?.({ type: "schema", name: schema, schema, catalog: "memory" });
                }
              }
            });

          // EXPLAIN returns explain_key + explain_value — render as plain text
          } else if (fieldNames.includes("explain_key") && fieldNames.includes("explain_value")) {
            const keyIdx = fieldNames.indexOf("explain_key");
            const valIdx = fieldNames.indexOf("explain_value");
            for (let r = 0; r < table.numRows; r++) {
              const key = String(table.getChildAt(keyIdx)?.get(r) ?? "");
              const val = String(table.getChildAt(valIdx)?.get(r) ?? "");
              if (key) rl.println(`\x1b[1m${key}\x1b[0m`);
              // Print each line of the explain output
              for (const line of val.split("\n")) {
                rl.println(`\x1b[2m${line}\x1b[0m`);
              }
            }
            const elapsedStr = elapsed >= 1000 ? `${(elapsed / 1000).toFixed(1)}s` : `${Math.round(elapsed)}ms`;
            rl.println(`\x1b[2m(${elapsedStr})\x1b[0m`);

          } else if (outputMode === "line") {
            printLine(table, elapsed);
          } else {
            await printTable(table, elapsed);
          }

          bridge.addQueryHistoryEntry?.({
            id: Date.now(),
            timestamp: Date.now(),
            sql: trimmed,
            executionTimeMs: elapsed,
            success: true,
            rowCount: table.numRows,
          });
        } catch (err: any) {
          writeln(`Failed to render: ${err.message}`, "31");
        }
      } else {
        writeln("OK", "32");
        bridge.addQueryHistoryEntry?.({
          id: Date.now(),
          timestamp: Date.now(),
          sql: trimmed,
          executionTimeMs: elapsed,
          success: true,
          rowCount: 0,
        });
      }

      // Refresh prompt catalog if the query might have changed it
      const upper = trimmed.toUpperCase();
      if (upper.startsWith("USE ") || upper.startsWith("ATTACH ") || upper.startsWith("SET SCHEMA") || upper.startsWith("SET SEARCH_PATH")) {
        await refreshCatalog();
      }
    }
  }

  // Use shared safeGetArrowValue from format.ts
  const safeGet = safeGetArrowValue;

  function formatVal(val: any, field: any): string {
    if (val === null || val === undefined) return "NULL";
    return formatCellValue(val, field?.name, field);
  }

  // Terminal output adapter for shell-table-renderer
  const termOutput: TerminalOutput = {
    get cols() { return term.cols; },
    println: (line: string) => rl.println(line),
  };

  async function printTable(table: any, elapsedMs?: number) {
    return printBoxTable(table, termOutput, maxDisplayRows, elapsedMs);
  }

  function printLine(table: any, elapsedMs?: number) {
    return printLineTable(table, termOutput, maxDisplayRows, elapsedMs);
  }

  /** Download the last result as CSV or Excel. */
  async function downloadFile(table: any, format: "csv" | "excel") {
    const fields = table.schema.fields;
    const numRows = table.numRows;
    const totalCols = fields.length;

    // Build row data
    const headers = fields.map((f: any) => f.name);
    const data: any[][] = [];
    for (let r = 0; r < numRows; r++) {
      const row: any[] = [];
      for (let c = 0; c < totalCols; c++) {
        const val = safeGet(table.getChildAt(c), r, fields[c]);
        row.push(val instanceof Uint8Array ? "[binary]" : formatVal(val, fields[c]));
      }
      data.push(row);
    }

    if (format === "excel") {
      // Real .xlsx via SheetJS
      const XLSX = await import("xlsx");
      const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Result");
      const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
      const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "result.xlsx";
      a.click();
      URL.revokeObjectURL(url);
      writeln(`Downloaded result.xlsx (${numRows} row${numRows !== 1 ? "s" : ""}, ${totalCols} column${totalCols !== 1 ? "s" : ""})`, "32");
    } else {
      // CSV
      const csvEscape = (s: string) => {
        if (s.includes(",") || s.includes('"') || s.includes("\n")) {
          return '"' + s.replace(/"/g, '""') + '"';
        }
        return s;
      };
      const csvRows = [headers.map(csvEscape).join(",")];
      for (const row of data) {
        csvRows.push(row.map((v: any) => csvEscape(String(v))).join(","));
      }
      const blob = new Blob([csvRows.join("\n") + "\n"], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "result.csv";
      a.click();
      URL.revokeObjectURL(url);
      writeln(`Downloaded result.csv (${numRows} row${numRows !== 1 ? "s" : ""}, ${totalCols} column${totalCols !== 1 ? "s" : ""})`, "32");
    }
  }

  // Expose query function and catalog name for kepler.gl's DuckDB adapter
  bridge.query = (sql: string) => runQueryAsync(sql);
  bridge.querySync = (sql: string) => runQuerySync(sql);
  bridge.catalogName = config.catalogName;

  if (isNewWorker) {
    // First shell: init worker, wait for ready, ATTACH, then start readLoop
    worker.postMessage({ type: "init" });
  }
  // If terminal already existed, everything (readLoop, handlers) is still running
  // — no need to reinitialize

  // Find geometry columns for a fully-qualified table name so they can be excluded.
  // Returns comma-separated geometry column names, or null if none found.
  function getGeometryExclude(dottedName: string): string | null {
    const parts = dottedName.split(".");
    if (parts.length !== 3) return null;
    const [cat, schema, table] = parts;
    const catalogs = [config.catalogData, bridge.memoryCatalog].filter(Boolean);
    for (const catData of catalogs) {
      if (catData.catalogName !== cat) continue;
      const s = catData.schemas.find((s: any) => s.info.name === schema);
      const t = s?.tables.find((t: any) => t.name === table);
      if (!t) continue;
      const geomCols = getColumns(t).filter((c) => c.duckdbType === "GEOMETRY").map((c) => c.name);
      return geomCols.length > 0 ? geomCols.join(", ") : null;
    }
    return null;
  }

  // Insert text into the terminal's current input line.
  // If the input is empty and the text looks like a table name, wrap it in SELECT * FROM.
  // Geometry columns are excluded via EXCLUDE since they have no shell representation.
  function insertText(text: string) {
    const isTable = text.includes(".") && !text.includes(" ") && !text.includes("(");
    if (isTable && promptInputEmpty) {
      const exclude = getGeometryExclude(text);
      if (exclude) {
        term.paste(`SELECT * EXCLUDE (${exclude}) FROM ${text} LIMIT 100;`);
      } else {
        term.paste(`SELECT * FROM ${text} LIMIT 100;`);
      }
    } else {
      term.paste(text);
    }
    term.focus();
  }

  // Run a query: paste SQL then send Enter separately so readline processes it
  function runQuery(sql: string) {
    term.paste(sql);
    requestAnimationFrame(() => {
      term.paste("\r");
      term.focus();
    });
  }

  // Expose insertText immediately (for drag-drop from tree)
  bridge.insertText = insertText;
  // __shellRunQuery is set later, after ATTACH completes and readLoop starts

  return {
    cleanup: () => {
      resizeObserver.disconnect();
      inputTracker.dispose();
      // Don't terminate shared worker or dispose shared terminal
      bridge.shellFitAddon = null;
      bridge.insertText = null;
      bridge.runQuery = null;
      bridge.query = null;
      bridge.catalogName = null;
    },
    insertText,
  };
}

// ---------------------------------------------------------------------------
// Perspective viewer — loads CDN scripts and renders inline
// ---------------------------------------------------------------------------

function getPerspectiveCDN() {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return [
    `${origin}/perspective/perspective.js`,              // Built from source — includes fromArrowIpc
    `${origin}/perspective/perspective-viewer.js`,       // Built from source — matching WASM protocol
    `${origin}/perspective/perspective-viewer-datagrid.js`,
    `${origin}/perspective/perspective-viewer-d3fc.js`,
  ];
}
const PERSPECTIVE_CSS = "/perspective/themes.css";

let perspectiveLoaded = false;
let perspectiveMod: any = null;  // The perspective module (for createMessageHandler, GenericSQLVirtualServerModel)
let perspectiveWorker: any = null;  // A perspective worker instance (for direct Arrow loading)

async function loadPerspective(container: HTMLElement, arrowBuffer: Uint8Array) {
  // Load Perspective CSS (themes + pro theme)
  for (const css of ["/perspective/themes.css", "/perspective/pro.css"]) {
    if (!document.querySelector(`link[href="${css}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = css;
      document.head.appendChild(link);
    }
  }

  // Load scripts via dynamic import (ES modules)
  if (!perspectiveLoaded) {
    const perspective = await import(/* @vite-ignore */ getPerspectiveCDN()[0]);
    // Import viewer + plugins (register custom elements)
    await Promise.all(getPerspectiveCDN().slice(1).map(url => import(/* @vite-ignore */ url)));
    perspectiveMod = perspective.default;
    perspectiveWorker = await perspectiveMod.worker();
    perspectiveLoaded = true;
  }

  // Create or reuse the viewer element
  let viewer = container.querySelector("perspective-viewer") as any;
  if (!viewer) {
    viewer = document.createElement("perspective-viewer");
    viewer.setAttribute("theme", "Pro Light");
    viewer.style.width = "100%";
    viewer.style.height = "100%";
    container.appendChild(viewer);
  }

  // Load Arrow data
  const copy = new Uint8Array(arrowBuffer);
  const table = await perspectiveWorker.table(copy.buffer);
  await viewer.load(table);
}

/**
 * Convert a tree item ID to text suitable for pasting into the shell.
 * IDs: "catalog::schema::t:table" → "schema.table"
 *      "catalog::schema::c:table/column" → "column"
 */
function treeIdToShellText(id: string): string | null {
  const parts = id.split("::");
  if (parts.length === 3) {
    const catalog = parts[0];
    const schema = parts[1];
    const rest = parts[2];
    if (rest.startsWith("t:")) return `${catalog}.${schema}.${rest.slice(2)}`;
    if (rest.startsWith("c:")) {
      const colParts = rest.slice(2).split("/");
      return colParts[1] || colParts[0];
    }
    if (rest.startsWith("v:")) return `${catalog}.${schema}.${rest.slice(2)}`;
    if (rest.startsWith("f:")) return rest.slice(2);
  }
  return null;
}
