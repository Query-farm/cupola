import { useEffect, useState, useMemo, useCallback, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { fetchCatalog, getServiceUrl, hasExplicitService, type CatalogData, type ResolvedSchema } from "@/lib/service";
import { fetchAttachedCatalog } from "@/lib/duckdb-catalog";
import { tableFromIPC } from "apache-arrow";
import { type Selection } from "@/lib/tree";
import { getAuthToken, getAuthTokenForService, hadAuthToken, redirectToAuth } from "@/lib/auth";
import {
  bootstrap as oauthBootstrap,
  consumePendingCallback,
  startLoginFlow,
  hasTokens as hasOAuthTokens,
} from "@/lib/oauth-client";
import { SettingsProvider } from "@/lib/settings";
import { bridge } from "@/lib/shell-bridge";
import { hashToSelection, updatePageTitle, pushSelectionToUrl } from "@/lib/navigation";
import { loadTheme, getLogoUrl, DEFAULT_LOGO, type ThemeConfig } from "@/lib/theme";
import { lazy, Suspense } from "react";
import { ErrorBoundary } from "./ErrorBoundary";
import { Header } from "./Header";
import { Sidebar } from "./Sidebar";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
const DuckDBShell = lazy(() => import("./DuckDBShell").then(m => ({ default: m.DuckDBShell })));
import type { ShellMode } from "./DuckDBShell";
import { CatalogOverview } from "./content/CatalogOverview";
import { MemoryCatalogOverview } from "./content/MemoryCatalogOverview";
import { SchemaDetail } from "./content/SchemaDetail";
import { TableDetail } from "./content/TableDetail";
import { ViewDetail } from "./content/ViewDetail";
import { FunctionDetail } from "./content/FunctionDetail";
import { MacroDetail } from "./content/MacroDetail";
import {
  getRecentServices,
  saveRecentService,
  removeRecentService,
  type RecentService,
} from "@/lib/recent-services";

export function CatalogApp() {
  const [data, setData] = useState<CatalogData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [shellMode, setShellMode] = useState<ShellMode>(() => {
    try {
      const stored = localStorage.getItem("vgi-shell-mode");
      if (stored === "minimized" || stored === "panel" || stored === "maximized" || stored === "fullscreen") return stored;
    } catch {}
    return "minimized";
  });
  const shellInsertRef = useRef<((text: string) => void) | null>(null);
  const [memoryCatalog, setMemoryCatalog] = useState<CatalogData | null>(null);
  const [attachedCatalogs, setAttachedCatalogs] = useState<CatalogData[]>([]);
  // Keep the latest attached list in a ref so syncAttachedCatalogs can diff
  // without depending on state and becoming a new callback on every change.
  const attachedCatalogsRef = useRef<CatalogData[]>([]);
  useEffect(() => { attachedCatalogsRef.current = attachedCatalogs; }, [attachedCatalogs]);
  const [logoUrl, setLogoUrl] = useState(DEFAULT_LOGO);
  const [authError, setAuthError] = useState<{ title: string; message: string } | null>(null);
  // True only after client-side hydration. We use this to gate any render
  // branch that depends on `window` state — without it the SSR output (no
  // window) and the first client render (with window) diverge and React 19
  // throws a hydration mismatch.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);


  /** Fetch in-memory DuckDB tables via the shell worker. Returns null if shell isn't running. */
  const fetchMemoryTables = useCallback(async () => {
    const queryFn = bridge.query;
    if (!queryFn) { setMemoryCatalog(null); return; }

    try {
      const result = await queryFn(
        `SELECT schema_name, table_name, column_name, data_type, CASE WHEN is_nullable = 'YES' THEN true ELSE false END as nullable
         FROM duckdb_columns()
         WHERE database_name = 'memory'
         ORDER BY schema_name, table_name, column_index`
      );
      const buf = result.arrowBuffers?.[0];
      if (!result.ok || !buf) { setMemoryCatalog(null); return; }

      const table = tableFromIPC(buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf);
      if (table.numRows === 0) {
        setMemoryCatalog({ catalogName: "memory", catalogComment: null, catalogTags: {}, defaultSchema: "main", schemas: [] });
        return;
      }

      // Fetch table comments
      const commentMap = new Map<string, string>(); // "schema.table" → comment
      const commentResult = await queryFn(
        `SELECT schema_name, table_name, comment FROM duckdb_tables() WHERE database_name = 'memory' AND comment IS NOT NULL AND comment != ''`
      );
      if (commentResult.ok && commentResult.arrowBuffers?.length) {
        const cbuf = commentResult.arrowBuffers[0];
        const ct = tableFromIPC(cbuf instanceof ArrayBuffer ? new Uint8Array(cbuf) : cbuf);
        for (let r = 0; r < ct.numRows; r++) {
          const s = String(ct.getChildAt(0)?.get(r) ?? "");
          const t = String(ct.getChildAt(1)?.get(r) ?? "");
          const c = String(ct.getChildAt(2)?.get(r) ?? "");
          if (c) commentMap.set(`${s}.${t}`, c);
        }
      }

      // Fetch view names and definitions to distinguish views from tables
      const viewDefs = new Map<string, string>(); // "schema.view" → SQL definition
      const viewResult = await queryFn(
        `SELECT schema_name, view_name, sql FROM duckdb_views() WHERE database_name = 'memory'`
      );
      if (viewResult.ok && viewResult.arrowBuffers?.length) {
        const vbuf = viewResult.arrowBuffers[0];
        const vt = tableFromIPC(vbuf instanceof ArrayBuffer ? new Uint8Array(vbuf) : vbuf);
        for (let r = 0; r < vt.numRows; r++) {
          const s = String(vt.getChildAt(0)?.get(r) ?? "");
          const v = String(vt.getChildAt(1)?.get(r) ?? "");
          const sql = String(vt.getChildAt(2)?.get(r) ?? "");
          viewDefs.set(`${s}.${v}`, sql);
        }
      }

      // Group by schema → table → columns
      const schemaMap = new Map<string, Map<string, { name: string; type: string; nullable: boolean }[]>>();
      for (let r = 0; r < table.numRows; r++) {
        const schema = String(table.getChildAt(0)?.get(r) ?? "main");
        const tbl = String(table.getChildAt(1)?.get(r) ?? "");
        const col = String(table.getChildAt(2)?.get(r) ?? "");
        const dtype = String(table.getChildAt(3)?.get(r) ?? "VARCHAR");
        const nullable = Boolean(table.getChildAt(4)?.get(r) ?? true);

        if (!schemaMap.has(schema)) schemaMap.set(schema, new Map());
        const tableMap = schemaMap.get(schema)!;
        if (!tableMap.has(tbl)) tableMap.set(tbl, []);
        tableMap.get(tbl)!.push({ name: col, type: dtype, nullable });
      }

      // Build CatalogData structure — separate tables from views
      const schemas: ResolvedSchema[] = [];
      for (const [schemaName, tableMap] of schemaMap) {
        const tables: any[] = [];
        const views: any[] = [];
        for (const [tableName, columns] of tableMap) {
          const viewKey = `${schemaName}.${tableName}`;
          const isView = viewDefs.has(viewKey);
          const entry = {
            name: tableName,
            schemaName,
            comment: commentMap.get(`${schemaName}.${tableName}`) || "",
            columns: new Uint8Array(0),
            primaryKeyConstraints: [],
            uniqueConstraints: [],
            checkConstraints: [],
            notNullConstraints: [],
            foreignKeyConstraints: [],
            ...(isView ? { definition: viewDefs.get(viewKey) || "" } : {}),
            _columnInfo: columns.map((c) => ({
              name: c.name,
              arrowType: c.type,
              duckdbType: c.type,
              nullable: c.nullable,
            })),
          };
          if (isView) {
            views.push(entry);
          } else {
            tables.push(entry);
          }
        }
        schemas.push({
          info: { name: schemaName, comment: "" } as any,
          tables,
          views,
          functions: [],
          macros: [],
        });
      }

      setMemoryCatalog({
        catalogName: "memory",
        catalogComment: null,
        catalogTags: {},
        defaultSchema: "main",
        schemas,
      });
    } catch (e) {
      console.error("Failed to fetch memory tables:", e);
      setMemoryCatalog(null);
    }
  }, []);

  /** Diff the live set of VGI-type databases in DuckDB against our rendered
   *  list, fetch any new ones via the TypeScript VGI client, drop any that
   *  were detached. Called after ATTACH/DETACH in the shell and by the
   *  refresh button. The primary (?service=) catalog is excluded — it's
   *  rendered from `data` separately. */
  const syncAttachedCatalogs = useCallback(async (): Promise<void> => {
    const queryFn = bridge.query;
    if (!queryFn) return;
    let names: string[] = [];
    try {
      const result = await queryFn(
        "SELECT database_name FROM duckdb_databases() WHERE type = 'vgi'"
      );
      if (!result.ok || !result.arrowBuffers?.length) return;
      const buf = result.arrowBuffers[0];
      const table = tableFromIPC(buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf);
      for (let r = 0; r < table.numRows; r++) {
        const name = String(table.getChildAt(0)?.get(r) ?? "");
        if (name) names.push(name);
      }
    } catch (e) {
      console.error("[catalog] duckdb_databases() query failed:", e);
      return;
    }

    // Exclude the primary catalog — it's already rendered from `data`.
    const primaryName = data?.catalogName ?? bridge.catalogName ?? null;
    if (primaryName) names = names.filter((n) => n !== primaryName);

    const current = attachedCatalogsRef.current;
    const liveNames = new Set(names);

    // Fetch the full CatalogData for every live attached catalog from
    // DuckDB introspection, always. Cheap (four metadata queries per
    // catalog, no HTTP round-trips) and always up-to-date, so we don't
    // bother caching unchanged entries.
    const fetched = await Promise.allSettled(names.map((n) => fetchAttachedCatalog(n)));
    const additions: CatalogData[] = [];
    fetched.forEach((res, i) => {
      if (res.status === "fulfilled") additions.push(res.value);
      else console.error(`[catalog] fetchAttachedCatalog(${names[i]}) failed:`, res.reason);
    });

    const dropped = current.filter((c) => !liveNames.has(c.catalogName));
    if (dropped.length) {
      console.log("[catalog] detached:", dropped.map((c) => c.catalogName).join(", "));
    }
    setAttachedCatalogs(additions);
  }, [data?.catalogName]);
  // Persist shell mode to localStorage
  useEffect(() => {
    try { localStorage.setItem("vgi-shell-mode", shellMode); } catch {}
  }, [shellMode]);

  // Expose refresh globally (navigate is exposed after it's defined below)
  if (typeof window !== "undefined") {
    bridge.refreshMemoryTables = fetchMemoryTables;
    bridge.onAttachedCatalogsChanged = syncAttachedCatalogs;
    bridge.memoryCatalog = memoryCatalog;
  }


  // Escape key exits fullscreen
  useEffect(() => {
    if (shellMode !== "fullscreen") return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShellMode("panel");
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [shellMode]);

  // Shell panel vertical resize
  const SHELL_MIN = 150;
  const SHELL_MAX = 600;
  const SHELL_DEFAULT = 300;
  const SHELL_HEIGHT_KEY = "vgi-shell-height";
  const [shellHeight, setShellHeight] = useState(() => {
    try {
      // Try new key first, then migrate from old key
      let stored = localStorage.getItem(SHELL_HEIGHT_KEY);
      if (!stored) {
        stored = localStorage.getItem("vgi-table-shell-height");
        if (stored) {
          localStorage.setItem(SHELL_HEIGHT_KEY, stored);
          localStorage.removeItem("vgi-table-shell-height");
        }
      }
      if (stored) {
        const n = parseInt(stored, 10);
        if (n >= SHELL_MIN && n <= SHELL_MAX) return n;
      }
    } catch {}
    return SHELL_DEFAULT;
  });
  const shellResizing = useRef(false);

  const onShellResizeStart = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    shellResizing.current = true;
    const startY = e.clientY;
    const startHeight = shellHeight;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);

    let rafId = 0;
    const onMove = (ev: globalThis.PointerEvent) => {
      const newHeight = Math.min(SHELL_MAX, Math.max(SHELL_MIN, startHeight - (ev.clientY - startY)));
      setShellHeight(newHeight);
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        bridge.shellFitAddon?.fit();
      });
    };
    const onUp = () => {
      shellResizing.current = false;
      cancelAnimationFrame(rafId);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      setShellHeight((h) => {
        localStorage.setItem(SHELL_HEIGHT_KEY, String(h));
        return h;
      });
      // Double-fit: once after React render, once after layout settles
      requestAnimationFrame(() => {
        bridge.shellFitAddon?.fit();
        setTimeout(() => bridge.shellFitAddon?.fit(), 50);
      });
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }, [shellHeight]);

  const serviceUrl = useMemo(() => getServiceUrl(), []);

  // Load theme from ?theme= URL parameter
  useEffect(() => {
    loadTheme().then((config) => {
      if (config?.logo) setLogoUrl(config.logo);
    });
  }, []);

  // Sidebar resize
  const SIDEBAR_MIN = 200;
  const SIDEBAR_MAX = 600;
  const SIDEBAR_DEFAULT = 288; // w-72
  const SIDEBAR_STORAGE_KEY = "vgi-sidebar-width";
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const stored = localStorage.getItem(SIDEBAR_STORAGE_KEY);
      if (stored) {
        const n = parseInt(stored, 10);
        if (n >= SIDEBAR_MIN && n <= SIDEBAR_MAX) return n;
      }
    } catch {}
    return SIDEBAR_DEFAULT;
  });
  const resizing = useRef(false);

  const onResizeStart = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    resizing.current = true;
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);

    const onMove = (ev: globalThis.PointerEvent) => {
      const newWidth = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startWidth + ev.clientX - startX));
      setSidebarWidth(newWidth);
    };
    const onUp = () => {
      resizing.current = false;
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      setSidebarWidth((w) => {
        localStorage.setItem(SIDEBAR_STORAGE_KEY, String(w));
        return w;
      });
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }, [sidebarWidth]);

  // Navigate: update selection, URL hash, and page title
  const navigate = useCallback(
    (sel: Selection | null) => {
      setSelection(sel);
      pushSelectionToUrl(sel);
      if (data) updatePageTitle(sel, data.catalogName);
    },
    [data]
  );

  // Expose navigate globally so AI agent can select newly created objects
  if (typeof window !== "undefined") {
    bridge.navigateToSelection = navigate;
  }

  const loadCatalog = useCallback(
    async (isRefresh = false) => {
      // No ?service= — don't try to fetchCatalog against cupola's own origin
      // (which would 404 on /__describe__). The render path below detects
      // "no data + no error + not loading + !hasExplicitService" and shows
      // the welcome/connect page.
      if (!hasExplicitService()) {
        setLoading(false);
        setRefreshing(false);
        return;
      }
      // Token-expired pre-check is service-scoped now that tokens live in
      // the per-service SPA store. We only pre-emptively kick off a new
      // login if we previously *had* tokens for this specific service and
      // they're gone now (e.g. tokens revoked remotely). A missing token
      // on first visit is fine — fetchCatalog will get 401 and the error
      // branch will start the login flow.
      const haveTokenNow = await getAuthTokenForService(serviceUrl);
      if (!haveTokenNow && hadAuthToken() && hasOAuthTokens(serviceUrl)) {
        console.log("[catalog] Token expired but SPA tokens existed for this service, re-auth");
        startLoginFlow(serviceUrl).catch((err) => {
          console.error("[catalog] startLoginFlow failed:", err);
          setError(err instanceof Error ? err.message : "Failed to start login");
          setLoading(false);
        });
        return;
      }
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      try {
        const catalog = await fetchCatalog(serviceUrl);
        setData(catalog);
        setError(null);
        if (hasExplicitService()) {
          saveRecentService(serviceUrl, catalog.catalogName);
        }
        if (!isRefresh) {
          // Restore selection from URL hash, or default to catalog root
          const hashSel = hashToSelection(window.location.hash);
          const defaultSchema = catalog.defaultSchema || catalog.schemas[0]?.info.name;
          const initialSel = hashSel ?? (defaultSchema
            ? { type: "schema" as const, name: defaultSchema, schema: defaultSchema }
            : { type: "catalog" as const, name: catalog.catalogName });
          setSelection(initialSel);
          updatePageTitle(initialSel, catalog.catalogName);
        }
        // Also refresh memory tables if shell is running
        if (bridge.query) {
          await fetchMemoryTables();
          // On refresh (not initial load), force every attached VGI catalog
          // to re-fetch by clearing the cache first — explicit user intent
          // to resync everything.
          if (isRefresh) {
            setAttachedCatalogs([]);
            attachedCatalogsRef.current = [];
          }
          await syncAttachedCatalogs();
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Failed to connect");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [serviceUrl, syncAttachedCatalogs]
  );

  // Process any pending SPA OAuth callback before the first catalog fetch.
  // This is the "returning from the IdP" path: oauth-callback.html stashed
  // `{code, state}` in sessionStorage and navigated us back here. We need
  // to exchange the code for tokens BEFORE loadCatalog runs — otherwise
  // the first fetchCatalog call goes out with no Authorization header and
  // triggers another OAuth redirect, creating a loop.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await consumePendingCallback();
      } catch (err) {
        // IdP returned an error (e.g. invalid_client, consent_required).
        // Surface it as a permanent error so we don't loop back into
        // startLoginFlow → same IdP error → redirect → loop.
        console.error("[catalog] consumePendingCallback threw", err);
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Authentication failed");
          setLoading(false);
          return;
        }
      }
      if (!cancelled) loadCatalog();
    })();
    return () => { cancelled = true; };
  }, [loadCatalog]);

  // BroadcastChannel listener for the *popup* OAuth flow (shell ATTACH
  // case). The main flow — top-level redirect from the homepage — is
  // handled by the consumePendingCallback path above.
  useEffect(() => {
    oauthBootstrap((result) => {
      console.log("[catalog] OAuth login complete (broadcast) for", result.serviceUrl);
      if (result.returnTo && result.returnTo !== window.location.href) {
        window.location.href = result.returnTo;
        return;
      }
      loadCatalog();
    });
  }, [loadCatalog]);

  // Listen for browser back/forward
  useEffect(() => {
    function onPopState() {
      const sel = hashToSelection(window.location.hash);
      setSelection(sel);
      if (data) updatePageTitle(sel, data.catalogName);
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [data]);

  // Auth error — start the SPA login flow (full-page redirect to the IdP).
  // Break the loop if we already tried recently so a misconfigured IdP can't
  // trap the user in an infinite redirect.
  useEffect(() => {
    if (!error) return;
    const isAuthError = error.toLowerCase().includes("auth") || error.includes("401");
    if (isAuthError) {
      const lastRedirect = Number(sessionStorage.getItem("_vgi_auth_redirect_ts") || "0");
      const now = Date.now();
      if (now - lastRedirect < 10_000) {
        console.warn("[catalog] Auth redirect loop detected — last redirect was", now - lastRedirect, "ms ago. Stopping.");
        return;
      }
      sessionStorage.setItem("_vgi_auth_redirect_ts", String(now));
      console.log("[catalog] Auth error detected, starting SPA login. error:", error);
      startLoginFlow(serviceUrl).catch((err) => {
        console.error("[catalog] startLoginFlow failed:", err);
        setError(err instanceof Error ? err.message : "Failed to start login");
      });
    }
  }, [error, serviceUrl]);

  // No ?service= — render welcome/connect page without pretending cupola
  // itself is a VGI server. Short-circuits before the "Connecting..." flash
  // and the 404 on /__describe__ that the old code used as a signal.
  //
  // Gated on `mounted` to avoid a React 19 hydration mismatch: SSR can't
  // read window.location, so hasExplicitService() is always false during
  // SSR. On the client, ?service=... makes it true. Without the gate the
  // SSR output (WelcomePage) and the first client render (loading spinner)
  // disagree. After mount we're allowed to diverge from the SSR snapshot.
  if (mounted && !hasExplicitService()) {
    return <WelcomePage logoUrl={logoUrl} />;
  }

  // Loading state
  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen text-muted-foreground">
        Connecting to service...
      </div>
    );
  }

  // Error state
  if (error) {
    const isAuthError = error.toLowerCase().includes("auth") || error.includes("401");
    const explicitService = hasExplicitService();

    // Auth redirect is in progress
    if (isAuthError) {
      return (
        <div className="flex items-center justify-center h-screen text-muted-foreground">
          Redirecting to sign in...
        </div>
      );
    }

    // No ?service= param — show a welcome / connect page
    if (!explicitService) {
      return <WelcomePage logoUrl={logoUrl} />;
    }

    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center max-w-md">
          <img
            src={logoUrl}
            alt="VGI logo"
            className="w-16 h-16 rounded-full shadow-lg mx-auto mb-6"
          />
          <h1 className="text-2xl font-bold text-primary mb-4">Connection Error</h1>
          <p className="text-muted-foreground mb-6">{error}</p>
          <p className="text-sm text-muted-foreground mb-4">
            Service URL: <code className="bg-muted px-2 py-0.5 rounded">{serviceUrl}</code>
          </p>
          <ConnectForm />
        </div>
      </div>
    );
  }

  if (!data) return null;

  return (
    <SettingsProvider>
    <div className="flex flex-col h-screen">
      {shellMode !== "fullscreen" && (
        <Header
          catalogName={data.catalogName}
          catalogComment={data.catalogComment}
          serviceUrl={serviceUrl}
          logoUrl={logoUrl}
        />
      )}
      <div className="flex flex-1 overflow-hidden">
        {shellMode !== "fullscreen" && (
          <>
            <div style={{ width: sidebarWidth, minWidth: sidebarWidth }}>
              <Sidebar
                catalog={data}
                memoryCatalog={memoryCatalog}
                attachedCatalogs={attachedCatalogs}
                selection={selection}
                onSelect={(sel) => navigate(sel)}
                onOpenShell={() => setShellMode("maximized")}
                onShellInsert={(text) => shellInsertRef.current?.(text)}
                onRefresh={() => loadCatalog(true)}
                refreshing={refreshing}
              />
            </div>
            <div
              onPointerDown={onResizeStart}
              className="w-2 -ml-1 -mr-1 z-10 cursor-col-resize group flex-shrink-0 flex items-stretch justify-center"
            >
              <div className="w-0.5 bg-border group-hover:bg-accent/60 group-active:bg-accent transition-colors" />
            </div>
          </>
        )}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Content area — hidden when shell is maximized or fullscreen */}
          <main className={`overflow-y-auto p-6 min-h-0 ${shellMode === "maximized" || shellMode === "fullscreen" ? "h-0 overflow-hidden" : "flex-1"}`}>
            <ErrorBoundary>
              <ContentPanel data={data} memoryCatalog={memoryCatalog} attachedCatalogs={attachedCatalogs} selection={selection} serviceUrl={serviceUrl} onNavigate={navigate} onOpenShell={() => setShellMode((m) => m === "minimized" ? "panel" : m)} shellMode={shellMode} />
            </ErrorBoundary>
          </main>

          {/* Resize handle — only in panel mode */}
          {shellMode === "panel" && (
            <div
              onPointerDown={onShellResizeStart}
              className="h-2 z-10 cursor-row-resize group flex-shrink-0 flex items-center justify-center bg-muted-foreground/20 hover:bg-muted-foreground/30 active:bg-muted-foreground/40 transition-colors"
            >
              <div className="flex gap-1 items-center">
                <div className="h-0.5 w-8 rounded-full bg-muted-foreground/50 group-hover:bg-muted-foreground/70 transition-colors" />
                <div className="h-0.5 w-2 rounded-full bg-muted-foreground/40 group-hover:bg-muted-foreground/60 transition-colors" />
                <div className="h-0.5 w-2 rounded-full bg-muted-foreground/40 group-hover:bg-muted-foreground/60 transition-colors" />
              </div>
            </div>
          )}

          {/* Shell panel — always rendered */}
          <ErrorBoundary>
            <Suspense fallback={
              <div style={{ height: shellMode === "minimized" ? 36 : shellMode === "panel" ? shellHeight : undefined }}
                   className={`flex items-center justify-center bg-terminal-bg text-terminal-accent shrink-0 border-t border-border ${shellMode === "maximized" || shellMode === "fullscreen" ? "flex-1" : ""}`}>
                {shellMode !== "minimized" && "Loading..."}
              </div>
            }>
              <div
                className={`shrink-0 border-t border-border overflow-hidden ${shellMode === "maximized" || shellMode === "fullscreen" ? "flex-1" : ""}`}
                style={
                  shellMode === "panel"
                    ? { height: shellHeight }
                    : shellMode === "minimized"
                    ? { height: 36 }
                    : undefined
                }
              >
                <DuckDBShell
                  serviceUrl={serviceUrl}
                  catalogName={data.catalogName}
                  mode={shellMode}
                  onModeChange={setShellMode}
                  onShellReady={(insert) => { shellInsertRef.current = insert; fetchMemoryTables(); syncAttachedCatalogs(); }}
                  catalogData={data}
                  selection={selection}
                  onAuthError={(title, message) => setAuthError({ title, message })}
                />
              </div>
            </Suspense>
          </ErrorBoundary>
        </div>
      </div>
    </div>
    <Dialog open={!!authError} onOpenChange={(open) => { if (!open) setAuthError(null); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{authError?.title ?? "Authentication error"}</DialogTitle>
          <DialogDescription>
            The identity provider rejected the credentials. Retrying the auth flow would hit
            the same error — fix the underlying issue (app registration, scopes, redirect URI)
            before trying again.
          </DialogDescription>
        </DialogHeader>
        <pre className="text-xs bg-muted p-3 rounded-md overflow-auto max-h-96 whitespace-pre-wrap font-mono">
          {authError?.message}
        </pre>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              if (authError?.message) navigator.clipboard?.writeText(authError.message).catch(() => {});
            }}
          >
            Copy
          </Button>
          <Button onClick={() => setAuthError(null)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </SettingsProvider>
  );
}

