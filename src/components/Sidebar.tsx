import { useState, useMemo } from "react";
import { Search, TerminalSquare, HardDrive } from "lucide-react";
import { Input } from "@/components/ui/input";
import { TreeView } from "@/components/tree-view";
import { SettingsModal } from "@/components/SettingsModal";
import type { CatalogData } from "@/lib/service";
import { useSettings } from "@/lib/settings";
import { buildTreeData, filterTree, parseSelection, selectionToTreeId, type Selection, type TreeDataItem } from "@/lib/tree";

interface Props {
  catalog: CatalogData;
  memoryCatalog?: CatalogData | null;
  selection: Selection | null;
  onSelect: (selection: Selection | null) => void;
  onOpenShell?: () => void;
  /** Insert text into the DuckDB shell. */
  onShellInsert?: (text: string) => void;
  onRefresh?: () => void;
  refreshing?: boolean;
}

export function Sidebar({ catalog, memoryCatalog, selection, onSelect, onOpenShell, onShellInsert, onRefresh, refreshing }: Props) {
  const [search, setSearch] = useState("");
  const { settings } = useSettings();
  const treeData = useMemo(() => buildTreeData(catalog, {
    showDuckDBTypes: settings.showDuckDBTypes,
    hideTableBackingFunctions: settings.hideTableBackingFunctions,
    onTableAction: onShellInsert ? (schema, table) => onShellInsert(`${catalog.catalogName}.${schema}.${table}`) : undefined,
    onRefresh,
    refreshing,
  }), [catalog, settings.showDuckDBTypes, settings.hideTableBackingFunctions, onShellInsert, onRefresh, refreshing]);
  const filteredData = useMemo(() => filterTree(treeData, search), [treeData, search]);

  // Memory catalog tree (only when shell is running and has tables)
  const memoryTreeData = useMemo(() => {
    if (!memoryCatalog || memoryCatalog.schemas.length === 0) return null;
    // Check if there are any actual tables
    const hasTables = memoryCatalog.schemas.some(s => s.tables.length > 0);
    if (!hasTables) return null;
    return buildTreeData(memoryCatalog, {
      showDuckDBTypes: settings.showDuckDBTypes,
      rootIcon: HardDrive,
      onTableAction: onShellInsert ? (schema, table) => onShellInsert(`memory.${schema}.${table}`) : undefined,
    });
  }, [memoryCatalog, settings.showDuckDBTypes]);
  const filteredMemoryData = useMemo(
    () => memoryTreeData ? filterTree(memoryTreeData, search) : null,
    [memoryTreeData, search]
  );

  const selectedTreeId = useMemo(
    () => selection ? selectionToTreeId(selection, catalog.catalogName) : catalog.catalogName,
    [selection, catalog.catalogName]
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
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-9 text-sm"
          />
        </div>
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-y-auto p-2 text-sm">
        <TreeView
          data={filteredData}
          expandAll={!!search}
          onSelectChange={handleSelectChange}
          initialSelectedItemId={selectedTreeId}
        />
        {filteredMemoryData && (
          <div className="mt-2 pt-2 border-t border-border">
            <TreeView
              data={filteredMemoryData}
              expandAll={!!search}
              onSelectChange={handleSelectChange}
            />
          </div>
        )}
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
        <div className="px-2 pb-1 text-xs text-muted-foreground/60">
          &copy; 2026 &#x1F69C; <a href="https://query.farm" className="hover:text-primary transition-colors">Query.Farm LLC</a>
        </div>
      </div>
    </div>
  );
}

