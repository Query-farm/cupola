import { SavedReportsSidebar } from "./evidence/SavedReportsSidebar";
import { useState, useMemo } from "react";
import { Search, Cpu, RefreshCw, Loader2, CheckCircle2, AlertTriangle, LogIn, Database, Star } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { TreeView } from "@/components/tree-view";
import { SettingsModal } from "@/components/SettingsModal";
import type { CatalogData } from "@/lib/service";
import { quoteIdent } from "@/lib/duckdb-query";
import { useSettings } from "@/lib/settings";
import { buildTreeData, filterTree, parseSelection, selectionToTreeId, type Selection } from "@/lib/tree";
import type { CatalogAttachState } from "@/lib/shell-bridge";

/** One configured catalog's status, for its sidebar root. */
export interface SidebarCatalogStatus {
  id: string;
  alias: string;
  url: string;
  state: CatalogAttachState;
  error?: string;
  /** The error panel has something to show. */
  hasDetail: boolean;
  isDefault: boolean;
}

interface Props {
  catalogs: CatalogData[];
  defaultCatalogName: string;
  inventoryError?: string | null;
  serviceUrl?: string;
  selection: Selection | null;
  onSelect: (selection: Selection | null) => void;
  /** Insert text into the DuckDB shell. */
  onShellInsert?: (text: string) => void;
  onRefresh?: () => void;
  refreshing?: boolean;
  /** Each configured catalog's attach status. Empty for a single catalog,
   *  whose failures are full-page. */
  catalogStatuses?: SidebarCatalogStatus[];
  onRetryCatalog?: (id: string) => void;
  onSignInCatalog?: (id: string) => void;
  /** Open the error panel for an alias. */
  onCatalogDetails?: (alias: string) => void;
  /** Back from a sign-in: who is signed in now, and who still needs it. */
  signInNotice?: { signedIn: string | null; remaining: { id: string; alias: string }[] } | null;
  onDismissSignInNotice?: () => void;
}

/** The status mark on an attached catalog's root. */
function statusMark(status: SidebarCatalogStatus | undefined) {
  if (!status) return undefined;
  const label = status.state === "attached" ? `${status.alias} attached` : `${status.alias} connecting`;
  return (
    <span className="inline-flex items-center gap-1" title={status.url}>
      {status.isDefault && <Star className="h-3 w-3 text-muted-foreground" aria-label="default catalog" />}
      {status.state === "attached"
        ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" aria-label={label} />
        : <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-label={label} />}
    </span>
  );
}

