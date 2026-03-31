import { useEffect, useState, useMemo, useCallback, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { fetchCatalog, getServiceUrl, type CatalogData } from "@/lib/service";
import { type Selection } from "@/lib/tree";
import { getAuthToken } from "@/lib/auth";
import { SettingsProvider } from "@/lib/settings";
import { hashToSelection, updatePageTitle, pushSelectionToUrl } from "@/lib/navigation";
import { lazy, Suspense } from "react";
import { Header } from "./Header";
import { Sidebar } from "./Sidebar";
const DuckDBShell = lazy(() => import("./DuckDBShell").then(m => ({ default: m.DuckDBShell })));
import { CatalogOverview } from "./content/CatalogOverview";
import { SchemaDetail } from "./content/SchemaDetail";
import { TableDetail } from "./content/TableDetail";
import { ViewDetail } from "./content/ViewDetail";
import { FunctionDetail } from "./content/FunctionDetail";

export function CatalogApp() {
  const [data, setData] = useState<CatalogData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [shellOpen, setShellOpen] = useState(false);
  const [shellMaximized, setShellMaximized] = useState(false);
  const shellInsertRef = useRef<((text: string) => void) | null>(null);
  const [tableShellOpen, setTableShellOpen] = useState(false);
  const tableShellInsertRef = useRef<((text: string) => void) | null>(null);

  // Table shell vertical resize
  const TABLE_SHELL_MIN = 150;
  const TABLE_SHELL_MAX = 600;
  const TABLE_SHELL_DEFAULT = 300;
  const TABLE_SHELL_STORAGE_KEY = "vgi-table-shell-height";
  const [tableShellHeight, setTableShellHeight] = useState(() => {
    try {
      const stored = localStorage.getItem(TABLE_SHELL_STORAGE_KEY);
      if (stored) {
        const n = parseInt(stored, 10);
        if (n >= TABLE_SHELL_MIN && n <= TABLE_SHELL_MAX) return n;
      }
    } catch {}
    return TABLE_SHELL_DEFAULT;
  });
  const shellResizing = useRef(false);

  const onShellResizeStart = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    shellResizing.current = true;
    const startY = e.clientY;
    const startHeight = tableShellHeight;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);

    const onMove = (ev: globalThis.PointerEvent) => {
      // Dragging up increases height
      const newHeight = Math.min(TABLE_SHELL_MAX, Math.max(TABLE_SHELL_MIN, startHeight - (ev.clientY - startY)));
      setTableShellHeight(newHeight);
    };
    const onUp = () => {
      shellResizing.current = false;
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      setTableShellHeight((h) => {
        localStorage.setItem(TABLE_SHELL_STORAGE_KEY, String(h));
        return h;
      });
      // Refit terminal after resize
      if ((window as any).__shellFitAddon) {
        setTimeout(() => (window as any).__shellFitAddon.fit(), 50);
      }
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }, [tableShellHeight]);
  const serviceUrl = useMemo(() => getServiceUrl(), []);

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
      // Close table shell when navigating away from a table
      if (sel?.type !== "table") {
        setTableShellOpen(false);
        tableShellInsertRef.current = null;
      }
    },
    [data]
  );

  const loadCatalog = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      try {
        const catalog = await fetchCatalog(serviceUrl);
        setData(catalog);
        setError(null);
        if (!isRefresh) {
          // Restore selection from URL hash, or default to catalog root
          const hashSel = hashToSelection(window.location.hash);
          const initialSel = hashSel ?? { type: "catalog" as const, name: catalog.catalogName };
          setSelection(initialSel);
          updatePageTitle(initialSel, catalog.catalogName);
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Failed to connect");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [serviceUrl]
  );

  useEffect(() => {
    loadCatalog();
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
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center max-w-md">
          <img
            src="https://vgi-rpc-python.query.farm/assets/logo-hero.png"
            alt="VGI logo"
            className="w-16 h-16 rounded-full shadow-lg mx-auto mb-6"
          />
          <h1 className="text-2xl font-bold text-primary mb-4">
            {isAuthError ? "Authentication Required" : "Connection Error"}
          </h1>
          <p className="text-muted-foreground mb-6">{error}</p>
          {isAuthError ? (
            <a
              href={serviceUrl}
              className="inline-block px-6 py-2 rounded-md bg-primary text-primary-foreground font-semibold hover:bg-accent transition-colors"
            >
              Sign in
            </a>
          ) : (
            <p className="text-sm text-muted-foreground">
              Service URL: <code className="bg-muted px-2 py-0.5 rounded">{serviceUrl}</code>
            </p>
          )}
        </div>
      </div>
    );
  }

  if (!data) return null;

  return (
    <SettingsProvider>
    <div className="flex flex-col h-screen">
      <Header
        catalogName={data.catalogName}
        serviceUrl={serviceUrl}
      />
      <div className="flex flex-1 overflow-hidden">
        {!shellMaximized && (
          <>
            <div style={{ width: sidebarWidth, minWidth: sidebarWidth }}>
              <Sidebar catalog={data} selection={selection} onSelect={(sel) => { if (shellOpen) { setShellOpen(false); setShellMaximized(false); } navigate(sel); }} onOpenShell={() => setShellOpen(true)} treeOnly={shellOpen} onShellInsert={shellOpen ? (text) => shellInsertRef.current?.(text) : undefined} onRefresh={() => loadCatalog(true)} refreshing={refreshing} />
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
          {shellOpen ? (
            <Suspense fallback={<div className="flex-1 flex items-center justify-center bg-[#1a1a0e] text-[#6ba034]">Loading...</div>}>
              <DuckDBShell
                serviceUrl={serviceUrl}
                catalogName={data.catalogName}
                onClose={() => { setShellOpen(false); setShellMaximized(false); shellInsertRef.current = null; }}
                maximized={shellMaximized}
                onToggleMaximize={() => setShellMaximized(!shellMaximized)}
                onShellReady={(insert) => { shellInsertRef.current = insert; }}
              />
            </Suspense>
          ) : (
            <>
              <main className="flex-1 overflow-y-auto p-6 min-h-0">
                <ContentPanel data={data} selection={selection} serviceUrl={serviceUrl} onNavigate={navigate} onOpenTableShell={() => setTableShellOpen(true)} tableShellOpen={tableShellOpen} />
              </main>
              {tableShellOpen && selection?.type === "table" && (
                <Suspense fallback={<div style={{ height: tableShellHeight }} className="flex items-center justify-center bg-[#1a1a0e] text-[#6ba034] shrink-0 border-t border-border">Loading...</div>}>
                  {/* Resize handle */}
                  <div
                    onPointerDown={onShellResizeStart}
                    className="h-2 -mb-1 -mt-1 z-10 cursor-row-resize group flex-shrink-0 flex items-center justify-center"
                  >
                    <div className="h-0.5 w-12 rounded bg-border group-hover:bg-accent/60 group-active:bg-accent transition-colors" />
                  </div>
                  <div style={{ height: `calc(${tableShellHeight}px - 24px)` }} className="shrink-0 border-t border-border">
                    <DuckDBShell
                      serviceUrl={serviceUrl}
                      catalogName={data.catalogName}
                      onClose={() => { setTableShellOpen(false); tableShellInsertRef.current = null; }}
                      maximized={false}
                      onToggleMaximize={() => {}}
                      onShellReady={(insert) => { tableShellInsertRef.current = insert; }}
                      shellOnly
                    />
                  </div>
                </Suspense>
              )}
            </>
          )}
        </div>
      </div>
    </div>
    </SettingsProvider>
  );
}

function ContentPanel({
  data,
  selection,
  serviceUrl,
  onNavigate,
  onOpenTableShell,
  tableShellOpen,
}: {
  data: CatalogData;
  selection: Selection | null;
  serviceUrl: string;
  onNavigate: (selection: Selection) => void;
  onOpenTableShell?: () => void;
  tableShellOpen?: boolean;
}) {
  if (!selection || selection.type === "catalog") {
    return <CatalogOverview catalog={data} serviceUrl={serviceUrl} onNavigate={onNavigate} />;
  }

  const schema = data.schemas.find((s) => s.info.name === selection.schema);
  if (!schema) return <CatalogOverview catalog={data} serviceUrl={serviceUrl} onNavigate={onNavigate} />;

  if (selection.type === "schema") {
    return <SchemaDetail schema={schema} onNavigate={onNavigate} />;
  }

  if (selection.type === "table") {
    const table = schema.tables.find((t) => t.name === selection.name);
    if (table) return <TableDetail table={table} catalogName={data.catalogName} onNavigate={onNavigate} onOpenShell={onOpenTableShell} shellOpen={tableShellOpen} />;
  }

  if (selection.type === "view") {
    const view = schema.views.find((v) => v.name === selection.name);
    if (view) return <ViewDetail view={view} />;
  }

  if (selection.type === "function") {
    const func = schema.functions.find((f) => f.name === selection.name);
    if (func) return <FunctionDetail func={func} />;
  }

  return <CatalogOverview catalog={data} serviceUrl={serviceUrl} onNavigate={onNavigate} />;
}
