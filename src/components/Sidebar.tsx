import { SavedReportsSidebar } from "./evidence/SavedReportsSidebar";
import { useState, useMemo } from "react";
import { Search, TerminalSquare, Cpu } from "lucide-react";
import { Input } from "@/components/ui/input";
import { TreeView } from "@/components/tree-view";
import { SettingsModal } from "@/components/SettingsModal";
import type { CatalogData } from "@/lib/service";
import { quoteIdent } from "@/lib/duckdb-query";
import { useSettings } from "@/lib/settings";
import { buildTreeData, filterTree, parseSelection, selectionToTreeId, type Selection } from "@/lib/tree";

interface Props {
  catalogs: CatalogData[];
  defaultCatalogName: string;
  inventoryError?: string | null;
  serviceUrl?: string;
  selection: Selection | null;
  onSelect: (selection: Selection | null) => void;
  onOpenShell?: () => void;
  /** Insert text into the DuckDB shell. */
  onShellInsert?: (text: string) => void;
  onRefresh?: () => void;
  refreshing?: boolean;
}

export function Sidebar({ serviceUrl, catalogs, defaultCatalogName, inventoryError, selection, onSelect, onOpenShell, onShellInsert, onRefresh, refreshing }: Props) {
  const [search, setSearch] = useState("");
  const { settings } = useSettings();
  const combinedData = useMemo(() => catalogs.flatMap(catalog => buildTreeData(catalog, {
    showDuckDBTypes: settings.showDuckDBTypes,
    hideTableBackingFunctions: settings.hideTableBackingFunctions,
    hideDollarTables: settings.hideDollarTables,
    rootIcon: catalog.catalogName === "memory" ? Cpu : undefined,
    onTableAction: onShellInsert ? (schema, table) => onShellInsert([catalog.catalogName, schema, table].map(quoteIdent).join(".")) : undefined,
    onRefresh, refreshing,
  })).sort((a, b) => a.name.localeCompare(b.name)), [catalogs, settings.showDuckDBTypes, settings.hideTableBackingFunctions, settings.hideDollarTables, onShellInsert, onRefresh, refreshing]);
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
      <div className="p-3 border-b border-border">
        <div className="relative">
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
      </div>

      {inventoryError && <div role="alert" className="px-3 py-2 text-xs text-destructive">Could not refresh catalogs: {inventoryError}<button className="block underline mt-1" onClick={onRefresh}>Retry</button></div>}
      {catalogs.filter(c => c.metadataError).map(c => <div role="alert" key={c.catalogName} className="px-3 py-2 text-xs text-destructive">{c.catalogName}: metadata unavailable. <button className="underline" onClick={onRefresh}>Retry</button></div>)}
      {/* Tree */}
      <div className="flex-1 overflow-y-auto p-2 text-sm">
        {serviceUrl && <SavedReportsSidebar key={serviceUrl} serviceUrl={serviceUrl} search={search} />}
        <TreeView
          data={filteredData}
          expandAll={!!search}
          onSelectChange={handleSelectChange}
          initialSelectedItemId={selectedTreeId}
        />
      </div>

      {/* Shell + Settings + Copyright */}
      <div className="border-t border-border p-2">
        {onOpenShell && (
          <button
            onClick={onOpenShell}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer rounded-md hover:bg-secondary"
          >
            <TerminalSquare className="h-4 w-4" />
            SQL Shell
          </button>
        )}
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
