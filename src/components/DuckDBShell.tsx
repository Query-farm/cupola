/**
 * DuckDB-WASM Shell React component.
 * Loads xterm.js + addons from CDN to avoid SSR/bundling issues.
 * Shell logic adapted from public/shell/index.html.
 */
import { useEffect, useRef, useState, lazy, Suspense } from "react";
import { Loader2, Table2 } from "lucide-react";
import type { TabId } from "./AppTabBar";
const AskAIChat = lazy(() => import("./AskAIChat").then(m => ({ default: m.AskAIChat })));
import { DataPreview } from "./content/DataPreview";
import { getColumns } from "@/lib/service";
import { treeIdToShellText } from "@/lib/tree";
import { VgiDuckDBHandler } from "@/lib/perspective-duckdb-handler";
import { getAuthToken, getAuthTokenForService } from "@/lib/auth";
import { useSettings } from "@/lib/settings";
import { tableFromIPC, Table as ArrowTable } from "@query-farm/apache-arrow";
import { tableFromIPCWithDictionaries } from "@/lib/duckdb-query";
import { coerceArrowBufferForPerspective } from "@/lib/perspective-extension-coerce";
import { engine, terminal, ui, setBootPhase, setEngineLifecycleError } from "@/lib/shell-bridge";
import { useEngineLifecycle } from "@/lib/use-engine-lifecycle";
import { ShellBootScreen } from "./ShellBootScreen";
import * as Sentry from "@sentry/astro";
import { resolveThreadCount } from "@/lib/duckdb-worker-boot";
import { initShell } from "@/lib/shell-init";
import { describePerspectiveArrowInput } from "@/lib/perspective-diagnostics";

import type { CatalogData } from "@/lib/service";
import type { TableInfo, ViewInfo } from "vgi/client";

// Imported (not just re-exported) because this module uses the type itself —
// `export type { X } from "..."` forwards the name without binding it locally,
// so the four annotations below were unresolved.
import type { QueryHistoryEntry } from "@/lib/shell-bridge";
export type { QueryHistoryEntry };

