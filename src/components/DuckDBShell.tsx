/**
 * DuckDB-WASM Shell React component.
 * Loads xterm.js + addons from CDN to avoid SSR/bundling issues.
 * Shell logic adapted from public/shell/index.html.
 */
import { useEffect, useRef, useState, useCallback, lazy, Suspense } from "react";
import { Maximize2, Minimize2, ChevronDown, ChevronUp, BarChart3, History, Table2, Sparkles, Loader2 } from "lucide-react";
const AskAIChat = lazy(() => import("./AskAIChat").then(m => ({ default: m.AskAIChat })));
import { DataPreview } from "./content/DataPreview";
import { getColumns } from "@/lib/service";
import { VgiDuckDBHandler } from "@/lib/perspective-duckdb-handler";
import { getAuthToken, getAuthTokenForService, getOAuthMeta, redirectToAuth } from "@/lib/auth";
import { useSettings } from "@/lib/settings";
import { formatCellValue, safeGetArrowValue } from "@/lib/format";
import { tableFromIPC } from "apache-arrow";
import { printBoxTable, printLineTable, type TerminalOutput } from "@/lib/shell-table-renderer";
import { handleDotCommand, type ShellState, type ShellIO } from "@/lib/shell-commands";
import { runAIMode, type AIConversationState, type AITerminal, type AIShellOps } from "@/lib/shell-ai-mode";
import { attachInputHandlers, type CompletionItem } from "@/lib/shell-input";
import { bridge, recordQuery, notifyQueryChange, setBootPhase, onBootChange } from "@/lib/shell-bridge";
import { ShellBootScreen } from "./ShellBootScreen";
import * as Sentry from "@sentry/astro";
import { ensureDuckDB, resolveThreadCount } from "@/lib/duckdb-worker-boot";
import { getTerminalTheme } from "@/lib/theme";
import { initShell } from "@/lib/shell-init";

import type { CatalogData } from "@/lib/service";

export type { QueryHistoryEntry } from "@/lib/shell-bridge";

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
  /**
   * Called when ATTACH fails with an unrecoverable OAuth error (e.g. the IdP
   * returned invalid_grant on token exchange or refresh). The parent should
   * surface this in a modal — auto-redirecting through the auth flow again
   * would just produce the same error.
   */
  onAuthError?: (title: string, message: string) => void;
  /**
   * Called when ATTACH fails for a non-auth reason — typically a malformed
   * or unrecognized option in the user-supplied connection options. The
   * parent surfaces this in a modal so users notice even if the shell is
   * minimized.
   */
  onAttachError?: (title: string, message: string) => void;
  /** Free-form raw SQL fragment to splice into the ATTACH parens. */
  attachOptions?: string;
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

