import { useEffect, useState, useMemo, useCallback, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { fetchCatalog, getServiceUrl, type CatalogData, type ResolvedSchema } from "@/lib/service";
import { tableFromIPC } from "apache-arrow";
import { type Selection } from "@/lib/tree";
import { getAuthToken } from "@/lib/auth";
import { SettingsProvider } from "@/lib/settings";
import { hashToSelection, updatePageTitle, pushSelectionToUrl } from "@/lib/navigation";
import { lazy, Suspense } from "react";
import { Header } from "./Header";
import { Sidebar } from "./Sidebar";
const DuckDBShell = lazy(() => import("./DuckDBShell").then(m => ({ default: m.DuckDBShell })));
import type { ShellMode } from "./DuckDBShell";
import { CatalogOverview } from "./content/CatalogOverview";
import { MemoryCatalogOverview } from "./content/MemoryCatalogOverview";
import { SchemaDetail } from "./content/SchemaDetail";
import { TableDetail } from "./content/TableDetail";
import { ViewDetail } from "./content/ViewDetail";
import { FunctionDetail } from "./content/FunctionDetail";
import { MacroDetail } from "./content/MacroDetail";

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

  /** Fetch in-memory DuckDB tables via the shell worker. Returns null if shell isn't running. */
  const fetchMemoryTables = useCallback(async () => {
    const queryFn = (window as any).__duckdbQuery;
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
      if (table.numRows === 0) { setMemoryCatalog(null); return; }

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

      // Build CatalogData structure
      const schemas: ResolvedSchema[] = [];
      for (const [schemaName, tableMap] of schemaMap) {
        const tables: any[] = [];
        for (const [tableName, columns] of tableMap) {
          tables.push({
            name: tableName,
            schemaName,
            comment: commentMap.get(`${schemaName}.${tableName}`) || "",
            columns: new Uint8Array(0),
            primaryKeyConstraints: [],
            uniqueConstraints: [],
            checkConstraints: [],
            notNullConstraints: [],
            foreignKeyConstraints: [],
            _columnInfo: columns.map((c) => ({
              name: c.name,
              arrowType: c.type,
              duckdbType: c.type,
              nullable: c.nullable,
            })),
          });
        }
        schemas.push({
          info: { name: schemaName, comment: "" } as any,
          tables,
          views: [],
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

  // Expose refresh globally (navigate is exposed after it's defined below)
  if (typeof window !== "undefined") {
    (window as any).__refreshMemoryTables = fetchMemoryTables;
    (window as any).__memoryCatalog = memoryCatalog;
  }

  // Persist shell mode to localStorage
  useEffect(() => {
    try { localStorage.setItem("vgi-shell-mode", shellMode); } catch {}
  }, [shellMode]);

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
        (window as any).__shellFitAddon?.fit();
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
        (window as any).__shellFitAddon?.fit();
        setTimeout(() => (window as any).__shellFitAddon?.fit(), 50);
      });
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }, [shellHeight]);

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
    },
    [data]
  );

  // Expose navigate globally so AI agent can select newly created objects
  if (typeof window !== "undefined") {
    (window as any).__navigateToSelection = navigate;
  }

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
          const defaultSchema = catalog.defaultSchema || catalog.schemas[0]?.info.name;
          const initialSel = hashSel ?? (defaultSchema
            ? { type: "schema" as const, name: defaultSchema, schema: defaultSchema }
            : { type: "catalog" as const, name: catalog.catalogName });
          setSelection(initialSel);
          updatePageTitle(initialSel, catalog.catalogName);
        }
        // Also refresh memory tables if shell is running
        if ((window as any).__duckdbQuery) {
          await fetchMemoryTables();
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
      {shellMode !== "fullscreen" && (
        <Header
          catalogName={data.catalogName}
          catalogComment={data.catalogComment}
          serviceUrl={serviceUrl}
        />
      )}
      <div className="flex flex-1 overflow-hidden">
        {shellMode !== "fullscreen" && (
          <>
            <div style={{ width: sidebarWidth, minWidth: sidebarWidth }}>
              <Sidebar
                catalog={data}
                memoryCatalog={memoryCatalog}
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
            <ContentPanel data={data} memoryCatalog={memoryCatalog} selection={selection} serviceUrl={serviceUrl} onNavigate={navigate} onOpenShell={() => setShellMode((m) => m === "minimized" ? "panel" : m)} shellMode={shellMode} />
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
          <Suspense fallback={
            <div style={{ height: shellMode === "minimized" ? 36 : shellMode === "panel" ? shellHeight : undefined }}
                 className={`flex items-center justify-center bg-[#1a1a0e] text-[#6ba034] shrink-0 border-t border-border ${shellMode === "maximized" || shellMode === "fullscreen" ? "flex-1" : ""}`}>
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
                onShellReady={(insert) => { shellInsertRef.current = insert; fetchMemoryTables(); }}
                catalogData={data}
                selection={selection}
              />
            </div>
          </Suspense>
        </div>
      </div>
    </div>
    </SettingsProvider>
  );
}

function ContentPanel({
  data,
  memoryCatalog,
  selection,
  serviceUrl,
  onNavigate,
  onOpenShell,
  shellMode,
}: {
  data: CatalogData;
  memoryCatalog?: CatalogData | null;
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
    return <CatalogOverview catalog={data} serviceUrl={serviceUrl} onNavigate={onNavigate} />;
  }

  // Determine which catalog to search
  const catalog = (selection.catalog && memoryCatalog && selection.catalog === memoryCatalog.catalogName)
    ? memoryCatalog
    : data;

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
