import { useEffect, useState, useMemo, useCallback, useRef, useSyncExternalStore, forwardRef, useImperativeHandle, type PointerEvent as ReactPointerEvent } from "react";
import { fetchCatalogSpecs, type CatalogData } from "@/lib/service";
import { useMediaQuery } from "@/lib/use-media-query";
import { OPEN_REPORT_EVENT, type OpenReportDetail } from "@/lib/evidence/open-report";
import {
  getServiceUrl,
  hasExplicitService,
  consumePrefillFromHash,
  consumeSharedSql,
  clearSharedSql,
  isGrainliftService,
  getCatalogNameFromUrl,
  getTargetFromUrl,
  getWorkspaceTokenFromHash,
  getLocalWorkspaceId,
  swapWorkspaceFragmentForId,
  LOCAL_WS_PARAM,
} from "@/lib/url-params";
import type { PendingEditorSql } from "./editor/SqlEditorView";
import { catalogInventory } from "@/lib/catalog-store";
import type { CatalogConnection } from "@/lib/catalog-inventory";
import { useCatalogInventory } from "@/lib/use-catalog-inventory";
import {
  applyConsent,
  persistEvaluatedOptions,
  readConnectionInput,
  saveFormOptions,
  workspaceConnectionInput,
} from "@/lib/attach/connection";
import { collectFormOptions } from "@/lib/attach/form";
import { isSecretOption, partitionSecrets, shareableOptionsText, type OptionSpecInfo } from "@/lib/attach/options";
import type { OptionProblem } from "@/lib/attach/legacy-options";
import { secretsFor } from "@/lib/attach/secret-store";
import type { AttachErrorDetail } from "@/lib/attach/error-detail";
import { applyDefaultCatalog, attachCatalog, type DefaultRequest, type ShellCatalog } from "@/lib/attach/attach-catalog";
import { AttachErrorDialog, CatalogsConsentPanel, ConsentPanel, OptionsFields, OptionsNoticeDialog } from "./AttachOptions";
import { isRecoverableAuthError } from "@/lib/auth-errors";
import { type Selection } from "@/lib/tree";
import { getUserInfo, setLegacyAuthService } from "@/lib/auth";
import * as Sentry from "@sentry/astro";
import {
  bootstrap as oauthBootstrap,
  consumePendingCallback,
  startLoginFlow,
} from "@/lib/oauth-client";
import { SettingsProvider } from "@/lib/settings";
import {
  engine,
  terminal,
  ui,
  onCatalogStatusChange,
  resetCatalogStatuses,
  setCatalogStatus,
  setShellWorkerSentryUser,
  type CatalogStatus,
  type DefaultCatalogState,
} from "@/lib/shell-bridge";
import { addQueryHistoryEntry } from "@/lib/editor/query-history";
import { hashToSelection, resolveSelection, updatePageTitle, pushSelectionToUrl } from "@/lib/navigation";
import { loadTheme } from "@/lib/theme";
import { decodeWorkspaceToken, encodeWorkspaceToken } from "@/lib/workspace/codec";
import { normaliseWorkspace, toPortableFile, type ActiveWorkspace } from "@/lib/workspace/spec";
import { loadCatalogEntry, type CatalogEntry, type CatalogLoad, type LoadResult } from "@/lib/workspace/load";
import {
  clearPendingSignIn,
  loadSessionWorkspace,
  markSessionWorkspaceConsented,
  readPendingSignIn,
  savePendingSignIn,
  stashSessionWorkspace,
} from "@/lib/workspace/session";
import { lazy, Suspense } from "react";
import { ErrorBoundary } from "./ErrorBoundary";
import { Header } from "./Header";
import { BrandMark } from "./BrandMark";
import { Sidebar, type SidebarCatalogStatus } from "./Sidebar";
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
const EvidencePanel = lazy(() => import("./evidence/EvidencePanel").then(m => ({ default: m.EvidencePanel })));
const CatalogRelationships = lazy(() => import("./content/CatalogRelationships").then(m => ({ default: m.CatalogRelationships })));
import { AppTabBar, type TabId } from "./AppTabBar";
import { EngineStatusRibbon } from "./EngineStatusRibbon";
import { CatalogOverview } from "./content/CatalogOverview";
import { MemoryCatalogOverview } from "./content/MemoryCatalogOverview";
import { SchemaDetail } from "./content/SchemaDetail";
import { TableDetail } from "./content/TableDetail";
import { ViewDetail } from "./content/ViewDetail";
import { FunctionDetail } from "./content/FunctionDetail";
import { MacroDetail } from "./content/MacroDetail";
import {
  describeRecentOptions,
  getRecentService,
  getRecentServices,
  removeRecentService,
  type RecentService,
} from "@/lib/recent-services";

/** A recoverable auth error: one the SPA login redirect (below) handles by
 *  bouncing the user back through the IdP. These happen routinely (expired
 *  token) and are deliberately NOT reported to Sentry. Hard failures (e.g.
 *  "token exchange failed", connection errors) don't match and ARE reported.
 *
 *  The rule lives in ./auth-errors so this file, the loader and the attach
 *  path all classify identically — they previously had three different
 *  inline rules, each keying off a bare "auth" substring. */
const isRecoverableAuthMessage = isRecoverableAuthError;

/** Default brand mark for the full-page screens, overridden by a themed logo. */
const CUPOLA_MARK = `${import.meta.env.BASE_URL}cupola-logo-large.png`;

/** Minimum spacing between two login redirects before we call it a loop. */
const AUTH_REDIRECT_LOOP_WINDOW_MS = 10_000;

/** The redirect-loop guard's sessionStorage key, per service: with several
 *  catalogs, signing in to one must not block signing in to the next. */
function redirectGuardKey(serviceUrl: string): string {
  return `_vgi_auth_redirect_ts:${serviceUrl}`;
}

/** Start an OAuth login redirect, refusing to do so twice in quick succession
 *  for the same service.
 *
 *  Both automatic entry points into the login flow — the loader's pre-check
 *  and a 401 from the catalog fetch — must go through here. When only the
 *  error path recorded the timestamp, a service that authenticates but then
 *  fails the pre-check could bounce the user to the IdP without limit.
 *  Returns false when the redirect was suppressed, so callers can surface the
 *  failure instead. */
function beginLoginFlow(serviceUrl: string, path: string): boolean {
  const key = redirectGuardKey(serviceUrl);
  const lastRedirect = Number(sessionStorage.getItem(key) || "0");
  const sinceLastRedirectMs = Date.now() - lastRedirect;
  if (sinceLastRedirectMs < AUTH_REDIRECT_LOOP_WINDOW_MS) {
    console.warn("[catalog] Auth redirect loop detected — last redirect was", sinceLastRedirectMs, "ms ago. Stopping.");
    // A stuck user (re-auth loop) is a genuine hard failure worth surfacing —
    // it's no longer a "routine redirect".
    Sentry.captureMessage("Auth redirect loop detected", {
      level: "warning",
      tags: { component: "auth", path: "redirect-loop" },
      extra: { serviceUrl, sinceLastRedirectMs, entryPoint: path },
    });
    return false;
  }
  sessionStorage.setItem(key, String(Date.now()));
  return true;
}

interface CatalogAppProps {
  initialTab?: TabId;
  defaultServiceUrl?: string;
}

/** How this page load names its catalogs. */
interface Boot {
  workspace: ActiveWorkspace | null;
  /** Consent already given for this workspace (a reload of `?local_ws=`). */
  consented: boolean;
  /** A `#ws=` token still to decode. */
  token: string | null;
  error: string | null;
}

/** Read the URL once. `#ws=` wins over `?service=`; `?local_ws=` is this
 *  tab's stored copy of a workspace link; `?service=` (or the page's
 *  `defaultServiceUrl`) is one catalog, the frozen contract. */
function readBoot(defaultServiceUrl?: string): Boot {
  const none: Boot = { workspace: null, consented: false, token: null, error: null };
  if (typeof window === "undefined") return none;
  const token = getWorkspaceTokenFromHash();
  if (token) {
    setLegacyAuthService(null);
    return { ...none, token };
  }
  const localId = getLocalWorkspaceId();
  if (localId) {
    setLegacyAuthService(null);
    const stored = loadSessionWorkspace(localId);
    if (!stored) return { ...none, error: "This workspace was opened in another tab or session and is not stored here. Open the original workspace link again." };
    return { ...none, workspace: stored.workspace, consented: stored.consented };
  }
  if (!hasExplicitService() && !defaultServiceUrl) return none;
  const serviceUrl = hasExplicitService() ? getServiceUrl() : defaultServiceUrl!;
  // The legacy `#token=` fragment belongs to this catalog only.
  setLegacyAuthService(serviceUrl);
  const grainlift = isGrainliftService(serviceUrl);
  const workspace: ActiveWorkspace = {
    id: "service",
    name: null,
    source: "service",
    catalogs: [{
      id: "service",
      url: serviceUrl,
      kind: grainlift ? "grainlift" : "vgi",
      catalogName: "",
      // A Grainlift gateway's alias is known up front; a VGI server names its
      // catalog when asked.
      alias: grainlift ? (getCatalogNameFromUrl() ?? getTargetFromUrl() ?? "") : "",
      options: {},
    }],
    defaultCatalogId: "service",
    defaultSchema: null,
    notes: [],
  };
  return { ...none, workspace, consented: true };
}