interface Props {
  serviceUrl: string;
  catalogName: string;
  /** The active top-level tab (controlled by CatalogApp's single tab bar). */
  activeTab: TabId;
  /** Switch the active top-level tab (used by bridge slots / history re-run). */
  onTabChange: (tab: TabId) => void;
  /** Notifies the parent of the query-history entry count (for the tab badge). */
  onQueryHistoryCountChange?: (count: number) => void;
  /** Notifies the parent while the Ask AI panel has a turn in flight (for the
   *  tab bar's busy dot — the panel is hidden, not unmounted, on other tabs). */
  onAiBusyChange?: (busy: boolean) => void;
  /** Called when the shell is ready, with a function to insert text into the terminal. */
  onShellReady?: (insertText: (text: string) => void) => void;
  /** Catalog metadata for AI agent tools. */
  catalogData?: CatalogData;
  /** Metadata for every additional VGI catalog attached through this shell. */
  attachedCatalogs?: CatalogData[];
  /** Current selection — used for Data Viewer tab when a table is selected. */
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

// Module imports loaded dynamically.
//
// Arrow is NOT loaded from a CDN. It used to be (apache-arrow@18.1.0), which
// put a THIRD Arrow build on the page alongside the bundled copy and the one
// vgi/client uses — three implementations exchanging Field/Table objects. The
// dictionary-aware reader below is now built from the single bundled
// @query-farm/apache-arrow instead.
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

export function DuckDBShell({ serviceUrl, catalogName, activeTab, onTabChange, onQueryHistoryCountChange, onAiBusyChange, onShellReady, catalogData, attachedCatalogs = [], selection, onAuthError, onAttachError, attachOptions }: Props) {
  useEffect(() => {
    ui.attachedCatalogs = attachedCatalogs;
    return () => { ui.attachedCatalogs = []; };
  }, [attachedCatalogs]);
  // The parent controls the active tab; expose a local alias so the existing
  // setActiveTab(...) call sites (history re-run, bridge slots) keep working.
  const setActiveTab = onTabChange;
  const rootRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const perspectiveRef = useRef<HTMLDivElement>(null);
  // Set by `ui.showPerspective` right before it switches to the Perspective
  // tab to show a specific query/shell snapshot. Consumed by the
  // sidebar-driven virtual-server auto-load effect below, on the one render
  // where that tab switch actually happens — see the effect for why.
  const perspectiveSnapshotEntryRef = useRef(false);
  const { settings } = useSettings();
  // Overlay visibility is driven by engine.bootPhase, not by external-script
  // loading. The DuckDB worker boot (downloading WASM, spinning up pthreads,
  // loading extensions, attaching) is the slow part — especially on Safari —
  // and the bridge already signals true readiness with setBootPhase(null).
  const engineLifecycle = useEngineLifecycle();
  const bootActive = engineLifecycle.status === "idle" || engineLifecycle.status === "starting" || engineLifecycle.status === "attaching";
  const [error, setError] = useState<string | null>(null);
  const displayedError = error ?? (engineLifecycle.status === "error" ? engineLifecycle.error : null);
  const cleanupRef = useRef<(() => void) | null>(null);
  // In-memory Arrow table to show in the Data Viewer tab when the user runs
  // `.preview` in the shell. Takes precedence over the selection-driven table
  // preview, and is cleared when the sidebar selection changes (see below).
  const [resultPreview, setResultPreview] = useState<ArrowTable | null>(null);
  const [queryHistory, setQueryHistory] = useState<QueryHistoryEntry[]>([]);

  // CatalogApp only mounts this component once an engine-backed tab has been
  // visited, so the heavy DuckDB WASM boot is already deferred upstream — the
  // shell is "activated" for its whole lifetime here.
  const shellActivated = true;

  // Expose query history setter for the initShell closure. Inside useEffect
  // with cleanup so React's strict-mode mount/unmount/remount doesn't leave a
  // stale closure pointing at the previous component instance's setState.
  useEffect(() => {
    ui.addQueryHistoryEntry = (entry: QueryHistoryEntry) => {
      setQueryHistory(prev => { const next = [...prev, entry]; onQueryHistoryCountChange?.(next.length); return next; });
    };
    return () => { ui.addQueryHistoryEntry = null; };
  }, [onQueryHistoryCountChange]);
  const [perspectiveLoading, setPerspectiveLoading] = useState(false);

  // Resolve selected table or view for Data Viewer and Perspective tabs
  // Search the primary, every secondary VGI worker, and the memory catalog.
  const allCatalogs = [catalogData, ...attachedCatalogs, ui.memoryCatalog]
    .filter((catalog): catalog is CatalogData => catalog !== null && catalog !== undefined);
  function findInCatalogs(type: "table", name?: string, schema?: string, catalog?: string): TableInfo | null;
  function findInCatalogs(type: "view", name?: string, schema?: string, catalog?: string): ViewInfo | null;
  function findInCatalogs(type: "table" | "view", name?: string, schema?: string, catalog?: string): TableInfo | ViewInfo | null {
    if (!name || !schema) return null;
    for (const cat of allCatalogs) {
      if (catalog && cat.catalogName !== catalog) continue;
      const resolvedSchema = cat.schemas.find((candidate) => candidate.info.name === schema);
      if (type === "table") {
        const table = resolvedSchema?.tables.find((candidate) => candidate.name === name);
        if (table) return table;
      } else {
        const view = resolvedSchema?.views.find((candidate) => candidate.name === name);
        if (view) return view;
      }
    }
    return null;
  }
  const selectedTable = selection?.type === "table" ? findInCatalogs("table", selection.name, selection.schema, selection.catalog) : null;
  const selectedView = selection?.type === "view" ? findInCatalogs("view", selection.name, selection.schema, selection.catalog) : null;
  const hasSelectedTableOrView = !!(selectedTable || selectedView || (selection && (selection.type === "table" || selection.type === "view")));

  // Expose a function to switch to the shell tab.
  useEffect(() => {
    terminal.activate = () => setActiveTab("shell");
    return () => { terminal.activate = null; };
  }, [setActiveTab]);

  // Expose a callback for the shell to trigger Perspective view
  useEffect(() => {
    ui.showPerspective = async (arrowBuffer: ArrayBuffer, context) => {
      // Mark this as an explicit snapshot open *before* switching tabs, so
      // the sidebar-driven virtual-server effect below can tell "the tab
      // switched to Perspective because of this call" apart from "the user
      // clicked the Perspective tab" — see that effect for why it matters.
      perspectiveSnapshotEntryRef.current = true;
      setActiveTab("perspective");
      setPerspectiveLoading(true);
      try {
        await loadPerspective(perspectiveRef.current!, arrowBuffer, {
          path: context?.source ?? "showPerspective",
          sql: context?.sql,
        });
      } catch (e: unknown) {
        // loadPerspective logs and captures the failure with the Arrow schema
        // and originating SQL. Keep this boundary from producing a duplicate
        // Sentry event.
      } finally {
        setPerspectiveLoading(false);
      }
    };
    return () => {
      ui.showPerspective = null;
    };
  }, [setActiveTab]);

  // Expose a callback for the shell's `.preview` command to open the last
  // query result in the Data Viewer tab. The Arrow IPC buffer is decoded
  // here and handed to DataPreview's client-side (result) pagination mode.
  useEffect(() => {
    ui.showPreview = (arrowBuffer: ArrayBuffer) => {
      try {
        setResultPreview(tableFromIPC(arrowBuffer));
        setActiveTab("preview");
      } catch (e: unknown) {
        console.error("Preview decode error:", e);
        Sentry.captureException(e, { tags: { component: "preview", path: "showPreview" } });
      }
    };
    return () => { ui.showPreview = null; };
  }, [setActiveTab]);

  // A result preview belongs to a specific query, not to the sidebar. When the
  // user navigates to a different table/view, drop it so Data Viewer falls
  // back to previewing that selection.
  useEffect(() => {
    setResultPreview(null);
  }, [selection?.type, selection?.catalog, selection?.schema, selection?.name]);

  useEffect(() => {
    if (!shellActivated) return;
    let cancelled = false;

    if (engine.lifecycleStatus === "idle") setBootPhase("Preparing local data engine");

    // Service or catalog switched — make sure any consumers awaiting the
    // previous ATTACH cycle now block on the new one.
    engine.resetAttached?.();

    (async () => {
      try {
        await loadScripts();
        if (cancelled || !containerRef.current) return;

        // Arrow is bundled; only xterm-readline still comes over the wire.
        const { Readline } = await import(/* @vite-ignore */ READLINE_CDN);
        if (cancelled || !containerRef.current) return;

        // Use the service-aware async path so we see SPA / sessionStorage
        // tokens (synchronous `getAuthToken()` only checks the URL fragment
        // and `_vgi_auth` cookie). For SPA-flow services the fragment is
        // consumed by an earlier fetchCatalog call and never seen by us.
        const shellToken = (await getAuthTokenForService(serviceUrl)) ?? getAuthToken();
        console.log("[shell] Initializing DuckDB shell, token:", shellToken ? shellToken.substring(0, 20) + "..." : "NONE");
        const { cleanup, insertText } = initShell(
          containerRef.current,
          { serviceUrl, catalogName, token: shellToken, fontSize: settings.shellFontSize, threadCount: resolveThreadCount(settings.shellThreads), catalogData, aiApiKey: settings.anthropicApiKey, aiWorkspaceId: settings.anthropicWorkspaceId, aiModel: settings.aiModel, attachOptions },
          { tableFromIPC: tableFromIPCWithDictionaries, Readline },
          { onAuthError, onAttachError }
        );
        cleanupRef.current = cleanup;
        onShellReady?.(insertText);
      } catch (e: unknown) {
        if (!cancelled) {
          const message = e instanceof Error ? e.message : "Failed to load shell";
          engine.markAttached?.();
          setEngineLifecycleError(message);
          setError(message);
        }
      }
    })();

    return () => {
      cancelled = true;
      cleanupRef.current?.();
    };
  }, [shellActivated, serviceUrl, catalogName]);

  // Refit terminal when mode changes or switching back to shell tab.
  // The ResizeObserver in shell-init.ts handles continuous reflow; this is
  // just the one-shot post-mount fit. Prior to consolidation, this used a
  // 50/150/300ms setTimeout ladder that was guessing at layout settling
  // and masked real bugs — replaced by rAF + a single 0ms tick to cover
  // the case where layout finishes after rAF on Safari.
  useEffect(() => {
    if (activeTab === "shell" && terminal.fitAddon) {
      const fitAndRefresh = () => {
        terminal.fitAddon?.fit();
        const term = terminal.term;
        if (term) term.refresh(0, term.rows - 1);
      };
      requestAnimationFrame(fitAndRefresh);
      const t = setTimeout(fitAndRefresh, 0);
      return () => { clearTimeout(t); };
    }
  }, [activeTab]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (activeTab === "shell" && terminal.fitAddon) {
        terminal.fitAddon.fit();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [activeTab]);

  // Auto-load Perspective virtual server when tab is active and a table is selected
  const perspectiveTableRef = useRef<string | null>(null);
  // Tracks the previous activeTab so the guard below can tell "the tab just
  // switched to Perspective" apart from "we were already here and the
  // sidebar selection changed" — only the former can be a snapshot open.
  const perspectivePrevTabRef = useRef<TabId | null>(null);
  useEffect(() => {
    const enteringPerspectiveTab = perspectivePrevTabRef.current !== "perspective" && activeTab === "perspective";
    perspectivePrevTabRef.current = activeTab;

    if (enteringPerspectiveTab && perspectiveSnapshotEntryRef.current) {
      // We landed on the Perspective tab because the editor's "Open in
      // Perspective" (or the shell's `.perspective`) explicitly loaded a
      // query/shell result — not because the user picked a sidebar table.
      // Selecting a table earlier while browsing elsewhere shouldn't cause
      // that snapshot to be silently swapped out for the sidebar table the
      // instant this tab becomes active. A sidebar selection made *after*
      // arriving here (handled below, since it changes `selection`) still
      // switches to the virtual server as normal.
      perspectiveSnapshotEntryRef.current = false;
      return;
    }
    perspectiveSnapshotEntryRef.current = false;

    if (activeTab !== "perspective" || !selectedTable) return;
    // Every catalog source now exposes `schema_name` (VGI wire format; the
    // memory + attached builders match it). The active selection always has it
    // as `schema`, so prefer that and fall back for safety.
    const schemaName = selection?.schema ?? selectedTable.schema_name;
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
        if (!terminal.runQuery) {
          await new Promise<void>((resolve) => {
            const onReady = () => { resolve(); window.removeEventListener("duckdb-ready", onReady); };
            window.addEventListener("duckdb-ready", onReady);
            if (terminal.runQuery) onReady();
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
            const pkIndices = new Set<number>((selectedTable.primary_key_constraints ?? []).flatMap((pk: number[]) => pk));
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
      } catch (e: unknown) {
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
  }, [activeTab, selectedTable, selection, catalogName]);

  return (
    <div ref={rootRef} className="flex flex-col h-full bg-terminal-bg">
      {/* Terminal container */}
      {bootActive && !displayedError && activeTab === "shell" && (
        <ShellBootScreen />
      )}
      {displayedError && activeTab === "shell" && (
        <div className="flex-1 flex items-center justify-center text-red-400 text-sm">
          {displayedError}
        </div>
      )}
      <div
        className={`flex-1 min-h-0 overflow-hidden relative ${(bootActive || displayedError) && activeTab === "shell" ? "hidden" : ""}`}
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
              terminal.insertText?.(text);
            }
          }
        }}
      >
        <div ref={containerRef} className="h-full w-full overflow-hidden" />
      </div>

      {/* Data Viewer — a `.preview`/editor result (client-paginated,
          in-memory) takes precedence over the selection-driven table preview.
          The key forces a clean remount when switching between the two
          sources. Shows an empty state when there's nothing to preview. */}
      {activeTab === "preview" && (
        <div className="flex-1 min-h-0 overflow-hidden bg-card">
          {resultPreview ? (
            <DataPreview key="result" result={resultPreview} />
          ) : hasSelectedTableOrView ? (
            <DataPreview
              key="table"
              tablePath={`${selection?.catalog || catalogName}.${selection?.schema || (selectedTable || selectedView)?.schema_name || "main"}.${selection?.name || (selectedTable || selectedView)?.name}`}
            />
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-center p-8">
              <Table2 className="h-8 w-8 text-muted-foreground/30 mb-3" />
              <p className="text-sm text-muted-foreground">Select a table in the sidebar, or run a query, to view it here.</p>
            </div>
          )}
        </div>
      )}

      {/* Perspective viewer */}
      <div
        ref={perspectiveRef}
        className={`flex-1 min-h-0 overflow-hidden bg-white ${activeTab !== "perspective" ? "hidden" : ""}`}
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
        className="flex-1 min-h-0 overflow-hidden"
        style={activeTab !== "askai" ? { visibility: "hidden", position: "absolute", inset: 0, zIndex: -1 } : {}}
      >
        <Suspense fallback={
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            Loading...
          </div>
        }>
          <AskAIChat
            catalogData={catalogData}
            attachedCatalogs={attachedCatalogs}
            serviceUrl={serviceUrl}
            catalogName={catalogName}
            isActive={activeTab === "askai"}
            onBusyChange={onAiBusyChange}
          />
        </Suspense>
      </div>

      {/* Query History panel */}
      {activeTab === "queries" && (() => {
        const handleRerun = (sql: string) => {
          setActiveTab("shell");
          const run = () => {
            const tryRun = () => {
              if (terminal.runQuery) {
                terminal.runQuery(sql);
              } else {
                requestAnimationFrame(tryRun);
              }
            };
            tryRun();
          };
          // If in AI mode, exit it first by simulating Ctrl+D
          if (terminal.inAiMode) {
            const term = terminal.term;
            if (term) {
              term.paste("\x04"); // Ctrl+D to exit AI mode
              // Wait for AI mode to exit, then run the query
              const waitForSql = () => {
                if (!terminal.inAiMode) {
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
                return [...groups].reverse().map((group) => {
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
          {ui.openInEditor && (
            <button
              className="p-1 text-terminal-fg/30 hover:text-terminal-accent transition-colors cursor-pointer"
              title="Open in SQL editor"
              onClick={() => ui.openInEditor?.(entry.sql)}
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
    // These paths mirror the npm package layout (<pkg>/dist/cdn/...) on
    // purpose — each bundle locates its own wasm relative to its URL, and v5
    // derives the server wasm by rewriting `client/dist/cdn` to
    // `server/dist/wasm`. Flattening them breaks that resolution with errors
    // that name the wrong file. See build-perspective.sh.
    `${origin}${base}perspective/client/dist/cdn/perspective.js`,
    `${origin}${base}perspective/viewer/dist/cdn/perspective-viewer.js`,
    `${origin}${base}perspective/viewer-datagrid/dist/cdn/perspective-viewer-datagrid.js`,
    // `viewer-charts` replaced `viewer-d3fc` in Perspective 4.5 (the new plugin
    // API, which also retired `viewer-openlayers`). Both packages were deleted
    // outright upstream, so this must not be reverted to the d3fc name: the
    // file would 404, the dynamic import would reject, and a rejected
    // `ensurePerspectiveLoaded()` takes out BOTH Perspective paths — the
    // virtual-server tab and the shell's `.perspective` command.
    `${origin}${base}perspective/viewer-charts/dist/cdn/perspective-viewer-charts.js`,
  ];
}
let perspectiveLoaded = false;
let perspectiveMod: any = null;
let perspectiveWorker: any = null;
/** Persistent virtual-server client — reused across table switches so views stay alive. */
let perspectiveClient: any = null;
/** In-memory cache of Perspective viewer configs keyed by tableId (catalog.schema.table). */
const perspectiveConfigCache = new Map<string, any>();
/** The Table most recently loaded by loadPerspective's static-snapshot path,
 *  so it can be `.delete()`d before the next one replaces it — `viewer.load`
 *  no longer takes ownership of a Table the way the deprecated `load(table)`
 *  overload implied, so nothing else frees it. */
let currentStaticPerspectiveTable: any = null;
let staticPerspectiveTableCounter = 0;

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

    // `worker()` does NOT fetch a client wasm of its own — it reads
    // `__wasm_module__` off the registered <perspective-viewer> class and
    // throws "Missing perspective-client.wasm" when that element is absent.
    //
    // The viewer bundle ends in a top-level `await init_client(fetch(...))`, so
    // awaiting its import IS enough to guarantee registration — but only when
    // that fetch succeeds. `init_client` swallows a failed load ("Stage 0 wasm
    // loading failed, skipping"), the import still resolves, and the element is
    // never defined. The result is that ANY problem fetching
    // viewer/dist/wasm/perspective-viewer.wasm surfaces here as a complaint
    // about a *client* wasm that was never the issue. If you see that error,
    // check that file's URL first.
    perspectiveWorker = await perspectiveMod.worker();
    perspectiveLoaded = true;
  }
}

export interface PerspectiveLoadContext {
  /** Which UI path handed this payload to Perspective (editor, shell, report). */
  path: string;
  /** Exact SQL which produced the payload, when the caller has it. */
  sql?: string;
}

export async function loadPerspective(
  container: HTMLElement,
  arrowBuffer: ArrayBuffer,
  context: PerspectiveLoadContext = { path: "unknown" },
) {
  // Parse once, dictionary-safely, and share it below with both diagnostics
  // and extension-column coercion — each used to parse the same buffer
  // separately (one via plain tableFromIPC, one via the dictionary-safe
  // variant), doubling the decode cost on every Perspective load. Diagnostics
  // only reads schema shape, which is identical either way. A parse failure
  // here isn't reported yet — describePerspectiveArrowInput's own try/catch
  // re-parses and reports the decode error, and a still-malformed buffer
  // surfaces through perspectiveWorker.table() below same as before.
  let parsedTable: ArrowTable | undefined;
  try {
    parsedTable = tableFromIPCWithDictionaries(arrowBuffer);
  } catch { /* see describePerspectiveArrowInput call below */ }
  const arrow = describePerspectiveArrowInput(arrowBuffer, parsedTable);

  try {
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

    // Load Arrow data. This MUST be a real copy, not a view: perspective's
    // table() may take ownership of (and detach) the buffer it is handed, and
    // the caller's buffer is the shell's cached `lastArrowBuffer`, which
    // `.preview` and a second `.perspective` still need to read.
    // `new Uint8Array(someArrayBuffer)` aliases rather than copies, so allocate
    // and set explicitly.
    //
    // DuckDB's lossless Arrow export wraps HUGEINT/UHUGEINT/oversized
    // DECIMAL/BIT/TIME_TZ/UUID in canonical Arrow extension types Perspective's
    // static loader aborts on (see perspective-extension-coerce.ts) — neutralize
    // those first. A no-op (same buffer back) for ordinary result sets.
    const coerced = coerceArrowBufferForPerspective(arrowBuffer, parsedTable);
    const copy = new Uint8Array(coerced.byteLength);
    copy.set(new Uint8Array(coerced));

    // `viewer.load(table)` is deprecated (Perspective now warns on it) in
    // favor of `viewer.load(client)` + `viewer.restore({table: name})`.
    // Loading a Table directly used to hand the viewer ownership of it, so
    // nothing here freed the *previous* one on a second `.perspective` /
    // "Open in Perspective" — under the client+name pattern that's no
    // longer implicit, so free it ourselves before creating the next.
    if (currentStaticPerspectiveTable) {
      try { await currentStaticPerspectiveTable.delete(); } catch { /* already gone */ }
      currentStaticPerspectiveTable = null;
    }
    const tableName = `cupola-static-${++staticPerspectiveTableCounter}`;
    currentStaticPerspectiveTable = await perspectiveWorker.table(copy.buffer, { name: tableName });
    await viewer.load(perspectiveWorker);

    // Perspective defaults to showing every column when no config is
    // restored, which overwhelms a wide query result — mirror the
    // virtual-server path's own no-primary-key default (`DuckDBShell.tsx`'s
    // other Perspective effect: "start with just the first column to avoid
    // overwhelming the grid") so a static snapshot starts minimal too. The
    // static path renames nothing (unlike the virtual server's `_`->`-`
    // column mapping), so the raw Arrow field name is also Perspective's
    // column name here.
    //
    // `load(client)` alone renders nothing — unlike the old `load(table)`,
    // which rendered with every column as its fallback — so a `columns`
    // restore that fails must retry with an unrestricted one rather than
    // silently leaving the viewer blank.
    //
    // `restore()` is a PARTIAL update (perspective-client's ViewConfigUpdate:
    // every field is `Option<Vec<_>>`, and an omitted key means "leave
    // unchanged", not "reset") — and this viewer element is reused across
    // unrelated queries (see "Create or reuse the viewer element" above), so
    // a sort/group-by/filter/expression left over from an *earlier* query's
    // schema silently survives onto this one. If the new query doesn't have
    // that column, Perspective's `validate_names` rejects the restore with
    // "Unknown column ... in field `sort`" (or group_by/filter/etc) even
    // though this call never mentions that field — including on the
    // unrestricted fallback below, which is why it used to fail identically.
    // Explicitly resetting every column-referencing key makes each static
    // snapshot start from a truly clean slate regardless of what a prior,
    // unrelated query left configured.
    const RESET_VIEW_CONFIG = { group_by: [], split_by: [], sort: [], filter: [], expressions: {}, windows: {}, aggregates: {} };
    const firstColumn = arrow.fields?.[0]?.name;
    try {
      await viewer.restore({ ...RESET_VIEW_CONFIG, table: tableName, columns: firstColumn ? [firstColumn] : undefined });
    } catch (restoreError: unknown) {
      console.warn("Perspective default-column restore failed, falling back to all columns:", restoreError);
      await viewer.restore({ ...RESET_VIEW_CONFIG, table: tableName });
    }
    // Opening the config panel is a nicety, not load-bearing — don't let a
    // hiccup here turn an otherwise-successful data load into a reported failure.
    try { await viewer.toggleConfig(true); } catch { /* cosmetic only */ }
  } catch (error: unknown) {
    const exception = error instanceof Error ? error : new Error(String(error));
    const diagnosticContext = { source: context.path, sql: context.sql, arrow };
    console.error("Perspective load error:", exception, diagnosticContext);
    Sentry.captureException(exception, {
      tags: { component: "perspective", path: context.path },
      extra: {
        sql: context.sql,
        arrow,
        // Preserve the complete schema in one searchable field even when
        // Sentry's nested-object normalization depth is configured shallowly.
        arrowSchemaJson: JSON.stringify(arrow.fields ?? []),
      },
    });
    throw exception;
  }
}