export function Sidebar({ serviceUrl, catalogs, defaultCatalogName, inventoryError, selection, onSelect, onShellInsert, onRefresh, refreshing, catalogStatuses = [], onRetryCatalog, onSignInCatalog, onCatalogDetails, signInNotice, onDismissSignInNotice }: Props) {
  const [search, setSearch] = useState("");
  const { settings } = useSettings();
  const statusByAlias = useMemo(() => new Map(catalogStatuses.map((s) => [s.alias, s])), [catalogStatuses]);
  // Configured catalogs in workspace order, then anything else attached by
  // hand, by name; `memory` stays last, on its own.
  const order = useMemo(() => catalogStatuses.map((s) => s.alias), [catalogStatuses]);
  const combinedData = useMemo(() => {
    const rank = (name: string) => name === "memory" ? Number.MAX_SAFE_INTEGER : order.includes(name) ? order.indexOf(name) : order.length;
    return [...catalogs]
      .sort((a, b) => rank(a.catalogName) - rank(b.catalogName) || a.catalogName.localeCompare(b.catalogName))
      .flatMap(catalog => buildTreeData(catalog, {
        showDuckDBTypes: settings.showDuckDBTypes,
        hideTableBackingFunctions: settings.hideTableBackingFunctions,
        hideDollarTables: settings.hideDollarTables,
        rootIcon: catalog.catalogName === "memory" ? Cpu : undefined,
        rootActions: statusMark(statusByAlias.get(catalog.catalogName)),
        onTableAction: onShellInsert ? (schema, table) => onShellInsert([catalog.catalogName, schema, table].map(quoteIdent).join(".")) : undefined,
      }));
  }, [catalogs, order, statusByAlias, settings.showDuckDBTypes, settings.hideTableBackingFunctions, settings.hideDollarTables, onShellInsert]);
  // Configured catalogs that are not (yet) in DuckDB: a root each, with its
  // status and action, that does not expand.
  const inventoryNames = useMemo(() => new Set(catalogs.map((c) => c.catalogName)), [catalogs]);
  const pendingRoots = catalogStatuses.filter((s) => !inventoryNames.has(s.alias) || s.state === "failed" || s.state === "sign-in-required");
  const filteredData = useMemo(() => filterTree(combinedData, search), [combinedData, search]);

  const selectedTreeId = useMemo(
    () => selection ? selectionToTreeId(selection, defaultCatalogName) : defaultCatalogName,
    [selection, defaultCatalogName]
  );

  function handleSelectChange(item: { id: string } | undefined) {
    if (!item) {
      onSelect(null);
      return;
    }
    const sel = parseSelection(item.id);
    onSelect(sel);
  }

  return (
    <div className="bg-card flex flex-col h-full">
      {/* Search */}
      <div className="p-3 border-b border-border flex items-center gap-2">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            type="text"
            placeholder="Filter..."
            aria-label="Filter catalog"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-9 text-sm"
          />
        </div>
        {onRefresh && (
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0"
            aria-label="Refresh catalogs"
            title="Refresh catalogs"
            disabled={refreshing}
            onClick={onRefresh}
          >
            {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
        )}
      </div>

      {signInNotice && (signInNotice.signedIn || signInNotice.remaining.length > 0) && (
        <div role="status" className="px-3 py-2 text-xs border-b border-border bg-muted/50" data-testid="sign-in-notice">
          {signInNotice.signedIn && <span>Signed in to <span className="font-mono">{signInNotice.signedIn}</span>. </span>}
          {signInNotice.remaining.length > 0 && (
            <span>
              {signInNotice.remaining.length} more {signInNotice.remaining.length === 1 ? "needs" : "need"} sign-in:{" "}
              {signInNotice.remaining.map((r) => (
                <button key={r.id} className="underline mr-1.5" onClick={() => onSignInCatalog?.(r.id)}>Sign in to {r.alias}</button>
              ))}
            </span>
          )}
          <button className="ml-1 text-muted-foreground hover:text-foreground" aria-label="Dismiss" onClick={onDismissSignInNotice}>×</button>
        </div>
      )}
      {inventoryError && <div role="alert" className="px-3 py-2 text-xs text-destructive">Could not refresh catalogs: {inventoryError}<button className="block underline mt-1" onClick={onRefresh}>Retry</button></div>}
      {catalogs.filter(c => c.metadataError).map(c => <div role="alert" key={c.catalogName} className="px-3 py-2 text-xs text-destructive">{c.catalogName}: metadata unavailable. <button className="underline" onClick={onRefresh}>Retry</button></div>)}
      {/* Tree */}
      <div className="flex-1 overflow-y-auto p-2 text-sm">
        {pendingRoots.length > 0 && (
          <ul className="mb-1" aria-label="Catalogs not attached" data-testid="catalog-status-roots">
            {pendingRoots.map((s) => (
              <li key={s.id} className="px-2 py-1.5 rounded-md" data-testid="catalog-status-root" data-alias={s.alias} data-state={s.state}>
                <div className="flex items-center gap-2 min-w-0">
                  {s.state === "connecting"
                    ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
                    : s.state === "sign-in-required"
                      ? <LogIn className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                      : s.state === "failed"
                        ? <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
                        : <Database className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
                  <span className="font-bold text-primary truncate" title={s.url}>{s.alias}</span>
                  <span className="ml-auto text-[11px] text-muted-foreground shrink-0">
                    {s.state === "connecting" ? "Connecting…" : s.state === "sign-in-required" ? "Sign-in required" : s.state === "failed" ? "Failed" : "Disabled"}
                  </span>
                </div>
                {s.state === "failed" && s.error && <p className="mt-1 pl-6 text-[11px] text-destructive line-clamp-2 break-words">{s.error}</p>}
                {(s.state === "failed" || s.state === "sign-in-required") && (
                  <div className="mt-1 pl-6 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                    {s.state === "sign-in-required" && <button className="underline" onClick={() => onSignInCatalog?.(s.id)}>Sign in</button>}
                    <button className="underline" onClick={() => onRetryCatalog?.(s.id)}>Retry</button>
                    {s.hasDetail && <button className="underline" onClick={() => onCatalogDetails?.(s.alias)}>Details</button>}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        <TreeView
          data={filteredData}
          expandAll={!!search}
          onSelectChange={handleSelectChange}
          initialSelectedItemId={selectedTreeId}
          trailingDropZone={false}
        />
        {/* Reports follow the catalogs, drawn as one more root of the same tree. */}
        {serviceUrl && <SavedReportsSidebar key={serviceUrl} serviceUrl={serviceUrl} search={search} />}
      </div>

      {/* Settings + Copyright. The SQL Shell has its own tab in the top bar. */}
      <div className="border-t border-border p-2">
        <SettingsModal />
        <div className="border-t border-border mt-3 pt-3 mx-2" />
        <div className="px-2 pb-1 text-xs text-muted-foreground">
          &copy; 2026 &#x1F69C; <a href="https://query.farm" className="hover:text-primary transition-colors">Query.Farm LLC</a>
          <div>v{__APP_VERSION__}</div>
        </div>
      </div>
    </div>
  );
}
