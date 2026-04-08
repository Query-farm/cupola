import React, { useState, useMemo } from "react";
import { Search, TerminalSquare, Cpu, RefreshCw, Loader2 } from "lucide-react";
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

function buildRefreshAction(onRefresh: () => void, refreshing?: boolean): React.ReactNode {
  return React.createElement("div", {
    role: "button",
    tabIndex: 0,
    className: "p-0.5 text-muted-foreground hover:text-primary transition-colors cursor-pointer",
    title: "Refresh catalog",
    "aria-disabled": refreshing || undefined,
    onClick: (e: React.MouseEvent) => { e.stopPropagation(); if (!refreshing) onRefresh(); },
    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); e.preventDefault(); if (!refreshing) onRefresh(); } },
  }, React.createElement(refreshing ? Loader2 : RefreshCw, {
    className: `h-3.5 w-3.5${refreshing ? " animate-spin" : ""}`,
  }));
}

export function Sidebar({ catalog, memoryCatalog, selection, onSelect, onOpenShell, onShellInsert, onRefresh, refreshing }: Props) {
  const [search, setSearch] = useState("");
  const { settings } = useSettings();
  const treeData = useMemo(() => buildTreeData(catalog, {
    showDuckDBTypes: settings.showDuckDBTypes,
    hideTableBackingFunctions: settings.hideTableBackingFunctions,
    onTableAction: onShellInsert ? (schema, table) => onShellInsert(`${catalog.catalogName}.${schema}.${table}`) : undefined,
  }), [catalog, settings.showDuckDBTypes, settings.hideTableBackingFunctions, onShellInsert]);
  // Memory catalog tree nodes (merged into main tree)
  const memoryTreeData = useMemo(() => {
    if (!memoryCatalog) return [];
    return buildTreeData(memoryCatalog, {
      showDuckDBTypes: settings.showDuckDBTypes,
      rootIcon: Cpu,
      onTableAction: onShellInsert ? (schema, table) => onShellInsert(`memory.${schema}.${table}`) : undefined,
    });
  }, [memoryCatalog, settings.showDuckDBTypes]);

  const combinedData = useMemo(() => {
    const sorted = [...treeData, ...memoryTreeData].sort((a, b) => a.name.localeCompare(b.name));
    // Attach refresh action to the first catalog node
    if (sorted.length > 0 && onRefresh) {
      sorted[0] = { ...sorted[0], actions: buildRefreshAction(onRefresh, refreshing) };
    }
    return sorted;
  }, [treeData, memoryTreeData, onRefresh, refreshing]);
  const filteredData = useMemo(() => filterTree(combinedData, search), [combinedData, search]);

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
            aria-label="Filter catalog"
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
        <div className="px-2 pb-1 text-xs text-muted-foreground/60">
          &copy; 2026 &#x1F69C; <a href="https://query.farm" className="hover:text-primary transition-colors">Query.Farm LLC</a>
        </div>
      </div>
    </div>
  );
}

