import { useEffect, useState, useMemo, useCallback } from "react";
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
  const serviceUrl = useMemo(() => getServiceUrl(), []);

  // Navigate: update selection, URL hash, and page title
  const navigate = useCallback(
    (sel: Selection | null) => {
      setSelection(sel);
      pushSelectionToUrl(sel);
      if (data) updatePageTitle(sel, data.catalogName);
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
        onRefresh={() => loadCatalog(true)}
        refreshing={refreshing}
      />
      <div className="flex flex-1 overflow-hidden">
        {!shellMaximized && (
          <Sidebar catalog={data} selection={selection} onSelect={(sel) => { if (shellOpen) { setShellOpen(false); setShellMaximized(false); } navigate(sel); }} onOpenShell={() => setShellOpen(true)} treeOnly={shellOpen} />
        )}
        <div className="flex-1 flex flex-col overflow-hidden">
          {shellOpen ? (
            <Suspense fallback={<div className="flex-1 flex items-center justify-center bg-[#1a1a0e] text-[#6ba034]">Loading...</div>}>
              <DuckDBShell
                serviceUrl={serviceUrl}
                catalogName={data.catalogName}
                onClose={() => { setShellOpen(false); setShellMaximized(false); }}
                maximized={shellMaximized}
                onToggleMaximize={() => setShellMaximized(!shellMaximized)}
              />
            </Suspense>
          ) : (
            <main className="flex-1 overflow-y-auto p-6">
              <ContentPanel data={data} selection={selection} serviceUrl={serviceUrl} onNavigate={navigate} />
            </main>
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
}: {
  data: CatalogData;
  selection: Selection | null;
  serviceUrl: string;
  onNavigate: (selection: Selection) => void;
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
    if (table) return <TableDetail table={table} catalogName={data.catalogName} onNavigate={onNavigate} />;
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