function entriesFor(workspace: ActiveWorkspace | null): CatalogEntry[] {
  if (!workspace) return [];
  return workspace.catalogs.map((catalog) => ({
    catalog,
    input: workspace.source === "service"
      ? readConnectionInput(catalog.url, { grainlift: catalog.kind === "grainlift" })
      : workspaceConnectionInput(catalog),
    load: { state: "loading" } as CatalogLoad,
  }));
}

/** The engine's per-catalog statuses, for React. */
function useCatalogStatuses(): ReadonlyMap<string, CatalogStatus> {
  return useSyncExternalStore(onCatalogStatusChange, () => engine.catalogStatuses, () => engine.catalogStatuses);
}
function useDefaultCatalogState(): DefaultCatalogState {
  return useSyncExternalStore(onCatalogStatusChange, () => engine.defaultCatalog, () => engine.defaultCatalog);
}

export function CatalogApp({ initialTab, defaultServiceUrl }: CatalogAppProps = {}) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const shellInsertRef = useRef<((text: string) => void) | null>(null);
  // The single source of truth for which top-level surface is showing. Replaces
  // the old appView toggle + shell-drawer mode. Persisted (migrating the old
  // vgi-app-view key) so a reload returns to the same tab.
  const [activeTab, setActiveTab] = useState<TabId>(() => {
    if (initialTab) return initialTab === "evidence" ? "reports" : initialTab;
    try {
      const stored = localStorage.getItem("vgi-active-tab") as TabId | null;
      // Perspective is backed by transient query/table data that does not
      // survive a page load. Restoring it would therefore open an empty
      // surface; start on the safe Catalog tab instead.
      if (stored === "evidence") return "reports";
      if (stored === "perspective") return "catalog";
      // Query History was a tab until it moved into the editor's History menu.
      if ((stored as string) === "queries") return "editor";
      if (stored && ["catalog", "editor", "shell", "askai", "reports", "evidence"].includes(stored)) return stored;
      if (localStorage.getItem("vgi-app-view") === "editor") return "editor";
    } catch {}
    return "catalog";
  });
  // Collapsible catalog sidebar (persisted).
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem("vgi-sidebar-collapsed") === "1"; } catch { return false; }
  });
  const isNarrow = useMediaQuery("(max-width: 767px)");
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const sidebarVisible = isNarrow ? mobileSidebarOpen : !sidebarCollapsed;
  useEffect(() => {
    if (!mobileSidebarOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileSidebarOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [mobileSidebarOpen]);
  // AI turns in flight, per surface. Both panels stay mounted (or, for the
  // editor's, can be collapsed) while a turn runs, so the tab bar is the only
  // place that can say "still working" once the user looks elsewhere.
  const [askAiBusy, setAskAiBusy] = useState(false);
  const [editorAiBusy, setEditorAiBusy] = useState(false);
  // The engine host (shell/askai/perspective) is mounted for
  // the whole session — hidden behind the catalog/editor when not active — so
  // (a) DuckDB boots + ATTACHes once (column stats, previews work on the
  // catalog tab), and (b) terminal / chat / perspective state survives tab
  // switches. It's visible only on an engine-backed tab.
  const engineVisible = activeTab !== "catalog" && activeTab !== "editor" && activeTab !== "reports" && activeTab !== "evidence";
  // The editor mounts on its first visit and then stays mounted (hidden the
  // same way as the engine host) for the rest of the session. Its result grid
  // holds a decoded Arrow table in component state, so unmounting on every tab
  // switch threw away the query result — along with the scroll position, sort,
  // and column widths. Mounting lazily rather than always keeps the CodeMirror
  // chunk off the critical path for someone who only browses the catalog.
  const [editorMounted, setEditorMounted] = useState(activeTab === "editor");
  const [reportsMounted, setReportsMounted] = useState(activeTab === "reports");
  useEffect(() => {
    if (activeTab === "editor") setEditorMounted(true);
    if (activeTab === "reports") setReportsMounted(true);
  }, [activeTab]);
  // The Perspective tab is shown only while it holds something: every way in
  // (a table's Pivot button, the editor's Pivot menu, `.perspective`) switches
  // to it, and closing it empties it and goes back where the reader was.
  const [perspectiveOpen, setPerspectiveOpen] = useState(false);
  const lastTabRef = useRef<TabId>("catalog");
  useEffect(() => {
    if (activeTab === "perspective") setPerspectiveOpen(true);
    else lastTabRef.current = activeTab;
  }, [activeTab]);
  const closeTab = useCallback((tab: TabId) => {
    if (tab !== "perspective") return;
    setPerspectiveOpen(false);
    setActiveTab((current) => current === "perspective" ? lastTabRef.current : current);
    void ui.closePerspective?.();
  }, []);
  const pivotTable = useCallback(() => {
    ui.pivotSelectedTable?.();
    setActiveTab("perspective");
  }, []);
  useEffect(() => {
    const openReports = () => setActiveTab("reports");
    window.addEventListener("cupola:promote-report", openReports);
    return () => window.removeEventListener("cupola:promote-report", openReports);
  }, []);
  // A saved report opened from the sidebar. A mounted workspace opens it itself; one that isn't
  // mounted yet reads the report from the URL on its first render, so the URL goes first. The
  // catalog selection in the hash is kept.
  const reportsMountedRef = useRef(reportsMounted);
  reportsMountedRef.current = reportsMounted;
  useEffect(() => {
    const openReport = (event: Event) => {
      const { href } = (event as CustomEvent<OpenReportDetail>).detail;
      if (!reportsMountedRef.current) window.history.pushState(window.history.state, "", href + window.location.hash);
      setActiveTab("reports");
    };
    window.addEventListener(OPEN_REPORT_EVENT, openReport);
    return () => window.removeEventListener(OPEN_REPORT_EVENT, openReport);
  }, []);
  // SQL pushed into the editor from elsewhere (example queries, query history,
  // shared query links). `autoRun` is false for shared links: the recipient
  // gets the query staged and ready, but chooses when to execute it.
  const [pendingEditorSql, setPendingEditorSql] = useState<PendingEditorSql | null>(null);
  const inventory = useCatalogInventory();
  const catalogs = inventory.catalogs;
  const attachedCatalogs = catalogs.filter(c => !c.isDefault && c.catalogName !== "memory");
  // Brand mark for the welcome / connecting / error screens. Defaults to the
  // Cupola mark and is replaced when a `?theme=` config supplies its own logo.
  //
  // These screens took a `logoUrl` prop and then ignored it, hardcoding the
  // Cupola image — and `getLogoUrl()` had no callers at all. So a theme's
  // `logo` field was loaded, parsed and cached but never reached any pixel,
  // despite theme.ts documenting it as replacing "the default VGI logo in
  // header and error screens". The prop is now actually used.
  const [logoUrl, setLogoUrl] = useState(CUPOLA_MARK);
  const [authError, setAuthError] = useState<{ title: string; message: string } | null>(null);
  const [attachError, setAttachError] = useState<AttachErrorDetail | null>(null);
  // True only after client-side hydration. We use this to gate any render
  // branch that depends on `window` state — without it the SSR output (no
  // window) and the first client render (with window) diverge and React 19
  // throws a hydration mismatch.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  // ---------------------------------------------------------------------------
  // The catalog set
  // ---------------------------------------------------------------------------
  //
  // One entry per catalog, loaded in parallel (workspace/load.ts). Once every
  // entry has settled, the ready ones go to the engine, which attaches them
  // one at a time (attach/attach-catalog.ts). A `?service=` page is the same
  // machinery with one entry, and keeps the single-catalog behaviour: an
  // auth error redirects to sign in, a failure is the full-page error.
  const [boot, setBoot] = useState<Boot>(() => readBoot(defaultServiceUrl));
  const workspace = boot.workspace;
  const [entries, setEntries] = useState<CatalogEntry[]>(() => entriesFor(boot.workspace));
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const single = entries.length === 1;
  const settled = entries.length > 0 && entries.every((e) => e.load.state !== "loading");
  const readyEntries = entries.filter((e): e is CatalogEntry & { load: Extract<CatalogLoad, { state: "ready" }> } => e.load.state === "ready");
  const requestedDefaultEntry = workspace
    ? entries.find((e) => e.catalog.id === workspace.defaultCatalogId) ?? entries[0]
    : undefined;
  const requestedDefaultAlias = requestedDefaultEntry?.load.state === "ready"
    ? requestedDefaultEntry.load.shell.alias
    : requestedDefaultEntry?.catalog.alias || null;
  // Stable for the session: query history, editor tabs and reports are still
  // keyed by the default catalog's service URL (phase 2 keys them by workspace).
  const serviceUrl = requestedDefaultEntry?.catalog.url ?? (hasExplicitService() ? getServiceUrl() : defaultServiceUrl ?? "");
  const [signInBlocked, setSignInBlocked] = useState<string | null>(null);
  // Expressions the engine evaluated before ATTACH, now plain values, per alias.
  const [evaluatedOptions, setEvaluatedOptions] = useState<Record<string, Record<string, string>>>({});
  // Options that were refused or dropped, reported once.
  const [optionNotices, setOptionNotices] = useState<OptionProblem[]>([]);
  const statuses = useCatalogStatuses();
  const engineDefault = useDefaultCatalogState();

  // `#ws=`: decode, validate, normalise (aliases fixed here, once), store for
  // this tab and swap the fragment for `?local_ws=<id>` so a reload finds the
  // same set. The consent screen comes next.
  useEffect(() => {
    if (!boot.token) return;
    let live = true;
    void decodeWorkspaceToken(boot.token).then((result) => {
      if (!live) return;
      if (!result.ok) {
        setBoot({ workspace: null, consented: false, token: null, error: result.error });
        return;
      }
      if (result.file.workspaces.length > 1) result.warnings.push(`The link holds ${result.file.workspaces.length} workspaces; the first is opened.`);
      const opened = normaliseWorkspace(result.file.workspaces[0], () => crypto.randomUUID(), result.warnings);
      // Always a fresh id for this tab: two tabs opening the same link must
      // not share (or overwrite) one stored copy.
      const active: ActiveWorkspace = { ...opened, id: crypto.randomUUID() };
      stashSessionWorkspace(active, false);
      swapWorkspaceFragmentForId(active.id);
      setBoot({ workspace: active, consented: false, token: null, error: null });
      setEntries(entriesFor(active));
    });
    return () => { live = false; };
  }, [boot.token]);

  // Persist the active tab.
  useEffect(() => {
    try { localStorage.setItem("vgi-active-tab", activeTab); } catch {}
  }, [activeTab]);

  // Persist sidebar collapse.
  useEffect(() => {
    try { localStorage.setItem("vgi-sidebar-collapsed", sidebarCollapsed ? "1" : "0"); } catch {}
  }, [sidebarCollapsed]);

  // ui.openInEditor: switch to the editor tab and queue the SQL.
  // Invoked by ExampleQueries' Run button and the AI panels' "open in new tab".
  useEffect(() => {
    ui.openInEditor = (sql: string, opts?: { autoRun?: boolean }) => {
      setPendingEditorSql({ sql, autoRun: opts?.autoRun ?? true });
      setActiveTab("editor");
    };
    return () => { ui.openInEditor = null; };
  }, []);

  // `?sql=` / `?sql_z=` — a shared query link. Stage it in a new editor tab
  // without running it. The param is stripped from the URL on read, so a
  // reload won't re-open the tab. The editor mounts only once the catalog has
  // loaded; `pendingEditorSql` waits in state until then, and `consumeSharedSql`
  // keeps a sessionStorage copy so a sign-in redirect or a failed attach in
  // between doesn't lose the query.
  useEffect(() => {
    let cancelled = false;
    consumeSharedSql().then((sql) => {
      if (cancelled || !sql) return;
      setPendingEditorSql({ sql, autoRun: false });
      setActiveTab("editor");
    });
    return () => { cancelled = true; };
  }, []);

  // Legacy imperative callers refresh the same inventory as every other surface.
  useEffect(() => {
    ui.refreshMemoryTables = catalogInventory.refresh;
    ui.onAttachedCatalogsChanged = catalogInventory.refresh;
    return () => {
      ui.refreshMemoryTables = null;
      ui.onAttachedCatalogsChanged = null;
    };
  }, []);

  // Refit the terminal when the shell tab becomes active (it may have been
  // hidden/zero-sized while another tab was showing).
  useEffect(() => {
    if (activeTab !== "shell") return;
    requestAnimationFrame(() => {
      terminal.fitAddon?.fit();
      setTimeout(() => terminal.fitAddon?.fit(), 50);
    });
  }, [activeTab]);

  // Every surface records its queries through this slot; they are kept per server
  // and read in the editor's History menu.
  useEffect(() => {
    if (!serviceUrl) return;
    ui.addQueryHistoryEntry = (entry) => addQueryHistoryEntry(serviceUrl, entry);
    return () => { ui.addQueryHistoryEntry = null; };
  }, [serviceUrl]);

  const setLoad = useCallback((id: string, load: CatalogLoad, alias?: string, catalogName?: string) => {
    setEntries((current) => current.map((e) => e.catalog.id !== id ? e : {
      ...e,
      load,
      // A `?service=` catalog learns its alias and name from the server.
      catalog: { ...e.catalog, alias: e.catalog.alias || alias || "", catalogName: e.catalog.catalogName || catalogName || "" },
    }));
  }, []);

  /** Record a settled load as this catalog's status (the engine records the
   *  ready ones once it attaches them). */
  const publishLoadStatus = useCallback((entry: CatalogEntry, result: LoadResult) => {
    const base = { alias: result.alias, url: entry.catalog.url, catalogName: result.catalogName };
    const { load } = result;
    if (load.state === "ready") setCatalogStatus({ ...base, state: "connecting" });
    else if (load.state === "sign-in-required") setCatalogStatus({ ...base, state: "sign-in-required", error: load.message });
    else if (load.state === "options-needed") setCatalogStatus({ ...base, state: "failed", error: `Needs connection options: ${load.detail.problems?.map((p) => p.name).join(", ")}`, sql: load.detail.sql, detail: load.detail });
    else if (load.state === "failed") setCatalogStatus({ ...base, state: "failed", error: load.message, sql: load.detail?.sql, detail: load.detail });
  }, []);

  const loadOne = useCallback(async (entry: CatalogEntry): Promise<LoadResult> => {
    const result = await loadCatalogEntry(entry, {
      persist: workspace?.source === "service" && (hasExplicitService() || entry.input.fromUrl),
      grainliftAlias: workspace?.source === "service" ? (getCatalogNameFromUrl() ?? entry.input.options.target) : undefined,
    });
    setLoad(entry.catalog.id, result.load, result.alias, result.catalogName);
    publishLoadStatus(entry, result);
    if (entry.input.problems.length) setOptionNotices((prev) => [...prev, ...entry.input.problems]);
    return result;
  }, [workspace?.source, setLoad, publishLoadStatus]);

  const consentPending = !workspace || !boot.consented || entries.some((e) => e.input.needsConsent.length > 0);
  const loadAll = useCallback(async () => {
    const current = entriesRef.current;
    if (!current.length) return;
    // A `?service=` catalog has no alias until its server names it; it gets
    // a status once loaded.
    resetCatalogStatuses(current.filter((e) => e.catalog.alias).map((e) => ({ alias: e.catalog.alias, url: e.catalog.url, catalogName: e.catalog.catalogName, state: "connecting" as const })));
    setEntries((list) => list.map((e) => ({ ...e, load: { state: "loading" } })));
    await Promise.all(current.map((entry) => loadOne(entry)));
  }, [loadOne]);

  // Process any pending SPA OAuth callback before the first catalog fetch.
  // This is the "returning from the IdP" path: oauth-callback.html stashed
  // `{code, state}` in sessionStorage and navigated us back here. We need
  // to exchange the code for tokens BEFORE loading — otherwise the first
  // fetchCatalog call goes out with no Authorization header and triggers
  // another OAuth redirect, creating a loop.
  const startedRef = useRef(false);
  useEffect(() => {
    if (consentPending || startedRef.current) return;
    startedRef.current = true;
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
          setBoot((b) => ({ ...b, error: err instanceof Error ? err.message : "Authentication failed" }));
          return;
        }
      }
      if (!cancelled) await loadAll();
    })();
    return () => { cancelled = true; };
  }, [consentPending, loadAll, serviceUrl]);

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
      if (!shellPlanRef.current) void loadAll();
    });
  }, [loadAll]);

  // Tag every Sentry event with the services and the default catalog. Lets
  // us slice errors by tenant without putting URLs in messages.
  const serviceTag = entries.map((e) => e.catalog.url).join(",");
  useEffect(() => {
    if (serviceTag) Sentry.setTag("service", serviceTag);
  }, [serviceTag]);

  // The default catalog: the engine's choice once it has attached (it falls
  // back when the requested default failed), else the requested one when it
  // loaded, else the first that did.
  const plannedDefaultAlias = requestedDefaultEntry?.load.state === "ready"
    ? requestedDefaultEntry.load.shell.alias
    : readyEntries[0]?.load.shell.alias ?? null;
  const defaultAlias = engineDefault.alias ?? plannedDefaultAlias;
  const defaultEntry = readyEntries.find((e) => e.load.shell.alias === defaultAlias) ?? readyEntries[0];
  // Only once every catalog has settled: until then the first to load would
  // pass for the default.
  const data: CatalogData | null = settled ? defaultEntry?.load.data ?? null : null;
  useEffect(() => {
    if (defaultAlias) Sentry.setTag("catalog", defaultAlias);
  }, [defaultAlias]);
  useEffect(() => {
    if (engineDefault.alias) catalogInventory.setDefault(engineDefault.alias);
  }, [engineDefault.alias]);

  // Identify the signed-in user once tokens are available. JWT decode is
  // synchronous; re-run when the service URL or catalog changes (post-login).
  // Also forward the identity to the shell worker so its Sentry isolate
  // tags every query span with the same user. We deliberately do NOT push a
  // catalog tag to the worker — a single SQL statement can join across
  // any number of attached catalogs, so a single catalog tag would be
  // misleading. The per-span db.statement attribute already lets you trace
  // which catalogs a query touched.
  useEffect(() => {
    if (!serviceUrl) return;
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

  // What the engine attaches, frozen the first time the app can render: the
  // shell reads it once at boot. A catalog retried later is attached directly
  // (`retry`), never by re-initialising the shell.
  const shellPlanRef = useRef<{ catalogs: ShellCatalog[]; defaultCatalog: DefaultRequest; serviceUrl: string; catalogName: string } | null>(null);
  if (settled && data && !shellPlanRef.current) {
    shellPlanRef.current = {
      catalogs: readyEntries.map((e) => e.load.shell),
      defaultCatalog: { alias: requestedDefaultAlias, schema: workspace?.defaultSchema ?? null },
      serviceUrl,
      catalogName: plannedDefaultAlias ?? data.catalogName,
    };
  }

  // Every configured catalog's connection context goes to the inventory (so
  // each catalog root gets its own ConnectBox), with the RPC previews as
  // seeds until the engine has attached them.
  useEffect(() => {
    if (!settled) return;
    const connections = new Map<string, CatalogConnection>();
    const seeds: CatalogData[] = [];
    for (const entry of entries) {
      if (entry.load.state === "ready") {
        const alias = entry.load.shell.alias;
        const evaluated = evaluatedOptions[alias] ?? {};
        const { plain, secret } = partitionSecrets(evaluated, entry.load.shell.specs);
        connections.set(alias, {
          ...entry.load.connection,
          attachOptions: { ...entry.load.connection.attachOptions, ...plain },
          secretOptionNames: [...new Set([...(entry.load.connection.secretOptionNames ?? []), ...Object.keys(secret)])],
        });
        seeds.push(entry.load.data);
      } else if (entry.catalog.alias) {
        connections.set(entry.catalog.alias, {
          sourceUrl: entry.catalog.url,
          catalogName: entry.catalog.catalogName || entry.catalog.alias,
          databaseType: entry.catalog.kind,
          attachOptions: entry.catalog.options,
        });
      }
    }
    catalogInventory.setConnections(connections, engineDefault.alias ?? plannedDefaultAlias, seeds);
  }, [settled, entries, evaluatedOptions, engineDefault.alias, plannedDefaultAlias]);

  const onOptionsEvaluated = useCallback((alias: string, values: Record<string, string>, problems: OptionProblem[]) => {
    setEvaluatedOptions((prev) => ({ ...prev, [alias]: values }));
    if (problems.length) setOptionNotices((prev) => [...prev, ...problems]);
    const entry = entriesRef.current.find((e) => e.load.state === "ready" && e.load.shell.alias === alias);
    if (entry && workspace?.source === "service" && (hasExplicitService() || entry.input.fromUrl) && entry.load.state === "ready") {
      persistEvaluatedOptions(entry.catalog.url, entry.load.shell.catalogName, values, entry.load.shell.specs);
    }
  }, [workspace?.source]);

  // Share links: one catalog keeps the `?service=` form with its non-secret
  // options; a workspace link shares the workspace (`#ws=`, no secrets).
  const defaultReady = requestedDefaultEntry?.load.state === "ready" ? requestedDefaultEntry.load : null;
  const shareAttachOptions = useMemo(() => {
    if (!defaultReady) return undefined;
    const all = { ...defaultReady.shell.options, ...(evaluatedOptions[defaultReady.shell.alias] ?? {}) };
    return shareableOptionsText(all, defaultReady.shell.specs) || undefined;
  }, [defaultReady, evaluatedOptions]);
  const [shareWorkspaceToken, setShareWorkspaceToken] = useState<string | undefined>();
  useEffect(() => {
    if (workspace?.source !== "link") return;
    let live = true;
    void encodeWorkspaceToken(toPortableFile(workspace)).then((token) => { if (live) setShareWorkspaceToken(token); }).catch(() => {});
    return () => { live = false; };
  }, [workspace]);

  /** Retry one catalog: ask its server again and, once the engine is up,
   *  attach it. A catalog that becomes the requested default gets `USE`. */
  const retry = useCallback(async (id: string) => {
    const entry = entriesRef.current.find((e) => e.catalog.id === id);
    if (!entry) return;
    setLoad(id, { state: "loading" });
    setCatalogStatus({ alias: entry.catalog.alias || entry.catalog.url, url: entry.catalog.url, catalogName: entry.catalog.catalogName, state: "connecting" });
    const result = await loadOne({ ...entry, load: { state: "loading" } });
    if (result.load.state !== "ready" || !shellPlanRef.current) return;
    const shell = result.load.shell;
    await engine.attached;
    catalogInventory.rebind(shell.alias);
    const status = await attachCatalog(shell, {
      single: false,
      onAuthError: (title, message) => setAuthError({ title, message }),
      onOptionsEvaluated,
    });
    if (status.state === "attached" && (shell.alias === shellPlanRef.current.defaultCatalog.alias || !engine.defaultCatalog.alias)) {
      await applyDefaultCatalog([shell], shellPlanRef.current.defaultCatalog);
    }
    catalogInventory.invalidate();
  }, [loadOne, setLoad, onOptionsEvaluated]);

  /** Sign in to one catalog: a top-level redirect to its identity provider,
   *  after saving which catalogs still need it, so the page that comes back
   *  can say so. Only ever on a click; redirects are never chained. */
  const signIn = useCallback((id: string) => {
    const entry = entriesRef.current.find((e) => e.catalog.id === id);
    if (!entry || !workspace) return;
    const pending = entriesRef.current.filter((e) => e.load.state === "sign-in-required" || statuses.get(e.catalog.alias)?.state === "sign-in-required").map((e) => e.catalog.id);
    savePendingSignIn({ workspaceId: workspace.id, workspace, signingIn: id, pendingSignIns: pending });
    try { sessionStorage.setItem(redirectGuardKey(entry.catalog.url), String(Date.now())); } catch {}
    startLoginFlow(entry.catalog.url).catch((err) => {
      setCatalogStatus({ alias: entry.catalog.alias, url: entry.catalog.url, catalogName: entry.catalog.catalogName, state: "failed", error: `Sign-in could not start: ${err instanceof Error ? err.message : String(err)}` });
    });
  }, [workspace, statuses]);

  // Back from a sign-in this tab started: say who is signed in now and who
  // still needs it. Read once the catalogs have settled.
  const [signInNotice, setSignInNotice] = useState<{ signedIn: string | null; remaining: string[] } | null>(null);
  const signInNoticeReadRef = useRef(false);
  useEffect(() => {
    if (!settled || !workspace || workspace.source !== "link" || signInNoticeReadRef.current) return;
    signInNoticeReadRef.current = true;
    const pending = readPendingSignIn(workspace.id);
    if (!pending) return;
    clearPendingSignIn();
    const target = entries.find((e) => e.catalog.id === pending.signingIn);
    setSignInNotice({
      signedIn: target && target.load.state !== "sign-in-required" ? target.catalog.alias : null,
      remaining: entries.filter((e) => e.load.state === "sign-in-required").map((e) => e.catalog.id),
    });
  }, [settled, workspace, entries]);

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

  // Navigate: update selection, URL hash, and page title. Every selection
  // carries its catalog, so the hash names it (`#/catalog/<alias>/…`).
  const defaultAliasRef = useRef(defaultAlias);
  defaultAliasRef.current = defaultAlias;
  const navigate = useCallback(
    (sel: Selection | null) => {
      const resolved = resolveSelection(sel, defaultAliasRef.current ?? "");
      setSelection(resolved);
      pushSelectionToUrl(resolved);
      if (defaultAliasRef.current) updatePageTitle(resolved, defaultAliasRef.current);
    },
    []
  );

  // Expose navigate globally so AI agent can select newly created objects.
  // useEffect + cleanup so unmount drops the stale callback.
  useEffect(() => {
    ui.navigateToSelection = navigate;
    return () => { ui.navigateToSelection = null; };
  }, [navigate]);

  // The initial selection, once the default catalog is known: the hash (a
  // legacy `#/schema/…` link resolves against the default catalog), else the
  // default catalog's default schema.
  const initialSelectionDoneRef = useRef(false);
  useEffect(() => {
    if (!data || initialSelectionDoneRef.current) return;
    initialSelectionDoneRef.current = true;
    const alias = data.catalogName;
    const hashSel = resolveSelection(hashToSelection(window.location.hash), alias);
    const defaultSchema = data.defaultSchema || data.schemas[0]?.info.name;
    const initialSel = hashSel ?? (defaultSchema
      ? { type: "schema" as const, name: defaultSchema, schema: defaultSchema, catalog: alias }
      : { type: "catalog" as const, name: alias, catalog: alias });
    setSelection(initialSel);
    updatePageTitle(initialSel, alias);
  }, [data]);

  // Listen for browser back/forward
  useEffect(() => {
    function onPopState() {
      const alias = defaultAliasRef.current ?? "";
      const sel = resolveSelection(hashToSelection(window.location.hash), alias);
      setSelection(sel);
      if (alias) updatePageTitle(sel, alias);
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // The only catalog needs sign-in: start the SPA login flow (full-page
  // redirect to the IdP), as a `?service=` link always has. Break the loop if
  // we already tried recently so a misconfigured IdP can't trap the user in
  // an infinite redirect. With several catalogs nothing redirects by itself.
  const onlyEntry = single ? entries[0] : undefined;
  const onlyNeedsSignIn = onlyEntry?.load.state === "sign-in-required";
  useEffect(() => {
    if (!onlyEntry || onlyEntry.load.state !== "sign-in-required") return;
    const url = onlyEntry.catalog.url;
    if (!beginLoginFlow(url, "auth-error")) {
      setSignInBlocked("Sign-in did not complete. Please try connecting again.");
      return;
    }
    console.log("[catalog] Auth required, starting SPA login:", onlyEntry.load.message);
    startLoginFlow(url).catch((err) => {
      console.error("[catalog] startLoginFlow failed:", err);
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
        tags: { component: "auth", path: "start-login" },
        extra: { serviceUrl: url },
      });
      setSignInBlocked(err instanceof Error ? err.message : "Failed to start login");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onlyNeedsSignIn]);

  // Announce status changes to screen readers, batched so several catalogs
  // settling at once read as one sentence.
  const announcement = useStatusAnnouncements(statuses);

  // No ?service= or workspace — render welcome/connect page without
  // pretending cupola itself is a VGI server.
  //
  // Gated on `mounted` to avoid a React 19 hydration mismatch: SSR can't
  // read window.location, so the URL is unknown during SSR. Without the gate
  // the SSR output (WelcomePage) and the first client render (loading
  // spinner) disagree. After mount we're allowed to diverge.
  if (!mounted) return <ConnectingScreen logoUrl={logoUrl} serviceUrl="" message="Loading" />;

  if (boot.error) {
    return <ErrorScreen logoUrl={logoUrl} serviceUrl={workspace ? serviceUrl : "Workspace link"} error={boot.error} />;
  }
  if (boot.token) return <ConnectingScreen logoUrl={logoUrl} serviceUrl="" message="Opening workspace" />;
  if (!workspace) return <WelcomePage logoUrl={logoUrl} />;

  // A workspace link: list what it attaches before attaching anything.
  if (workspace.source === "link" && !boot.consented) {
    return (
      <BrandShell>
        <div className="flex-1 flex items-start justify-center px-6 py-12">
          <CatalogsConsentPanel
            workspace={workspace}
            onAnswer={(granted) => {
              if (!granted) {
                window.location.href = window.location.pathname;
                return;
              }
              markSessionWorkspaceConsented(workspace);
              setBoot((b) => ({ ...b, consented: true }));
            }}
          />
        </div>
      </BrandShell>
    );
  }

  // A link that sets options with SQL expressions: ask before evaluating them.
  const consentEntry = entries.find((e) => e.input.needsConsent.length > 0);
  if (consentEntry) {
    return (
      <BrandShell>
        <div className="flex-1 flex items-start justify-center px-6 py-12">
          <ConsentPanel
            serviceUrl={consentEntry.catalog.url}
            entries={consentEntry.input.needsConsent}
            onAnswer={(granted) => setEntries((list) => list.map((e) => e === consentEntry ? { ...e, input: applyConsent(e.input, granted) } : e))}
          />
        </div>
      </BrandShell>
    );
  }

  // Loading state — animated connect screen with brand chrome so the user
  // sees the page is alive while the catalog round-trips are in flight.
  if (!settled) {
    return <ConnectingScreen logoUrl={logoUrl} serviceUrl={single ? serviceUrl : `${entries.length} catalogs`} />;
  }

  if (single && onlyEntry) {
    const load = onlyEntry.load;
    if (load.state === "options-needed") {
      return (
        <OptionsRequiredScreen
          logoUrl={logoUrl}
          serviceUrl={onlyEntry.catalog.url}
          catalogName={load.catalogName}
          specs={load.specs}
          initial={load.options}
        />
      );
    }
    if (load.state === "sign-in-required") {
      if (signInBlocked) return <ErrorScreen logoUrl={logoUrl} serviceUrl={serviceUrl} error={signInBlocked} />;
      return <ConnectingScreen logoUrl={logoUrl} serviceUrl={serviceUrl} message="Redirecting to sign in" />;
    }
    if (load.state === "failed") {
      if (isRecoverableAuthMessage(load.message)) return <ConnectingScreen logoUrl={logoUrl} serviceUrl={serviceUrl} message="Redirecting to sign in" />;
      return <ErrorScreen logoUrl={logoUrl} serviceUrl={serviceUrl} error={load.message} />;
    }
  }

  // Several catalogs and none could be read: one screen listing each.
  if (!data) {
    return (
      <CatalogsFailedScreen
        logoUrl={logoUrl}
        entries={entries}
        onRetry={(id) => void retry(id)}
        onSignIn={signIn}
        onDetails={setAttachError}
      />
    );
  }

  const plan = shellPlanRef.current!;
  const catalogEntries = entries.map((e) => ({
    id: e.catalog.id,
    alias: e.load.state === "ready" ? e.load.shell.alias : e.catalog.alias || e.catalog.url,
    url: e.catalog.url,
    status: statuses.get(e.load.state === "ready" ? e.load.shell.alias : e.catalog.alias || e.catalog.url),
    loading: e.load.state === "loading",
  }));
  const sidebarStatuses: SidebarCatalogStatus[] = single ? [] : catalogEntries.map((c) => ({
    id: c.id,
    alias: c.alias,
    url: c.url,
    state: c.loading ? "connecting" : c.status?.state ?? "connecting",
    error: c.status?.error,
    hasDetail: Boolean(c.status?.detail),
    isDefault: c.alias === defaultAlias,
  }));

  return (
    <SettingsProvider>
    <div className="flex flex-col h-dvh">
      <Header
        catalogName={defaultAlias ?? data.catalogName}
        serviceUrl={serviceUrl}
      />
      <AppTabBar
        activeTab={activeTab}
        onSelect={setActiveTab}
        busyTabs={{ askai: askAiBusy, editor: editorAiBusy }}
        sidebarCollapsed={!sidebarVisible}
        onToggleSidebar={() => isNarrow ? setMobileSidebarOpen((open) => !open) : setSidebarCollapsed((c) => !c)}
        openTabs={{ perspective: perspectiveOpen }}
        onCloseTab={closeTab}
      />
      <EngineStatusRibbon />
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="catalog-status-announcer">{announcement}</div>
      <div className="relative flex flex-1 overflow-hidden">
        {sidebarVisible && (
          <>
            {isNarrow && (
              <button
                type="button"
                className="absolute inset-0 z-20 bg-black/35"
                aria-label="Close catalog sidebar"
                onClick={() => setMobileSidebarOpen(false)}
              />
            )}
            <div
              className={isNarrow ? "absolute inset-y-0 left-0 z-30 w-[min(85vw,320px)] shadow-xl" : undefined}
              style={isNarrow ? undefined : { width: sidebarWidth, minWidth: sidebarWidth }}
              data-testid="catalog-sidebar"
              role={isNarrow ? "dialog" : undefined}
              aria-modal={isNarrow ? "true" : undefined}
              aria-label={isNarrow ? "Catalog sidebar" : undefined}
            >
              <Sidebar
                serviceUrl={serviceUrl}
                catalogs={catalogs}
                defaultCatalogName={defaultAlias ?? data.catalogName}
                inventoryError={inventory.error}
                selection={selection}
                onSelect={(sel) => { navigate(sel); if (isNarrow) setMobileSidebarOpen(false); }}
                onShellInsert={(text) => {
                  // In editor mode, route table/column clicks into the SQL
                  // editor at the cursor; otherwise into the xterm shell.
                  if (activeTab === "editor" && ui.insertIntoEditor) {
                    ui.insertIntoEditor(text);
                  } else {
                    shellInsertRef.current?.(text);
                  }
                }}
                onRefresh={() => {
                  void (async () => {
                    await clearGrainliftCaches();
                    await catalogInventory.refresh();
                  })();
                }}
                refreshing={inventory.refreshing}
                catalogStatuses={sidebarStatuses}
                onRetryCatalog={(id) => void retry(id)}
                onSignInCatalog={signIn}
                onCatalogDetails={(alias) => {
                  const detail = statuses.get(alias)?.detail;
                  if (detail) setAttachError(detail);
                }}
                signInNotice={signInNotice ? {
                  signedIn: signInNotice.signedIn,
                  remaining: signInNotice.remaining
                    .map((id) => entries.find((e) => e.catalog.id === id))
                    .filter((e): e is CatalogEntry => Boolean(e) && e!.load.state === "sign-in-required")
                    .map((e) => ({ id: e.catalog.id, alias: e.catalog.alias })),
                } : null}
                onDismissSignInNotice={() => setSignInNotice(null)}
              />
            </div>
            {!isNarrow && <div
              onPointerDown={onResizeStart}
              className="w-2 -ml-1 -mr-1 z-10 cursor-col-resize group flex-shrink-0 flex items-stretch justify-center"
            >
              <div className="w-0.5 bg-border group-hover:bg-accent/60 group-active:bg-accent transition-colors" />
            </div>}
          </>
        )}
        {/* Content area — one tab visible at a time. Only the catalog is
            conditionally rendered; the editor and the engine host (shell/askai/
            perspective) are mounted once activated and then
            kept sized via visibility (not display:none), so the xterm terminal,
            the chat, and the editor's result grid all survive tab switches and
            still have a layout box to measure against while hidden. */}
        <div className="flex-1 relative overflow-hidden">
          {activeTab === "catalog" && (
            <main className={selection?.type === "relationships"
              ? "absolute inset-0 overflow-hidden"
              : "absolute inset-0 overflow-y-auto p-3 sm:p-6"}
            >
              <ErrorBoundary>
                <ContentPanel catalogs={catalogs} defaultCatalogName={defaultAlias ?? data.catalogName} selection={selection} onNavigate={navigate} onOpenShell={() => setActiveTab("shell")} onPivotTable={pivotTable} />
              </ErrorBoundary>
            </main>
          )}
          {editorMounted && (
            <div
              className="absolute inset-0 overflow-hidden"
              style={activeTab === "editor" ? undefined : { visibility: "hidden", zIndex: -1 }}
            >
              <ErrorBoundary>
                <Suspense fallback={<div className="flex items-center justify-center h-full text-muted-foreground text-sm">Loading editor…</div>}>
                  <SqlEditorView
                    catalogData={data}
                    attachedCatalogs={attachedCatalogs}
                    serviceUrl={serviceUrl}
                    attachOptions={workspace.source === "service" ? shareAttachOptions : undefined}
                    shareWorkspaceToken={workspace.source === "link" ? shareWorkspaceToken : undefined}
                    pendingSql={pendingEditorSql}
                    onPendingConsumed={() => { setPendingEditorSql(null); clearSharedSql(); }}
                    onAiBusyChange={setEditorAiBusy}
                  />
                </Suspense>
              </ErrorBoundary>
            </div>
          )}
          {reportsMounted && (
            <div className="absolute inset-0 overflow-hidden" style={activeTab === "reports" ? undefined : { visibility: "hidden", zIndex: -1 }}>
              <ErrorBoundary><Suspense fallback={<div className="p-6">Loading reports…</div>}>
                <EvidencePanel catalogName={plan.catalogName} serviceUrl={serviceUrl} catalogs={catalogs} defaultToLibrary={initialTab !== "evidence"} />
              </Suspense></ErrorBoundary>
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
                    serviceUrl={plan.serviceUrl}
                    catalogName={plan.catalogName}
                    catalogs={plan.catalogs}
                    defaultCatalog={plan.defaultCatalog}
                    activeTab={activeTab}
                    onTabChange={setActiveTab}
                    onAiBusyChange={setAskAiBusy}
                    onShellReady={(insert) => { shellInsertRef.current = insert; }}
                    catalogData={data}
                    attachedCatalogs={attachedCatalogs}
                    selection={selection}
                    onAuthError={(title, message) => setAuthError({ title, message })}
                    onAttachError={(_alias, detail) => setAttachError(detail)}
                    onOptionsEvaluated={onOptionsEvaluated}
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
    <AttachErrorDialog
      detail={attachError}
      onClose={() => setAttachError(null)}
      onEditOptions={() => editConnectionOptions(attachError?.serviceUrl ?? serviceUrl)}
    />
    <OptionsNoticeDialog problems={attachError ? [] : optionNotices} onClose={() => setOptionNotices([])} />
    </SettingsProvider>
  );
}

/** Back to the connect form, prefilled with this service. */
function editConnectionOptions(serviceUrl: string) {
  const dest = new URL(window.location.href);
  dest.searchParams.delete("service");
  dest.searchParams.delete("attach_options");
  dest.searchParams.delete(LOCAL_WS_PARAM);
  dest.hash = `#prefill=${encodeURIComponent(serviceUrl)}`;
  window.location.href = dest.toString();
}

const STATE_WORDS: Record<CatalogStatus["state"], string> = {
  connecting: "connecting",
  attached: "attached",
  "sign-in-required": "needs sign-in",
  failed: "failed to attach",
  disabled: "disabled",
};

/** A polite live-region message for status changes, batched over a short
 *  window so several catalogs settling together read as one announcement. */
function useStatusAnnouncements(statuses: ReadonlyMap<string, CatalogStatus>): string {
  const [message, setMessage] = useState("");
  const previous = useRef<Map<string, CatalogStatus["state"]>>(new Map());
  const pending = useRef<Map<string, CatalogStatus["state"]>>(new Map());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    for (const [alias, status] of statuses) {
      if (status.state === "connecting") continue;
      if (previous.current.get(alias) === status.state) continue;
      previous.current.set(alias, status.state);
      pending.current.set(alias, status.state);
    }
    if (!pending.current.size || timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      const parts = [...pending.current].map(([alias, state]) => `${alias} ${STATE_WORDS[state]}`);
      pending.current.clear();
      setMessage(`${parts.join(". ")}.`);
    }, 750);
  }, [statuses]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return message;
}

/** Several catalogs, none of which could be read. */
function CatalogsFailedScreen({
  logoUrl,
  entries,
  onRetry,
  onSignIn,
  onDetails,
}: {
  logoUrl: string;
  entries: CatalogEntry[];
  onRetry: (id: string) => void;
  onSignIn: (id: string) => void;
  onDetails: (detail: AttachErrorDetail) => void;
}) {
  return (
    <BrandShell>
      <div className="flex-1 flex items-start justify-center px-6 py-12">
        <div className="w-full max-w-xl" data-testid="catalogs-failed">
          <div className="text-center mb-6">
            <img src={logoUrl} alt="" aria-hidden="true" width={80} height={80} className="w-20 h-20 mx-auto mb-4 rounded-2xl shadow-lg" />
            <h1 className="font-heading text-2xl font-bold text-soil-900 dark:text-cream mb-2">No catalog could be attached</h1>
            <p className="text-sm text-muted-foreground">Retry a catalog, sign in, or check its server.</p>
          </div>
          <ul className="space-y-3">
            {entries.map((e) => {
              const load = e.load;
              const detail = load.state === "failed" ? load.detail : load.state === "options-needed" ? load.detail : undefined;
              const message = load.state === "failed" ? load.message
                : load.state === "sign-in-required" ? "Sign-in required."
                  : load.state === "options-needed" ? `Needs connection options: ${load.specs.filter((s) => s.required).map((s) => s.name).join(", ")}`
                    : load.state === "loading" ? "Connecting…" : "";
              return (
                <li key={e.catalog.id} className="bg-card rounded-xl ring-1 ring-foreground/10 p-4" data-testid="catalog-failed-row">
                  <div className="font-mono text-sm font-semibold text-foreground break-all">{e.catalog.alias || e.catalog.catalogName || e.catalog.url}</div>
                  <div className="font-mono text-xs text-muted-foreground break-all">{e.catalog.url}</div>
                  <div role="alert" className="mt-2 text-xs text-destructive break-words">{message}</div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {load.state === "sign-in-required"
                      ? <Button size="sm" onClick={() => onSignIn(e.catalog.id)}>Sign in to {e.catalog.alias}</Button>
                      : <Button size="sm" variant="outline" disabled={load.state === "loading"} onClick={() => onRetry(e.catalog.id)}>Retry</Button>}
                    {detail && <Button size="sm" variant="ghost" onClick={() => onDetails(detail)}>Details</Button>}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </BrandShell>
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

/** Stored options for a service, ready for the form: structured values plus
 *  stored secrets (shown masked), and the raw text still awaiting migration. */
function storedFormValues(url: string): { values: Record<string, string>; raw: string; catalogName: string } {
  const found = getRecentService(url);
  const catalogName = found?.catalogName ?? "";
  return {
    values: { ...(found?.options ?? {}), ...secretsFor(url, catalogName) },
    raw: found?.rawOptions ?? "",
    catalogName,
  };
}

/** Specs for the form's rows: the server's, plus a masked row for any stored
 *  secret the server does not declare (so its value is never shown as text). */
function formSpecs(specs: readonly OptionSpecInfo[], values: Record<string, string>): OptionSpecInfo[] {
  const declared = new Set(specs.map((s) => s.name.toLowerCase()));
  const extra = Object.keys(values)
    .filter((name) => !declared.has(name.toLowerCase()) && isSecretOption(name))
    .map((name): OptionSpecInfo => ({
      name, description: "A stored secret this server does not declare.", duckdbType: "VARCHAR",
      castType: "VARCHAR", arrowType: "Utf8", required: false, secret: true,
    }));
  return [...specs, ...extra];
}

/** Move stored values the form has no row for into the raw-text box, so
 *  nothing set is invisible. Secrets keep their masked row instead. */
function absorbExtras(
  specs: readonly OptionSpecInfo[],
  values: Record<string, string>,
  raw: string,
): { values: Record<string, string>; raw: string } {
  const declared = new Set(specs.map((s) => s.name.toLowerCase()));
  const kept: Record<string, string> = {};
  const moved: string[] = [];
  for (const [name, value] of Object.entries(values)) {
    if (declared.has(name.toLowerCase()) || isSecretOption(name)) kept[name] = value;
    else moved.push(`${name} ${quoteForRaw(value)}`);
  }
  return { values: kept, raw: [...moved, raw].filter(Boolean).join(", ") };
}

function quoteForRaw(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const ConnectForm = forwardRef<ConnectFormHandle>(function ConnectForm(_, ref) {
  const [url, setUrl] = useState("");
  const [form, setForm] = useState<{ values: Record<string, string>; raw: string }>({ values: {}, raw: "" });
  const { values, raw } = form;
  const setValues = (next: Record<string, string>) => setForm((f) => ({ ...f, values: next }));
  const setRaw = (next: string) => setForm((f) => ({ ...f, raw: next }));
  const [catalogName, setCatalogName] = useState("");
  const [specs, setSpecs] = useState<OptionSpecInfo[]>([]);
  const [specsFor, setSpecsFor] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [open, setOpen] = useState(false);

  const load = useCallback((target: string) => {
    const stored = storedFormValues(target);
    setUrl(target);
    setForm({ values: stored.values, raw: stored.raw });
    setCatalogName(stored.catalogName);
    setErrors([]);
    if (Object.keys(stored.values).length || stored.raw) setOpen(true);
  }, []);

  // Apply ?#prefill=<url> hash on mount — used by the attach-error modal's
  // "Edit connection options" button to bring the user back to a populated
  // form without invoking ?service= (which would auto-connect).
  useEffect(() => {
    const target = consumePrefillFromHash();
    if (target) load(target);
  }, [load]);

  useImperativeHandle(ref, () => ({ prefill: load }), [load]);

  // Discover the declared options of whatever the URL names. A server that
  // cannot be reached, or wants a sign-in first, gets the raw-text box only.
  useEffect(() => {
    const target = url.trim();
    setSpecs([]);
    setSpecsFor(null);
    if (!/^https?:\/\/[^/\s]+/i.test(target)) return;
    let live = true;
    const timer = setTimeout(() => {
      void fetchCatalogSpecs(target).then((found) => {
        if (!live) return;
        const next = found?.specs ?? [];
        setSpecs(next);
        setSpecsFor(target);
        if (found?.catalogName) setCatalogName(found.catalogName);
        if (next.length) setOpen(true);
        // Fold stored values without a row into the raw box.
        setForm((current) => absorbExtras(next, current.values, current.raw));
      });
    }, 400);
    return () => { live = false; clearTimeout(timer); };
  }, [url]);

  const rows = formSpecs(specs, values);

  const connect = () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    const collected = collectFormOptions(values, raw, rows);
    if (collected.errors.length) {
      setErrors(collected.errors);
      setOpen(true);
      return;
    }
    // Persist before the redirect, so the next page load attaches with them.
    // Secrets go to the secret store, never into the recent list or the URL.
    saveFormOptions(trimmed, specsFor === trimmed ? catalogName : (getRecentService(trimmed)?.catalogName ?? ""), collected.options, collected.rawOptions, rows);
    const dest = new URL(window.location.href);
    dest.searchParams.set("service", trimmed);
    dest.searchParams.delete("attach_options");
    dest.searchParams.delete(LOCAL_WS_PARAM);
    dest.hash = "";
    window.location.href = dest.toString();
  };
  return (
    <div className="flex flex-col gap-2 max-w-md mx-auto" data-testid="connect-form">
      <div className="flex gap-2">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && connect()}
          placeholder="https://my-server.example.com"
          aria-label="Service URL"
          className="flex-1 px-3 py-2 rounded-md border border-input bg-card text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <button
          onClick={connect}
          className="px-4 py-2 rounded-md bg-field-700 text-white text-sm font-semibold hover:bg-field-800 transition-colors"
        >
          Connect
        </button>
      </div>
      <details className="group" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground select-none">
          Connection options{specs.some((s) => s.required) ? "" : " (optional)"}
        </summary>
        <div className="mt-2">
          <OptionsFields specs={rows} values={values} onChange={setValues} raw={raw} onRawChange={setRaw} />
        </div>
      </details>
      {errors.length > 0 && (
        <ul role="alert" className="text-xs text-destructive space-y-0.5">
          {errors.map((e) => <li key={e}>{e}</li>)}
        </ul>
      )}
    </div>
  );
});

/** A catalog that cannot be attached without options the reader has not
 *  given yet: ask for them before ATTACH, using the server's own specs. */
function OptionsRequiredScreen({
  logoUrl,
  serviceUrl,
  catalogName,
  specs,
  initial,
}: { logoUrl: string; serviceUrl: string; catalogName: string; specs: OptionSpecInfo[]; initial: Record<string, string> }) {
  const [values, setValues] = useState<Record<string, string>>(() => absorbExtras(specs, initial, "").values);
  const [raw, setRaw] = useState(() => absorbExtras(specs, initial, "").raw);
  const [errors, setErrors] = useState<string[]>([]);
  const rows = formSpecs(specs, values);
  const missing = specs.filter((s) => s.required && !values[s.name]);
  const submit = () => {
    const collected = collectFormOptions(values, raw, rows);
    if (collected.errors.length) {
      setErrors(collected.errors);
      return;
    }
    saveFormOptions(serviceUrl, catalogName, collected.options, collected.rawOptions, rows);
    window.location.reload();
  };
  return (
    <BrandShell>
      <div className="flex-1 flex items-start justify-center px-6 py-12">
        <div className="w-full max-w-lg bg-card rounded-xl ring-1 ring-foreground/10 p-5" data-testid="attach-options-required">
          <div className="flex items-center gap-3 mb-3">
            <img src={logoUrl} alt="" aria-hidden="true" width={40} height={40} className="w-10 h-10 rounded-lg" />
            <div className="min-w-0">
              <h1 className="font-heading text-lg font-semibold text-foreground">{catalogName} needs connection options</h1>
              <p className="text-xs text-muted-foreground font-mono truncate">{serviceUrl}</p>
            </div>
          </div>
          <p className="text-sm text-muted-foreground mb-4">
            This catalog cannot be attached without {missing.map((s) => s.name).join(", ") || "the options marked required"}.
            Secret values are kept in this browser only and are never put in links.
          </p>
          <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <OptionsFields specs={rows} values={values} onChange={setValues} raw={raw} onRawChange={setRaw} showRaw={Boolean(raw)} />
            {errors.length > 0 && (
              <ul role="alert" className="mt-3 text-xs text-destructive space-y-0.5">
                {errors.map((e) => <li key={e}>{e}</li>)}
              </ul>
            )}
            <div className="mt-4 flex justify-end">
              <Button type="submit">Connect</Button>
            </div>
          </form>
        </div>
      </div>
    </BrandShell>
  );
}

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
    <div className="flex flex-col h-screen overflow-y-auto bg-gradient-to-b from-soil-50 via-soil-100 to-soil-200 dark:from-background dark:via-background dark:to-soil-900/30">
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
 * field-green spinner ring with the destination service URL + animated
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
  // if the prop is empty (happens during SSR/initial hydration tick) — but
  // only when a service was actually named. Without `?service=`, getServiceUrl()
  // returns cupola's own origin, and we'd claim to be connecting to ourselves.
  let displayUrl = serviceUrl?.replace(/^https?:\/\//, "") || "";
  if (!displayUrl && typeof window !== "undefined" && hasExplicitService()) {
    displayUrl = getServiceUrl().replace(/^https?:\/\//, "");
  }

  return (
    <BrandShell>
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-12 text-center">
        {/* Cupola mark with a slow scale pulse. The illustration is square
            (not a roundel), so we drop the old rotating circular halo —
            it would clip the cupola corners and read awkwardly. */}
        <img
          src={logoUrl}
          alt=""
          aria-hidden="true"
          width={128}
          height={128}
          className="w-32 h-32 mb-6 rounded-2xl shadow-xl ring-1 ring-soil-300/60 dark:ring-soil-700/60 animate-cs-pulse"
        />

        <h1 className="font-heading text-2xl md:text-3xl font-bold text-soil-900 dark:text-cream mb-2">
          {message}
          <span className="inline-block ml-0.5 align-baseline text-field-700 dark:text-field-400 animate-cs-ellipsis" aria-hidden="true">…</span>
        </h1>
        {ready && displayUrl && (
          <p className="font-mono text-sm text-soil-700 dark:text-cream-2 break-all max-w-md">
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
    dest.searchParams.delete(LOCAL_WS_PARAM);
    dest.hash = "";
    window.location.href = dest.toString();
  };

  return (
    <BrandShell>
      <div className="flex-1 flex items-start justify-center px-6 py-12">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <img
              src={logoUrl}
              alt=""
              aria-hidden="true"
              width={96}
              height={96}
              className="w-24 h-24 mx-auto mb-6 rounded-2xl shadow-lg ring-1 ring-soil-300/60 dark:ring-soil-700/60"
            />
            <h1 className="font-heading text-2xl font-bold text-soil-900 dark:text-cream mb-3">
              Connection Error
            </h1>
            <p className="font-mono text-sm text-soil-700 dark:text-cream-2 break-all mb-4">
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
                      <span className="block text-sm font-medium text-soil-700 dark:text-cream-2 truncate">
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
          describeRecentOptions(s).toLowerCase().includes(q),
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
            src={logoUrl}
            alt=""
            aria-hidden="true"
            width={144}
            height={144}
            className="w-36 h-36 mb-6 rounded-2xl shadow-xl ring-1 ring-soil-300/60 dark:ring-soil-700/60"
          />
          <h1 className="font-heading text-4xl md:text-5xl font-bold text-soil-900 dark:text-cream leading-[1.05] tracking-tight mb-3">
            Browse any VGI catalog.
          </h1>
          <p className="text-soil-700 dark:text-cream-2 text-lg max-w-md leading-relaxed">
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
                    title={describeRecentOptions(s) ? `Has connection options · shift-click to connect immediately` : "Shift-click to connect immediately"}
                    className="flex-1 text-left px-3 py-2 rounded-md hover:bg-muted transition-colors min-w-0"
                  >
                    <span className="block text-sm font-medium text-primary truncate">{s.catalogName}</span>
                    <span className="block text-xs text-muted-foreground truncate">{s.url}</span>
                    {describeRecentOptions(s) && (
                      <span className="block text-[11px] text-muted-foreground/80 truncate font-mono">
                        {describeRecentOptions(s)}
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
  catalogs, defaultCatalogName, selection, onNavigate, onOpenShell, onPivotTable,
}: {
  catalogs: CatalogData[];
  defaultCatalogName: string;
  selection: Selection | null;
  onNavigate: (selection: Selection) => void;
  onOpenShell?: () => void;
  /** Pivot the selected table in the Perspective tab. */
  onPivotTable?: () => void;
}) {
  const selectedName = selection?.catalog ?? defaultCatalogName;
  const catalog = catalogs.find(c => c.catalogName === selectedName);
  if (!catalog) return <div className="p-6 text-sm text-muted-foreground">Catalog “{selectedName}” is not attached. Select a catalog from the sidebar.</div>;
  const onCatalogNavigate = (next: Selection) => onNavigate({ ...next, catalog: next.catalog ?? catalog.catalogName });
  if (catalog.metadataError) return <div role="alert" className="p-6 text-sm"><p>Could not load all metadata for {catalog.catalogName}.</p><p className="text-muted-foreground mt-2">{catalog.metadataError}</p><Button className="mt-3" variant="outline" onClick={() => void catalogInventory.refresh()}>Retry catalog metadata</Button></div>;
  const overview = catalog.catalogName === "memory"
    ? <MemoryCatalogOverview catalog={catalog} onNavigate={onCatalogNavigate} />
    : <CatalogOverview catalog={catalog} serviceUrl={catalog.sourceUrl} attachOptions={connectBoxOptions(catalog)} attachSpecs={catalog.attachSpecs} onNavigate={onCatalogNavigate} />;
  if (!selection || selection.type === "catalog") return overview;

  if (selection.type === "relationships") {
    return (
      <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading relationship explorer…</div>}>
        <CatalogRelationships
          catalog={catalog}
          initialSchema={selection.schema}
          initialFocusTable={selection.focusTable}
          onNavigate={onCatalogNavigate}
        />
      </Suspense>
    );
  }

  const schema = catalog.schemas.find((s) => s.info.name === selection.schema);
  if (!schema) return overview;

  if (selection.type === "schema") {
    return <SchemaDetail schema={schema} onNavigate={onCatalogNavigate} catalogName={catalog.catalogName} onOpenShell={onOpenShell} />;
  }

  if (selection.type === "table") {
    const table = schema.tables.find((t) => t.name === selection.name);
    if (table) return <TableDetail table={table} catalogName={catalog.catalogName} databaseType={catalog.databaseType} onNavigate={onCatalogNavigate} onOpenShell={onOpenShell} onPivot={onPivotTable} />;
  }

  if (selection.type === "view") {
    const view = schema.views.find((v) => v.name === selection.name);
    if (view) return <ViewDetail view={view} catalogName={catalog.catalogName} schemaName={selection.schema} onNavigate={onCatalogNavigate} onOpenShell={onOpenShell} />;
  }

  if (selection.type === "function") {
    const func = schema.functions.find((f) => f.name === selection.name);
    if (func) return <FunctionDetail func={func} catalogName={catalog.catalogName} schemaName={selection.schema} onNavigate={onCatalogNavigate} onOpenShell={onOpenShell} />;
  }

  if (selection.type === "macro") {
    const macro = schema.macros?.find((m) => m.name === selection.name);
    if (macro) return <MacroDetail macro={macro} catalogName={catalog.catalogName} schemaName={selection.schema} onNavigate={onCatalogNavigate} onOpenShell={onOpenShell} />;
  }

  return overview;
}

/** The options a catalog's ConnectBox snippets show: the non-secret values,
 *  plus each secret by name only (the snippet reads it with getenv()). */
function connectBoxOptions(catalog: CatalogData): Record<string, string> | undefined {
  if (!catalog.sourceUrl) return undefined;
  return {
    ...(catalog.attachOptions ?? {}),
    ...Object.fromEntries((catalog.secretOptionNames ?? []).map((name) => [name, ""])),
  };
}

/** The grainlift extension caches each attached gateway's schemas and tables;
 *  an explicit refresh drops that cache so tables created, dropped or altered
 *  on the gateway since the ATTACH show up. Best effort: a failure leaves the
 *  cached catalog in place. */
async function clearGrainliftCaches(): Promise<void> {
  const attached = catalogInventory.getSnapshot().catalogs.some((c) => c.databaseType === "grainlift");
  if (!attached || !engine.query) return;
  try {
    const result = await engine.query("SELECT * FROM grainlift_clear_cache()");
    if (!result.ok) console.warn("[catalog] grainlift_clear_cache failed:", result.error);
  } catch (error) {
    console.warn("[catalog] grainlift_clear_cache failed:", error);
  }
}