/** Small form to enter a service URL — used on both the welcome page and the explicit-service error page. */
function ConnectForm() {
  const [url, setUrl] = useState("");
  const connect = () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    const dest = new URL(window.location.href);
    dest.searchParams.set("service", trimmed);
    window.location.href = dest.toString();
  };
  return (
    <div className="flex gap-2 max-w-md mx-auto">
      <input
        type="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && connect()}
        placeholder="https://my-server.example.com"
        className="flex-1 px-3 py-2 rounded-md border border-input bg-card text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      />
      <button
        onClick={connect}
        className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-accent transition-colors"
      >
        Connect
      </button>
    </div>
  );
}

/** Welcome page shown when no ?service= parameter is provided. */
function WelcomePage({ logoUrl }: { logoUrl: string }) {
  // Both recent services (from localStorage) and window.location.origin are
  // client-only state. Initialize empty for SSR so the server-rendered HTML
  // matches the first client render, then populate via useEffect after
  // hydration. Without this, React #418 fires due to SSR/client mismatch.
  const [recent, setRecent] = useState<RecentService[]>([]);
  const [origin, setOrigin] = useState("");
  useEffect(() => {
    setRecent(getRecentServices());
    setOrigin(window.location.origin);
  }, []);

  const handleRemove = (url: string) => {
    removeRecentService(url);
    setRecent(getRecentServices());
  };

  const connectTo = (url: string) => {
    const dest = new URL(window.location.href);
    dest.searchParams.set("service", url);
    window.location.href = dest.toString();
  };

  return (
    <div className="flex items-center justify-center min-h-screen py-12">
      <div className="max-w-xl w-full px-6">
        <div className="flex items-center gap-8 mb-8">
          <img
            src={logoUrl}
            alt="VGI logo"
            className="w-40 h-40 rounded-full shadow-lg shrink-0"
          />
          <div>
            <h1 className="text-3xl font-bold text-primary mb-2">
              Cupola
            </h1>
            <p className="text-muted-foreground">
              Connect to a VGI server to browse schemas, tables, views, and functions.
            </p>
          </div>
        </div>

        <div className="bg-card rounded-lg border border-border p-6 mb-6">
          <h2 className="text-sm font-semibold text-foreground mb-3">Connect to a VGI service</h2>
          <ConnectForm />
        </div>

        {recent.length > 0 && (
          <div className="bg-card rounded-lg border border-border p-6 mb-6">
            <h2 className="text-sm font-semibold text-foreground mb-3">Recent servers</h2>
            <ul className="space-y-2">
              {recent.map((s) => (
                <li key={s.url} className="flex items-center gap-2 group">
                  <button
                    onClick={() => connectTo(s.url)}
                    className="flex-1 text-left px-3 py-2 rounded-md hover:bg-muted transition-colors min-w-0"
                  >
                    <span className="block text-sm font-medium text-primary truncate">{s.catalogName}</span>
                    <span className="block text-xs text-muted-foreground truncate">{s.url}</span>
                  </button>
                  <button
                    onClick={() => handleRemove(s.url)}
                    className="opacity-0 group-hover:opacity-100 p-1 text-muted-foreground hover:text-destructive transition-all shrink-0"
                    title="Remove"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="bg-card rounded-lg border border-border p-6">
          <h2 className="text-sm font-semibold text-foreground mb-3">How it works</h2>
          <p className="text-sm text-muted-foreground mb-3">
            VGI servers redirect browsers here with a <code className="bg-muted px-1.5 py-0.5 rounded text-xs">?service=</code> URL
            parameter. You can also enter a service URL above, or bookmark a direct link:
          </p>
          <code className="block text-xs bg-muted text-muted-foreground px-3 py-2 rounded overflow-x-auto">
            {origin}/?service=https://your-server.example.com
          </code>
        </div>

        <div className="text-center text-xs text-muted-foreground mt-8 space-y-1">
          <p>&copy; 2026 &#x1F69C; <a href="https://query.farm" className="hover:text-primary transition-colors">Query.Farm LLC</a></p>
          <p>v{__APP_VERSION__} ({__GIT_HASH__})</p>
        </div>
      </div>
    </div>
  );
}

function ContentPanel({
  data,
  memoryCatalog,
  attachedCatalogs,
  selection,
  serviceUrl,
  onNavigate,
  onOpenShell,
  shellMode,
}: {
  data: CatalogData;
  memoryCatalog?: CatalogData | null;
  attachedCatalogs?: CatalogData[];
  selection: Selection | null;
  serviceUrl: string;
  onNavigate: (selection: Selection) => void;
  onOpenShell?: () => void;
  shellMode?: string;
}) {
  if (!selection || selection.type === "catalog") {
    if (selection?.catalog && memoryCatalog && selection.catalog === memoryCatalog.catalogName) {
      return <MemoryCatalogOverview catalog={memoryCatalog} onNavigate={onNavigate} />;
    }
    const attached = selection?.catalog && attachedCatalogs?.find((c) => c.catalogName === selection.catalog);
    if (attached) {
      return <CatalogOverview catalog={attached} serviceUrl={serviceUrl} onNavigate={onNavigate} />;
    }
    return <CatalogOverview catalog={data} serviceUrl={serviceUrl} onNavigate={onNavigate} />;
  }

  // Determine which catalog to search
  const catalog = (selection.catalog && memoryCatalog && selection.catalog === memoryCatalog.catalogName)
    ? memoryCatalog
    : (selection.catalog && attachedCatalogs?.find((c) => c.catalogName === selection.catalog))
      ?? data;

  const schema = catalog.schemas.find((s) => s.info.name === selection.schema);
  if (!schema) return <CatalogOverview catalog={data} serviceUrl={serviceUrl} onNavigate={onNavigate} />;

  if (selection.type === "schema") {
    return <SchemaDetail schema={schema} onNavigate={onNavigate} catalogName={catalog.catalogName} onOpenShell={onOpenShell} />;
  }

  if (selection.type === "table") {
    const table = schema.tables.find((t) => t.name === selection.name);
    if (table) return <TableDetail table={table} catalogName={catalog.catalogName} onNavigate={onNavigate} onOpenShell={onOpenShell} shellMode={shellMode} />;
  }

  if (selection.type === "view") {
    const view = schema.views.find((v) => v.name === selection.name);
    if (view) return <ViewDetail view={view} catalogName={catalog.catalogName} schemaName={selection.schema} onNavigate={onNavigate} />;
  }

  if (selection.type === "function") {
    const func = schema.functions.find((f) => f.name === selection.name);
    if (func) return <FunctionDetail func={func} catalogName={catalog.catalogName} schemaName={selection.schema} onNavigate={onNavigate} />;
  }

  if (selection.type === "macro") {
    const macro = schema.macros?.find((m) => m.name === selection.name);
    if (macro) return <MacroDetail macro={macro} catalogName={catalog.catalogName} schemaName={selection.schema} onNavigate={onNavigate} />;
  }

  return <CatalogOverview catalog={data} serviceUrl={serviceUrl} onNavigate={onNavigate} />;
}
