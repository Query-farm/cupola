import { useEffect, useState, useMemo, useCallback, useRef, forwardRef, useImperativeHandle, type PointerEvent as ReactPointerEvent } from "react";
import { fetchCatalog, type CatalogData, type ResolvedSchema } from "@/lib/service";
import { getServiceUrl, getAttachOptionsFromUrl, getDataVersionSpecFromUrl, hasExplicitService, consumePrefillFromHash } from "@/lib/url-params";
import { fetchAttachedCatalog } from "@/lib/duckdb-catalog";
import { readRows } from "@/lib/duckdb-query";
import { type Selection } from "@/lib/tree";
import { getAuthToken, getAuthTokenForService, getUserInfo, hadAuthToken, redirectToAuth } from "@/lib/auth";
import * as Sentry from "@sentry/astro";
import {
  bootstrap as oauthBootstrap,
  consumePendingCallback,
  startLoginFlow,
  hasTokens as hasOAuthTokens,
} from "@/lib/oauth-client";
import { SettingsProvider } from "@/lib/settings";
import { bridge, setShellWorkerSentryUser } from "@/lib/shell-bridge";
import { hashToSelection, updatePageTitle, pushSelectionToUrl } from "@/lib/navigation";
import { loadTheme, getLogoUrl, DEFAULT_LOGO, type ThemeConfig } from "@/lib/theme";
import { lazy, Suspense } from "react";
import { ErrorBoundary } from "./ErrorBoundary";
import { Header } from "./Header";
import { BrandMark } from "./BrandMark";
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
const SqlEditorView = lazy(() => import("./editor/SqlEditorView").then(m => ({ default: m.SqlEditorView })));
import { AppTabBar, type TabId } from "./AppTabBar";
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
  getAttachOptionsFor,
  type RecentService,
} from "@/lib/recent-services";

/** A recoverable auth error: one the SPA login redirect (below) handles by
 *  bouncing the user back through the IdP. These happen routinely (expired
 *  token) and are deliberately NOT reported to Sentry. Hard failures (e.g.
 *  "token exchange failed", connection errors) don't match and ARE reported. */
function isRecoverableAuthMessage(message: string): boolean {
  return message.toLowerCase().includes("auth") || message.includes("401");
}