export function DuckDBShell({ serviceUrl, catalogName, mode, onModeChange, onShellReady, catalogData, selection, onAuthError, onAttachError, attachOptions }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const perspectiveRef = useRef<HTMLDivElement>(null);
  const { settings } = useSettings();
  // Overlay visibility is driven by bridge.bootPhase, not by external-script
  // loading. The DuckDB worker boot (downloading WASM, spinning up pthreads,
  // loading extensions, attaching) is the slow part — especially on Safari —
  // and the bridge already signals true readiness with setBootPhase(null).
  const [bootActive, setBootActive] = useState(() => bridge.bootPhase !== null);
  useEffect(() => {
    const unsub = onBootChange(() => setBootActive(bridge.bootPhase !== null));
    return () => unsub();
  }, []);
  const [error, setError] = useState<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const [activeTab, setActiveTab] = useState<"shell" | "askai" | "preview" | "perspective" | "queries">("shell");
  // In-memory Arrow table to show in the Preview tab when the user runs
  // `.preview` in the shell. Takes precedence over the selection-driven table
  // preview, and is cleared when the sidebar selection changes (see below).
  const [resultPreview, setResultPreview] = useState<any>(null);
  const [termSize, setTermSize] = useState<{ rows: number; cols: number } | null>(null);
  const [queryHistory, setQueryHistory] = useState<QueryHistoryEntry[]>([]);

  // Defer heavy DuckDB WASM initialization until the user actually opens the
  // shell (mode leaves "minimized"). This avoids fetching the large WASM
  // binary and booting the worker on page load, which causes issues in Safari.
  const [shellActivated, setShellActivated] = useState(mode !== "minimized");
  useEffect(() => {
    if (mode !== "minimized") setShellActivated(true);
  }, [mode]);

  // Expose query history setter for the initShell closure. Inside useEffect
  // with cleanup so React's strict-mode mount/unmount/remount doesn't leave a
  // stale closure pointing at the previous component instance's setState.
  useEffect(() => {
    bridge.addQueryHistoryEntry = (entry: QueryHistoryEntry) => {
      setQueryHistory(prev => [...prev, entry]);
    };
    return () => { bridge.addQueryHistoryEntry = null; };
  }, []);
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

  // Expose a function to switch to the shell tab and ensure it's visible.
  // useEffect + cleanup so unmount doesn't leave a callback closed over a
  // stale mode/onModeChange.
  useEffect(() => {
    bridge.activateShell = () => {
      setActiveTab("shell");
      if (mode === "minimized") onModeChange("panel");
    };
    return () => { bridge.activateShell = null; };
  }, [mode, onModeChange]);

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
        Sentry.captureException(e, { tags: { component: "perspective", path: "showPerspective" } });
      } finally {
        setPerspectiveLoading(false);
      }
    };
    return () => {
      bridge.showPerspective = null;
    };
  }, []);

  // Expose a callback for the shell's `.preview` command to open the last
  // query result in the Data Preview tab. The Arrow IPC buffer is decoded
  // here and handed to DataPreview's client-side (result) pagination mode.
  useEffect(() => {
    bridge.showPreview = (arrowBuffer: Uint8Array) => {
      try {
        setResultPreview(tableFromIPC(arrowBuffer));
        setActiveTab("preview");
        if (mode === "minimized") onModeChange("panel");
      } catch (e: any) {
        console.error("Preview decode error:", e);
        Sentry.captureException(e, { tags: { component: "preview", path: "showPreview" } });
      }
    };
    return () => { bridge.showPreview = null; };
  }, [mode, onModeChange]);

  // A result preview belongs to a specific query, not to the sidebar. When the
  // user navigates to a different table/view, drop it so the Preview tab falls
  // back to previewing that selection.
  useEffect(() => {
    setResultPreview(null);
  }, [selection?.type, selection?.catalog, selection?.schema, selection?.name]);

  useEffect(() => {
    if (!shellActivated) return;
    let cancelled = false;

    // Service or catalog switched — make sure any consumers awaiting the
    // previous ATTACH cycle now block on the new one.
    bridge.resetAttached?.();

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

        // Use the service-aware async path so we see SPA / sessionStorage
        // tokens (synchronous `getAuthToken()` only checks the URL fragment
        // and `_vgi_auth` cookie). For SPA-flow services the fragment is
        // consumed by an earlier fetchCatalog call and never seen by us.
        const shellToken = (await getAuthTokenForService(serviceUrl)) ?? getAuthToken();
        console.log("[shell] Initializing DuckDB shell, token:", shellToken ? shellToken.substring(0, 20) + "..." : "NONE");
        const { cleanup, insertText } = initShell(
          containerRef.current,
          { serviceUrl, catalogName, token: shellToken, fontSize: settings.shellFontSize, threadCount: resolveThreadCount(settings.shellThreads), catalogData, aiApiKey: settings.anthropicApiKey, aiModel: settings.aiModel, attachOptions },
          { tableFromIPC, Readline },
          { onAuthError, onAttachError }
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
  }, [shellActivated, serviceUrl, catalogName]);

  // Track terminal dimensions
  const updateTermSize = useCallback(() => {
    const term = bridge.shellTerm;
    if (term) setTermSize({ rows: term.rows, cols: term.cols });
  }, []);

  // Refit terminal when mode changes or switching back to shell tab.
  // The ResizeObserver in shell-init.ts handles continuous reflow; this is
  // just the one-shot post-mount fit. Prior to consolidation, this used a
  // 50/150/300ms setTimeout ladder that was guessing at layout settling
  // and masked real bugs — replaced by rAF + a single 0ms tick to cover
  // the case where layout finishes after rAF on Safari.
  useEffect(() => {
    if (mode !== "minimized" && activeTab === "shell" && bridge.shellFitAddon) {
      const fitAndRefresh = () => {
        bridge.shellFitAddon?.fit();
        updateTermSize();
        const term = bridge.shellTerm;
        if (term) term.refresh(0, term.rows - 1);
      };
      requestAnimationFrame(fitAndRefresh);
      const t = setTimeout(fitAndRefresh, 0);
      return () => { clearTimeout(t); };
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
  useEffect(() => {
    if (mode === "minimized" || activeTab !== "perspective" || !selectedTable) return;
    // Schema name lives on different fields depending on the catalog source:
    // attached/memory catalogs (built in duckdb-catalog.ts) expose it as
    // `schemaName`, while VGI primary-catalog tables come straight off the
    // wire with `schema_name`. The active selection always has it as
    // `schema`, so prefer that and fall back for safety.
    const schemaName = selection?.schema ?? selectedTable.schemaName ?? selectedTable.schema_name;
    const tableId = `${selection?.catalog || catalogName}.${schemaName}.${selectedTable.name}`;
    // Don't reload if already showing this table
    if (perspectiveTableRef.current === tableId) return;

    let cancelled = false;
    setPerspectiveLoading(true);

    (async () => {
      try {
        await ensurePerspectiveLoaded();
        if (cancelled) return;

        // Wait for DuckDB to be fully ready (ATTACH complete, readLoop started)
        if (!bridge.runQuery) {
          await new Promise<void>((resolve) => {
            const onReady = () => { resolve(); window.removeEventListener("duckdb-ready", onReady); };
            window.addEventListener("duckdb-ready", onReady);
            if (bridge.runQuery) onReady();
          });
        }
        if (cancelled) return;

        const container = perspectiveRef.current;
        if (!container || cancelled) return;

        // Ensure WASM is initialized by creating a throwaway worker first
        // (perspectiveMod.worker() triggers WASM init internally)
        if (!perspectiveWorker) {
          perspectiveWorker = await perspectiveMod.worker();
        }

        // Reuse the persistent virtual-server client so views survive table switches
        if (!perspectiveClient) {
          const handler = new VgiDuckDBHandler(perspectiveMod);
          const messagePort = await perspectiveMod.createMessageHandler(handler);
          perspectiveClient = await perspectiveMod.worker(messagePort);
        }

        if (cancelled) return;

        // Clean up stale viewer — must call delete() to release WASM virtual server views
        const oldViewer = container.querySelector("perspective-viewer") as any;
        if (oldViewer) {
          // Save the current config before tearing down, keyed by previous tableId
          if (perspectiveTableRef.current) {
            try {
              const savedConfig = await oldViewer.save();
              perspectiveConfigCache.set(perspectiveTableRef.current, savedConfig);
            } catch { /* ignore save errors — worst case we lose the config */ }
          }
          try { await oldViewer.delete(); } catch { /* ignore cleanup errors */ }
          oldViewer.remove();
        }

        const viewer = document.createElement("perspective-viewer") as any;
        viewer.setAttribute("theme", "Pro Light");
        viewer.style.width = "100%";
        viewer.style.height = "100%";
        container.appendChild(viewer);
        // Disable auto-pause so hiding the container doesn't trigger
        // IntersectionObserver resume which causes "View not found" errors
        await viewer.setAutoPause(false);

        await viewer.load(perspectiveClient);

        // Restore config from cache, or build a default
        let restoreConfig: any;
        const cachedConfig = perspectiveConfigCache.get(tableId);
        if (cachedConfig) {
          restoreConfig = { ...cachedConfig, table: tableId };
        } else {
          restoreConfig = { table: tableId, title: tableId };
          if (selectedTable) {
            const cols = getColumns(selectedTable);
            const pkIndices = new Set((selectedTable.primaryKeyConstraints ?? []).flatMap((pk: number[]) => pk));
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
            } else if (cols.length > 0) {
              // No primary key — start with just the first column to avoid overwhelming the grid
              restoreConfig.columns = [cols[0].name.replace(/_/g, "-")];
            }
          }
        }

        await viewer.restore(restoreConfig);
        await viewer.toggleConfig(true);
        perspectiveTableRef.current = tableId;
      } catch (e: any) {
        console.error("Perspective virtual server error:", e);
        Sentry.captureException(e, {
          tags: { component: "perspective", path: "auto-load" },
          extra: { tableId },
        });
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
            <img src={`${import.meta.env.BASE_URL}duckdb-icon-light.svg`} alt="" className="h-4 w-4" />
            SQL Shell
          </button>
          <button role="tab" aria-selected={activeTab === "askai"} className={tabCls("askai")} onClick={() => handleTabClick("askai")}>
            <Sparkles className="h-3.5 w-3.5" />
            Ask AI
          </button>
          {(hasSelectedTableOrView || resultPreview) && (
            <button role="tab" aria-selected={activeTab === "preview"} className={tabCls("preview")} onClick={() => handleTabClick("preview")}>
              <Table2 className="h-3.5 w-3.5" />
              {resultPreview ? "Result" : "Preview"}
            </button>
          )}
          {queryHistory.length > 0 && (
            <button role="tab" aria-selected={activeTab === "queries"} className={tabCls("queries")} onClick={() => handleTabClick("queries")}>
              <History className="h-3.5 w-3.5" />
              Query History ({queryHistory.length})
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
      {mode !== "minimized" && bootActive && !error && activeTab === "shell" && (
        <ShellBootScreen />
      )}
      {mode !== "minimized" && error && activeTab === "shell" && (
        <div className="flex-1 flex items-center justify-center text-red-400 text-sm">
          {error}
        </div>
      )}
      <div
        className={`flex-1 min-h-0 overflow-hidden relative ${mode === "minimized" || bootActive ? "hidden" : ""}`}
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

      {/* Data Preview — a `.preview` result (client-paginated, in-memory)
          takes precedence over the selection-driven table preview. The key
          forces a clean remount when switching between the two sources. */}
      {mode !== "minimized" && activeTab === "preview" && (resultPreview || hasSelectedTableOrView) && (
        <div className="flex-1 min-h-0 overflow-hidden bg-card">
          {resultPreview ? (
            <DataPreview key="result" result={resultPreview} />
          ) : (
            <DataPreview
              key="table"
              tablePath={`${selection?.catalog || catalogName}.${selection?.schema || (selectedTable || selectedView)?.schemaName || "main"}.${selection?.name || (selectedTable || selectedView)?.name}`}
            />
          )}
        </div>
      )}

      {/* Perspective viewer */}
      <div
        ref={perspectiveRef}
        className={`flex-1 min-h-0 overflow-hidden bg-white ${mode === "minimized" || activeTab !== "perspective" ? "hidden" : ""}`}
      >
        {perspectiveLoading && (
          <div className="flex items-center justify-center gap-2 h-full text-terminal-accent text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
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
          {bridge.openInEditor && (
            <button
              className="p-1 text-terminal-fg/30 hover:text-terminal-accent transition-colors cursor-pointer"
              title="Open in SQL editor"
              onClick={() => bridge.openInEditor?.(entry.sql)}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="m10 13-2 2 2 2"/><path d="m14 17 2-2-2-2"/></svg>
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
// Perspective viewer — loads CDN scripts and renders inline
// ---------------------------------------------------------------------------

function getPerspectiveCDN() {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const base = import.meta.env.BASE_URL;
  return [
    `${origin}${base}perspective/perspective.js`,              // Built from source — includes fromArrowIpc
    `${origin}${base}perspective/perspective-viewer.js`,       // Built from source — matching WASM protocol
    `${origin}${base}perspective/perspective-viewer-datagrid.js`,
    `${origin}${base}perspective/perspective-viewer-d3fc.js`,
  ];
}
let perspectiveLoaded = false;
let perspectiveMod: any = null;
let perspectiveWorker: any = null;
/** Persistent virtual-server client — reused across table switches so views stay alive. */
let perspectiveClient: any = null;
/** In-memory cache of Perspective viewer configs keyed by tableId (catalog.schema.table). */
const perspectiveConfigCache = new Map<string, any>();

/** Load Perspective CSS and scripts (idempotent). */
async function ensurePerspectiveLoaded(): Promise<void> {
  const base = import.meta.env.BASE_URL;
  for (const css of [`${base}perspective/themes.css`, `${base}perspective/pro.css`]) {
    if (!document.querySelector(`link[href="${css}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = css;
      document.head.appendChild(link);
    }
  }
  if (!perspectiveLoaded) {
    const perspective = await import(/* @vite-ignore */ getPerspectiveCDN()[0]);
    await Promise.all(getPerspectiveCDN().slice(1).map(url => import(/* @vite-ignore */ url)));
    perspectiveMod = perspective.default;
    perspectiveWorker = await perspectiveMod.worker();
    perspectiveLoaded = true;
  }
}

async function loadPerspective(container: HTMLElement, arrowBuffer: Uint8Array) {
  await ensurePerspectiveLoaded();

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