export function CatalogApp() {
  const [data, setData] = useState<CatalogData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const shellInsertRef = useRef<((text: string) => void) | null>(null);
  // The single source of truth for which top-level surface is showing. Replaces
  // the old appView toggle + shell-drawer mode. Persisted (migrating the old
  // vgi-app-view key) so a reload returns to the same tab.
  const [activeTab, setActiveTab] = useState<TabId>(() => {
    try {
      const stored = localStorage.getItem("vgi-active-tab") as TabId | null;
      if (stored && ["catalog", "editor", "shell", "askai", "preview", "queries", "perspective"].includes(stored)) return stored;
      if (localStorage.getItem("vgi-app-view") === "editor") return "editor";
    } catch {}
    return "catalog";
  });
  // Collapsible catalog sidebar (persisted).
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem("vgi-sidebar-collapsed") === "1"; } catch { return false; }
  });
  const [queryHistoryCount, setQueryHistoryCount] = useState(0);
  // The engine host (shell/askai/preview/queries/perspective) is mounted for
  // the whole session — hidden behind the catalog/editor when not active — so
  // (a) DuckDB boots + ATTACHes once (column stats, previews work on the
  // catalog tab), and (b) terminal / chat / perspective state survives tab
  // switches. It's visible only on an engine-backed tab.
  const engineVisible = activeTab !== "catalog" && activeTab !== "editor";
  // SQL pushed into the editor from elsewhere (example queries, shell history).
  const [pendingEditorSql, setPendingEditorSql] = useState<string | null>(null);
  const [memoryCatalog, setMemoryCatalog] = useState<CatalogData | null>(null);
  const [attachedCatalogs, setAttachedCatalogs] = useState<CatalogData[]>([]);
  // Keep the latest attached list in a ref so syncAttachedCatalogs can diff
  // without depending on state and becoming a new callback on every change.
  const attachedCatalogsRef = useRef<CatalogData[]>([]);
  useEffect(() => { attachedCatalogsRef.current = attachedCatalogs; }, [attachedCatalogs]);
  // Track catalogName in a ref so syncAttachedCatalogs doesn't depend on
  // `data` state — otherwise setData() inside loadCatalog recreates the
  // callback chain and the mount effect fires a second loadCatalog().
  const catalogNameRef = useRef<string | undefined>(undefined);
  useEffect(() => { catalogNameRef.current = data?.catalogName; }, [data?.catalogName]);
  const [logoUrl, setLogoUrl] = useState(DEFAULT_LOGO);
  const [authError, setAuthError] = useState<{ title: string; message: string } | null>(null);
  const [attachError, setAttachError] = useState<{ title: string; message: string } | null>(null);
  // True only after client-side hydration. We use this to gate any render
  // branch that depends on `window` state — without it the SSR output (no
  // window) and the first client render (with window) diverge and React 19
  // throws a hydration mismatch.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);


  /** Fetch in-memory DuckDB tables via the shell worker. Returns null if shell isn't running. */
  const fetchMemoryTables = useCallback(async () => {
    if (!bridge.query) { setMemoryCatalog(null); return; }

    try {
      const colRows = await readRows(
        `SELECT schema_name, table_name, column_name, data_type, comment, CASE WHEN is_nullable = 'YES' THEN true ELSE false END as nullable
         FROM duckdb_columns()
         WHERE database_name = 'memory'
         ORDER BY schema_name, table_name, column_index`
      );
      if (colRows === null) { setMemoryCatalog(null); return; }
      if (colRows.length === 0) {
        setMemoryCatalog({ catalogName: "memory", catalogComment: null, catalogTags: {}, defaultSchema: "main", schemas: [] });
        return;
      }

      // Fetch table comments
      const commentMap = new Map<string, string>(); // "schema.table" → comment
      const commentRows = await readRows(
        `SELECT schema_name, table_name, comment FROM duckdb_tables() WHERE database_name = 'memory' AND comment IS NOT NULL AND comment != ''`
      );
      for (const row of commentRows ?? []) {
        const c = String(row.comment ?? "");
        if (c) commentMap.set(`${row.schema_name ?? ""}.${row.table_name ?? ""}`, c);
      }

      // Fetch view names and definitions to distinguish views from tables
      const viewDefs = new Map<string, string>(); // "schema.view" → SQL definition
      const viewRows = await readRows(
        `SELECT schema_name, view_name, sql FROM duckdb_views() WHERE database_name = 'memory'`
      );
      for (const row of viewRows ?? []) {
        viewDefs.set(`${row.schema_name ?? ""}.${row.view_name ?? ""}`, String(row.sql ?? ""));
      }

      // Group by schema → table → columns
      const schemaMap = new Map<string, Map<string, { name: string; type: string; nullable: boolean; comment?: string }[]>>();
      for (const row of colRows) {
        const schema = String(row.schema_name ?? "main");
        const tbl = String(row.table_name ?? "");
        const col = String(row.column_name ?? "");
        const dtype = String(row.data_type ?? "VARCHAR");
        const nullable = Boolean(row.nullable ?? true);
        const comment = row.comment ? String(row.comment) : undefined;

        if (!schemaMap.has(schema)) schemaMap.set(schema, new Map());
        const tableMap = schemaMap.get(schema)!;
        if (!tableMap.has(tbl)) tableMap.set(tbl, []);
        tableMap.get(tbl)!.push({ name: col, type: dtype, nullable, comment });
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
            schema_name: schemaName,
            tags: {},
            comment: commentMap.get(`${schemaName}.${tableName}`) || "",
            columns: new Uint8Array(0),
            primary_key_constraints: [],
            unique_constraints: [],
            check_constraints: [],
            not_null_constraints: [],
            foreign_key_constraints: [],
            ...(isView ? { definition: viewDefs.get(viewKey) || "" } : {}),
            _columnInfo: columns.map((c) => ({
              name: c.name,
              arrowType: c.type,
              duckdbType: c.type,
              nullable: c.nullable,
              comment: c.comment,
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
    if (!bridge.query) return;
    let names: string[] = [];
    try {
      const rows = await readRows(
        "SELECT database_name FROM duckdb_databases() WHERE type = 'vgi'"
      );
      if (rows === null) return;
      for (const row of rows) {
        const name = String(row.database_name ?? "");
        if (name) names.push(name);
      }
    } catch (e) {
      console.error("[catalog] duckdb_databases() query failed:", e);
      return;
    }

    // Exclude the primary catalog — it's already rendered from `data`.
    const primaryName = catalogNameRef.current ?? bridge.catalogName ?? null;
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
  }, []);
  // Persist the active tab.
  useEffect(() => {
    try { localStorage.setItem("vgi-active-tab", activeTab); } catch {}
  }, [activeTab]);

  // Persist sidebar collapse.
  useEffect(() => {
    try { localStorage.setItem("vgi-sidebar-collapsed", sidebarCollapsed ? "1" : "0"); } catch {}
  }, [sidebarCollapsed]);

  // bridge.openInEditor: switch to the editor tab and queue the SQL.
  // Invoked by ExampleQueries' Run button and the shell's history tab.
  useEffect(() => {
    bridge.openInEditor = (sql: string) => {
      setPendingEditorSql(sql);
      setActiveTab("editor");
    };
    return () => { bridge.openInEditor = null; };
  }, []);

  // Expose refresh globally (navigate is exposed after it's defined below).
  // useEffect + cleanup so unmount clears the slots instead of leaking the
  // previous component instance's closures.
  useEffect(() => {
    bridge.refreshMemoryTables = fetchMemoryTables;
    bridge.onAttachedCatalogsChanged = syncAttachedCatalogs;
    bridge.memoryCatalog = memoryCatalog;
    return () => {
      bridge.refreshMemoryTables = null;
      bridge.onAttachedCatalogsChanged = null;
      bridge.memoryCatalog = null;
    };
  }, [fetchMemoryTables, syncAttachedCatalogs, memoryCatalog]);


  // Refit the terminal when the shell tab becomes active (it may have been
  // hidden/zero-sized while another tab was showing).
  useEffect(() => {
    if (activeTab !== "shell") return;
    requestAnimationFrame(() => {
      bridge.shellFitAddon?.fit();
      setTimeout(() => bridge.shellFitAddon?.fit(), 50);
    });
  }, [activeTab]);

  const serviceUrl = useMemo(() => getServiceUrl(), []);
  // `?attach_options=` URL param wins over the localStorage value and is
  // persisted so a future visit without the param keeps the same options.
  // An explicit empty value clears them.
  const attachOptions = useMemo(() => {
    const fromUrl = getAttachOptionsFromUrl();
    let base: string | undefined;
    if (fromUrl !== undefined && hasExplicitService()) {
      saveRecentService(serviceUrl, "", fromUrl);
      base = fromUrl || undefined;
    } else {
      base = getAttachOptionsFor(serviceUrl);
    }
    // `?data_version_spec=` pins the catalog's data version at ATTACH time
    // (the VGI extension reads a `data_version_spec` ATTACH option). The worker
    // landing page emits it when a user selects a non-latest version.
    const dvs = getDataVersionSpecFromUrl();
    if (dvs) {
      const opt = `data_version_spec '${dvs.replace(/'/g, "''")}'`;
      return base ? `${base}, ${opt}` : opt;
    }
    return base;
  }, [serviceUrl]);

  // Tag every Sentry event with the service URL and (when known) the catalog
  // name. Lets us slice errors by tenant without putting URLs in messages.
  useEffect(() => {
    Sentry.setTag("service", serviceUrl);
  }, [serviceUrl]);
  useEffect(() => {
    if (data?.catalogName) Sentry.setTag("catalog", data.catalogName);
  }, [data?.catalogName]);

  // Identify the signed-in user once tokens are available. JWT decode is
  // synchronous; re-run when the service URL or catalog changes (post-login).
  // Also forward the identity to the shell worker so its Sentry isolate
  // tags every query span with the same user. We deliberately do NOT push a
  // catalog tag to the worker — a single SQL statement can join across the
  // primary catalog and any number of ATTACHed VGI catalogs, so a single
  // catalog tag would be misleading. The per-span db.statement attribute
  // already lets you trace which catalogs a query touched.
  useEffect(() => {
    const info = getUserInfo(serviceUrl);
    if (info?.email || info?.sub) {
      const user = { id: info.sub, email: info.email, username: info.name };
      Sentry.setUser(user);
      setShellWorkerSentryUser(user);
    } else {
      Sentry.setUser(null);
      setShellWorkerSentryUser(null);
    }
  }, [serviceUrl, data?.catalogName]);

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

  // Expose navigate globally so AI agent can select newly created objects.
  // useEffect + cleanup so unmount drops the stale callback.
  useEffect(() => {
    bridge.navigateToSelection = navigate;
    return () => { bridge.navigateToSelection = null; };
  }, [navigate]);

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
        catalogNameRef.current = catalog.catalogName;
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
        const message = err instanceof Error ? err.message : "Failed to connect";
        // Report connection errors and hard auth failures. Recoverable auth
        // errors (handled by the SPA login redirect below) are routine, so
        // we skip them to keep the dashboard signal clean.
        if (!isRecoverableAuthMessage(message)) {
          Sentry.captureException(err instanceof Error ? err : new Error(message), {
            tags: { component: "catalog", path: "load" },
            extra: { serviceUrl },
          });
        }
        setError(message);
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
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
          tags: { component: "auth", path: "oauth-callback" },
          extra: { serviceUrl },
        });
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
    if (isRecoverableAuthMessage(error)) {
      const lastRedirect = Number(sessionStorage.getItem("_vgi_auth_redirect_ts") || "0");
      const now = Date.now();
      if (now - lastRedirect < 10_000) {
        console.warn("[catalog] Auth redirect loop detected — last redirect was", now - lastRedirect, "ms ago. Stopping.");
        // A stuck user (re-auth loop) is a genuine hard failure worth surfacing —
        // it's no longer a "routine redirect".
        Sentry.captureMessage("Auth redirect loop detected", {
          level: "warning",
          tags: { component: "auth", path: "redirect-loop" },
          extra: { serviceUrl, sinceLastRedirectMs: now - lastRedirect },
        });
        return;
      }
      sessionStorage.setItem("_vgi_auth_redirect_ts", String(now));
      console.log("[catalog] Auth error detected, starting SPA login. error:", error);
      startLoginFlow(serviceUrl).catch((err) => {
        console.error("[catalog] startLoginFlow failed:", err);
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
          tags: { component: "auth", path: "start-login" },
          extra: { serviceUrl },
        });
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

  // Loading state — animated connect screen with brand chrome so the user
  // sees the page is alive while the catalog round-trip is in flight.
  if (loading) {
    return <ConnectingScreen logoUrl={logoUrl} serviceUrl={serviceUrl} />;
  }

  // Error state
  if (error) {
    const isAuthError = error.toLowerCase().includes("auth") || error.includes("401");
    const explicitService = hasExplicitService();

    // Auth redirect is in progress
    if (isAuthError) {
      return <ConnectingScreen logoUrl={logoUrl} serviceUrl={serviceUrl} message="Redirecting to sign in" />;
    }

    // No ?service= param — show a welcome / connect page
    if (!explicitService) {
      return <WelcomePage logoUrl={logoUrl} />;
    }

    return <ErrorScreen logoUrl={logoUrl} serviceUrl={serviceUrl} error={error} />;
  }

  if (!data) return null;

  return (
    <SettingsProvider>
    <div className="flex flex-col h-screen">
      <Header
        catalogName={data.catalogName}
        catalogComment={data.catalogComment}
        serviceUrl={serviceUrl}
      />
      <AppTabBar
        activeTab={activeTab}
        onSelect={setActiveTab}
        queryHistoryCount={queryHistoryCount}
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={() => setSidebarCollapsed((c) => !c)}
      />
      <div className="flex flex-1 overflow-hidden">
        {!sidebarCollapsed && (
          <>
            <div style={{ width: sidebarWidth, minWidth: sidebarWidth }}>
              <Sidebar
                catalog={data}
                memoryCatalog={memoryCatalog}
                attachedCatalogs={attachedCatalogs}
                selection={selection}
                onSelect={(sel) => navigate(sel)}
                onOpenShell={() => setActiveTab("shell")}
                onShellInsert={(text) => {
                  // In editor mode, route table/column clicks into the SQL
                  // editor at the cursor; otherwise into the xterm shell.
                  if (activeTab === "editor" && bridge.insertIntoEditor) {
                    bridge.insertIntoEditor(text);
                  } else {
                    shellInsertRef.current?.(text);
                  }
                }}
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
        {/* Content area — one tab visible at a time. Catalog & Editor are
            conditionally rendered; the engine host (shell/askai/preview/
            queries/perspective) is mounted once activated and kept sized via
            visibility (so the xterm terminal survives tab switches). */}
        <div className="flex-1 relative overflow-hidden">
          {activeTab === "catalog" && (
            <main className="absolute inset-0 overflow-y-auto p-6">
              <ErrorBoundary>
                <ContentPanel data={data} memoryCatalog={memoryCatalog} attachedCatalogs={attachedCatalogs} selection={selection} serviceUrl={serviceUrl} attachOptions={attachOptions} onNavigate={navigate} onOpenShell={() => setActiveTab("shell")} />
              </ErrorBoundary>
            </main>
          )}
          {activeTab === "editor" && (
            <div className="absolute inset-0 overflow-hidden">
              <ErrorBoundary>
                <Suspense fallback={<div className="flex items-center justify-center h-full text-muted-foreground text-sm">Loading editor…</div>}>
                  <SqlEditorView
                    catalogData={data}
                    serviceUrl={serviceUrl}
                    onExitEditor={() => setActiveTab("catalog")}
                    pendingSql={pendingEditorSql}
                    onPendingConsumed={() => setPendingEditorSql(null)}
                  />
                </Suspense>
              </ErrorBoundary>
            </div>
          )}
          {(
            <div
              className="absolute inset-0 overflow-hidden"
              style={engineVisible ? undefined : { visibility: "hidden", zIndex: -1 }}
            >
              <ErrorBoundary>
                <Suspense fallback={
                  <div className="flex items-center justify-center h-full bg-terminal-bg text-terminal-accent text-sm">Loading…</div>
                }>
                  <DuckDBShell
                    serviceUrl={serviceUrl}
                    catalogName={data.catalogName}
                    activeTab={activeTab}
                    onTabChange={setActiveTab}
                    onQueryHistoryCountChange={setQueryHistoryCount}
                    onShellReady={(insert) => { shellInsertRef.current = insert; fetchMemoryTables(); syncAttachedCatalogs(); }}
                    catalogData={data}
                    selection={selection}
                    onAuthError={(title, message) => setAuthError({ title, message })}
                    onAttachError={(title, message) => setAttachError({ title, message })}
                    attachOptions={attachOptions}
                  />
                </Suspense>
              </ErrorBoundary>
            </div>
          )}
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
    <Dialog open={!!attachError} onOpenChange={(open) => { if (!open) setAttachError(null); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{attachError?.title ?? "Connection failed"}</DialogTitle>
          <DialogDescription>
            DuckDB rejected the ATTACH statement. This is usually a malformed
            or unrecognized entry in the connection options for this server.
          </DialogDescription>
        </DialogHeader>
        {attachOptions && (
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">
              Current connection options
            </div>
            <pre className="text-xs bg-muted p-3 rounded-md overflow-auto whitespace-pre-wrap font-mono">
              {attachOptions}
            </pre>
          </div>
        )}
        <pre className="text-xs bg-muted p-3 rounded-md overflow-auto max-h-96 whitespace-pre-wrap font-mono">
          {attachError?.message}
        </pre>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              if (attachError?.message) navigator.clipboard?.writeText(attachError.message).catch(() => {});
            }}
          >
            Copy
          </Button>
          <Button
            onClick={() => {
              const dest = new URL(window.location.href);
              dest.searchParams.delete("service");
              dest.hash = `#prefill=${encodeURIComponent(serviceUrl)}`;
              window.location.href = dest.toString();
            }}
          >
            Edit connection options
          </Button>
          <Button variant="ghost" onClick={() => setAttachError(null)}>Dismiss</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </SettingsProvider>
  );
}

/** Small form to enter a service URL — used on both the welcome page and the explicit-service error page.
 *
 * Imperative handle lets parents (e.g. the recent-services list on the welcome
 * page) prefill the URL/options fields without navigating, so users coming
 * back via the "Edit connection options" modal land on a populated form.
 */
export interface ConnectFormHandle {
  prefill: (url: string) => void;
}

const ConnectForm = forwardRef<ConnectFormHandle>(function ConnectForm(_, ref) {
  const [url, setUrl] = useState("");
  const [options, setOptions] = useState("");

  // Apply ?#prefill=<url> hash on mount — used by the attach-error modal's
  // "Edit connection options" button to bring the user back to a populated
  // form without invoking ?service= (which would auto-connect).
  useEffect(() => {
    const target = consumePrefillFromHash();
    if (target) {
      const found = getRecentServices().find((s) => s.url === target);
      if (found) {
        setUrl(found.url);
        setOptions(found.attachOptions ?? "");
      } else {
        setUrl(target);
      }
    }
  }, []);

  useImperativeHandle(ref, () => ({
    prefill: (target: string) => {
      const found = getRecentServices().find((s) => s.url === target);
      setUrl(target);
      setOptions(found?.attachOptions ?? "");
    },
  }), []);

  const connect = () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    const optsTrimmed = options.trim();
    // Persist options (and clear them when blank) before redirect so the
    // shell can pick them up via getAttachOptionsFor on the next page load.
    saveRecentService(trimmed, "", optsTrimmed);
    const dest = new URL(window.location.href);
    dest.searchParams.set("service", trimmed);
    dest.hash = "";
    window.location.href = dest.toString();
  };
  return (
    <div className="flex flex-col gap-2 max-w-md mx-auto">
      <div className="flex gap-2">
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
          className="px-4 py-2 rounded-md bg-harvest-500 text-white text-sm font-semibold hover:bg-harvest-600 transition-colors"
        >
          Connect
        </button>
      </div>
      <details className="group">
        <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground select-none">
          Connection options (optional)
        </summary>
        <textarea
          value={options}
          onChange={(e) => setOptions(e.target.value)}
          placeholder="e.g. opt_string 'hello', opt_int64 42, opt_bool true"
          rows={3}
          spellCheck={false}
          className="mt-2 w-full px-3 py-2 rounded-md border border-input bg-card text-foreground text-xs font-mono focus:outline-none focus:ring-2 focus:ring-ring resize-y"
        />
        <p className="mt-1 text-[11px] text-muted-foreground">
          Spliced into the <code className="font-mono">ATTACH</code> statement after <code className="font-mono">LOCATION</code>. Comma-separate entries.
        </p>
      </details>
    </div>
  );
});

/**
 * Shared chrome for full-page non-app screens (welcome, connecting,
 * error). Slim sticky header with the Query.Farm wordmark + soft earth
 * gradient backdrop. Per the brand review: no tractor emoji in the
 * chrome (the wordmark alone carries it); muted color so the
 * per-deployment VGI logo remains the visual focus.
 */
function BrandShell({ children }: { children: React.ReactNode }) {
  return (
    // h-screen + overflow-y-auto (not min-h-screen): the global <body> is
    // overflow-hidden for the catalog app's fixed panes, so these brand
    // surfaces must be their own bounded scroll container or tall content
    // (welcome form + recents + footer) gets clipped with no way to scroll.
    <div className="flex flex-col h-screen overflow-y-auto bg-gradient-to-b from-soil-50 via-earth-50 to-soil-100 dark:from-background dark:via-background dark:to-soil-900/30">
      <header className="sticky top-0 z-40 shrink-0 flex items-center px-4 h-14 border-b border-border bg-card/95 backdrop-blur-sm shadow-sm">
        <BrandMark />
      </header>
      {children}
    </div>
  );
}

/**
 * Connecting / redirecting screen. Shown during the initial catalog fetch
 * and during OAuth redirect prep. Pulses the VGI logo behind a rotating
 * harvest spinner ring with the destination service URL + animated
 * ellipsis so the user knows something is in flight.
 */
function ConnectingScreen({
  logoUrl,
  serviceUrl,
  message = "Connecting to",
}: { logoUrl: string; serviceUrl: string; message?: string }) {
  // The destination URL label is mounted as a portal-into-target later
  // via useEffect — Astro hydrates against the SSR DOM, and React doesn't
  // replace empty children at a node after hydration unless we own that
  // subtree client-side. Setting `display` via a state flip that flushes
  // to "mounted" after first paint sidesteps the issue.
  const [ready, setReady] = useState(false);
  useEffect(() => { setReady(true); }, []);

  // Compute on every render (cheap). Falls back to reading window directly
  // if the prop is empty (happens during SSR/initial hydration tick).
  let displayUrl = serviceUrl?.replace(/^https?:\/\//, "") || "";
  if (!displayUrl && typeof window !== "undefined") {
    displayUrl = getServiceUrl().replace(/^https?:\/\//, "");
  }

  return (
    <BrandShell>
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-12 text-center">
        {/* Cupola mark with a slow scale pulse. The illustration is square
            (not a roundel), so we drop the old rotating circular halo —
            it would clip the cupola corners and read awkwardly. */}
        <img
          src={`${import.meta.env.BASE_URL}cupola-logo-large.png`}
          alt=""
          aria-hidden="true"
          width={128}
          height={128}
          className="w-32 h-32 mb-6 rounded-2xl shadow-xl ring-1 ring-soil-200/60 dark:ring-soil-700/60 animate-cs-pulse"
        />

        <h1 className="font-heading text-2xl md:text-3xl font-bold text-soil-900 dark:text-soil-100 mb-2">
          {message}
          <span className="inline-block ml-0.5 align-baseline text-harvest-600 dark:text-harvest-400 animate-cs-ellipsis" aria-hidden="true">…</span>
        </h1>
        {ready && (
          <p className="font-mono text-sm text-soil-600 dark:text-soil-400 break-all max-w-md">
            {displayUrl}
          </p>
        )}
      </div>

      {/* Local keyframes — kept inline so this screen is self-contained and
          doesn't rely on any other file. */}
      <style>{`
        @keyframes cs-pulse {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(0.96); opacity: 0.88; }
        }
        .animate-cs-pulse { animation: cs-pulse 2.4s ease-in-out infinite; }

        @keyframes cs-ellipsis {
          0%, 20%  { opacity: 0; }
          40%      { opacity: 0.5; }
          60%, 100% { opacity: 1; }
        }
        .animate-cs-ellipsis { animation: cs-ellipsis 1.2s ease-in-out infinite; }
      `}</style>
    </BrandShell>
  );
}

/**
 * Connection error screen. Wears the same Query.Farm chrome as the
 * connecting/welcome surfaces (sticky header + earth gradient bg), shows
 * the failed URL + error message in a destructive callout, and lists
 * recent servers so the user can recover quickly if it was a typo. Each
 * recent entry connects directly on click (no prefill); to edit options
 * first, the user can land on the welcome page via the wordmark.
 */
function ErrorScreen({
  logoUrl,
  serviceUrl,
  error,
}: { logoUrl: string; serviceUrl: string; error: string }) {
  const [recent, setRecent] = useState<RecentService[]>([]);
  useEffect(() => {
    // Don't include the currently-failing URL in the suggestions.
    setRecent(getRecentServices().filter((s) => s.url !== serviceUrl));
  }, [serviceUrl]);

  const connectTo = (url: string) => {
    const dest = new URL(window.location.href);
    dest.searchParams.set("service", url);
    dest.hash = "";
    window.location.href = dest.toString();
  };

  return (
    <BrandShell>
      <div className="flex-1 flex items-start justify-center px-6 py-12">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <img
              src={`${import.meta.env.BASE_URL}cupola-logo-large.png`}
              alt=""
              aria-hidden="true"
              width={96}
              height={96}
              className="w-24 h-24 mx-auto mb-6 rounded-2xl shadow-lg ring-1 ring-soil-200/60 dark:ring-soil-700/60"
            />
            <h1 className="font-heading text-2xl font-bold text-soil-900 dark:text-soil-100 mb-3">
              Connection Error
            </h1>
            <p className="font-mono text-sm text-soil-600 dark:text-soil-400 break-all mb-4">
              {serviceUrl}
            </p>
            <div className="rounded-lg bg-destructive/10 border border-destructive/30 px-3 py-2 text-sm text-destructive dark:text-red-300 text-left">
              {error}
            </div>
          </div>

          {/* Retry / try a different URL */}
          <div className="bg-card rounded-xl ring-1 ring-foreground/10 p-5 mb-6">
            <h2 className="font-heading text-sm font-semibold text-foreground mb-3">
              Try a different server
            </h2>
            <ConnectForm />
          </div>

          {/* Recent servers — if it was a typo, the right one is probably here */}
          {recent.length > 0 && (
            <div className="bg-card rounded-xl ring-1 ring-foreground/10 p-5">
              <h2 className="font-heading text-sm font-semibold text-foreground mb-3">
                Or pick a recent server
              </h2>
              <ul className="space-y-1">
                {recent.map((s) => (
                  <li key={s.url}>
                    <button
                      onClick={() => connectTo(s.url)}
                      className="w-full text-left px-3 py-2 rounded-md hover:bg-muted transition-colors group"
                    >
                      <span className="block text-sm font-medium text-earth-700 dark:text-earth-300 truncate">
                        {s.catalogName}
                      </span>
                      <span className="block text-xs text-muted-foreground truncate font-mono">
                        {s.url}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </BrandShell>
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
  // How many recents to surface before the user expands the full history.
  const RECENT_PREVIEW = 3;
  const [showAllRecent, setShowAllRecent] = useState(false);
  const [recentFilter, setRecentFilter] = useState("");
  const formRef = useRef<ConnectFormHandle>(null);
  useEffect(() => {
    setRecent(getRecentServices());
    setOrigin(window.location.origin);
  }, []);

  const handleRemove = (url: string) => {
    removeRecentService(url);
    setRecent(getRecentServices());
  };

  // Filter applies to the full history (only used while expanded); the
  // collapsed view always shows the latest few regardless of filter text.
  const q = recentFilter.trim().toLowerCase();
  const filteredRecent = q
    ? recent.filter(
        (s) =>
          s.catalogName.toLowerCase().includes(q) ||
          s.url.toLowerCase().includes(q) ||
          (s.attachOptions ?? "").toLowerCase().includes(q),
      )
    : recent;
  const visibleRecent = showAllRecent ? filteredRecent : recent.slice(0, RECENT_PREVIEW);

  // Clicking a recent server prefills the form (so the user can review or
  // tweak its options before connecting) rather than auto-navigating.
  // Holding shift bypasses the prefill and connects directly, preserving
  // the previous one-click behavior.
  const connectTo = (url: string, e?: React.MouseEvent) => {
    if (e?.shiftKey) {
      const dest = new URL(window.location.href);
      dest.searchParams.set("service", url);
      window.location.href = dest.toString();
      return;
    }
    formRef.current?.prefill(url);
  };

  return (
    <BrandShell>
      <div className="max-w-xl w-full mx-auto px-6 py-12 lg:py-16">
        <div className="flex flex-col items-center text-center mb-8">
          <img
            src={`${import.meta.env.BASE_URL}cupola-logo-large.png`}
            alt=""
            aria-hidden="true"
            width={144}
            height={144}
            className="w-36 h-36 mb-6 rounded-2xl shadow-xl ring-1 ring-soil-200/60 dark:ring-soil-700/60"
          />
          <h1 className="font-heading text-4xl md:text-5xl font-bold text-soil-900 dark:text-soil-100 leading-[1.05] tracking-tight mb-3">
            Browse any VGI catalog.
          </h1>
          <p className="text-soil-700 dark:text-soil-300 text-lg max-w-md leading-relaxed">
            Connect to a VGI server to explore schemas, tables, views, and functions — with an embedded SQL shell and AI analyst.
          </p>
        </div>

        <div className="bg-card rounded-xl ring-1 ring-foreground/10 p-5 mb-6">
          <h2 className="font-heading text-sm font-semibold text-foreground mb-3">Connect to a VGI service</h2>
          <ConnectForm ref={formRef} />
        </div>

        {recent.length > 0 && (
          <div className="bg-card rounded-lg border border-border p-6 mb-6">
            <div className="flex items-center justify-between gap-2 mb-3">
              <h2 className="text-sm font-semibold text-foreground">
                Recent servers
                {recent.length > RECENT_PREVIEW && (
                  <span className="ml-1.5 text-xs font-normal text-muted-foreground">({recent.length})</span>
                )}
              </h2>
              {recent.length > RECENT_PREVIEW && (
                <button
                  onClick={() => { setShowAllRecent((v) => !v); setRecentFilter(""); }}
                  className="text-xs font-medium text-primary hover:underline shrink-0"
                >
                  {showAllRecent ? "Show fewer" : `Show all ${recent.length}`}
                </button>
              )}
            </div>

            {showAllRecent && recent.length > RECENT_PREVIEW && (
              <input
                type="text"
                value={recentFilter}
                onChange={(e) => setRecentFilter(e.target.value)}
                placeholder="Filter servers…"
                aria-label="Filter recent servers"
                className="w-full mb-3 px-3 py-1.5 rounded-md border border-input bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            )}

            <ul className={`space-y-2 ${showAllRecent ? "max-h-80 overflow-y-auto pr-1" : ""}`}>
              {visibleRecent.map((s) => (
                <li key={s.url} className="flex items-center gap-2 group">
                  <button
                    onClick={(e) => connectTo(s.url, e)}
                    title={s.attachOptions ? `Has connection options · shift-click to connect immediately` : "Shift-click to connect immediately"}
                    className="flex-1 text-left px-3 py-2 rounded-md hover:bg-muted transition-colors min-w-0"
                  >
                    <span className="block text-sm font-medium text-primary truncate">{s.catalogName}</span>
                    <span className="block text-xs text-muted-foreground truncate">{s.url}</span>
                    {s.attachOptions && (
                      <span className="block text-[11px] text-muted-foreground/80 truncate font-mono">
                        {s.attachOptions}
                      </span>
                    )}
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

            {showAllRecent && filteredRecent.length === 0 && (
              <p className="text-sm text-muted-foreground px-1 py-2">No servers match “{recentFilter}”.</p>
            )}
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
          <p>&copy; 2026 &#x1F69C; <a href="https://query.farm" className="hover:text-foreground transition-colors">Query.Farm LLC</a></p>
          <p>v{__APP_VERSION__} ({__GIT_HASH__})</p>
        </div>
      </div>
    </BrandShell>
  );
}

function ContentPanel({
  data,
  memoryCatalog,
  attachedCatalogs,
  selection,
  serviceUrl,
  attachOptions,
  onNavigate,
  onOpenShell,
}: {
  data: CatalogData;
  memoryCatalog?: CatalogData | null;
  attachedCatalogs?: CatalogData[];
  selection: Selection | null;
  serviceUrl: string;
  attachOptions?: string;
  onNavigate: (selection: Selection) => void;
  onOpenShell?: () => void;
}) {
  if (!selection || selection.type === "catalog") {
    if (selection?.catalog && memoryCatalog && selection.catalog === memoryCatalog.catalogName) {
      return <MemoryCatalogOverview catalog={memoryCatalog} onNavigate={onNavigate} />;
    }
    const attached = selection?.catalog && attachedCatalogs?.find((c) => c.catalogName === selection.catalog);
    if (attached) {
      return <CatalogOverview catalog={attached} serviceUrl={serviceUrl} attachOptions={attachOptions} onNavigate={onNavigate} />;
    }
    return <CatalogOverview catalog={data} serviceUrl={serviceUrl} attachOptions={attachOptions} onNavigate={onNavigate} />;
  }

  // Determine which catalog to search
  const catalog = (selection.catalog && memoryCatalog && selection.catalog === memoryCatalog.catalogName)
    ? memoryCatalog
    : (selection.catalog && attachedCatalogs?.find((c) => c.catalogName === selection.catalog))
      ?? data;

  const schema = catalog.schemas.find((s) => s.info.name === selection.schema);
  if (!schema) return <CatalogOverview catalog={data} serviceUrl={serviceUrl} attachOptions={attachOptions} onNavigate={onNavigate} />;

  if (selection.type === "schema") {
    return <SchemaDetail schema={schema} onNavigate={onNavigate} catalogName={catalog.catalogName} onOpenShell={onOpenShell} />;
  }

  if (selection.type === "table") {
    const table = schema.tables.find((t) => t.name === selection.name);
    if (table) return <TableDetail table={table} catalogName={catalog.catalogName} onNavigate={onNavigate} onOpenShell={onOpenShell} />;
  }

  if (selection.type === "view") {
    const view = schema.views.find((v) => v.name === selection.name);
    if (view) return <ViewDetail view={view} catalogName={catalog.catalogName} schemaName={selection.schema} onNavigate={onNavigate} onOpenShell={onOpenShell} />;
  }

  if (selection.type === "function") {
    const func = schema.functions.find((f) => f.name === selection.name);
    if (func) return <FunctionDetail func={func} catalogName={catalog.catalogName} schemaName={selection.schema} onNavigate={onNavigate} onOpenShell={onOpenShell} />;
  }

  if (selection.type === "macro") {
    const macro = schema.macros?.find((m) => m.name === selection.name);
    if (macro) return <MacroDetail macro={macro} catalogName={catalog.catalogName} schemaName={selection.schema} onNavigate={onNavigate} onOpenShell={onOpenShell} />;
  }

  return <CatalogOverview catalog={data} serviceUrl={serviceUrl} attachOptions={attachOptions} onNavigate={onNavigate} />;
}
