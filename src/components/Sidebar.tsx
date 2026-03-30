import { useState, useMemo } from "react";
import { Search, TerminalSquare } from "lucide-react";
import { Input } from "@/components/ui/input";
import { TreeView } from "@/components/tree-view";
import { SettingsModal } from "@/components/SettingsModal";
import type { CatalogData } from "@/lib/service";
import { useSettings } from "@/lib/settings";
import { buildTreeData, filterTree, parseSelection, selectionToTreeId, type Selection, type TreeDataItem } from "@/lib/tree";

interface Props {
  catalog: CatalogData;
  selection: Selection | null;
  onSelect: (selection: Selection | null) => void;
  onOpenShell?: () => void;
}

export function Sidebar({ catalog, selection, onSelect, onOpenShell }: Props) {
  const [search, setSearch] = useState("");
  const { settings } = useSettings();
  const treeData = useMemo(() => buildTreeData(catalog, {
    showDuckDBTypes: settings.showDuckDBTypes,
    hideTableBackingFunctions: settings.hideTableBackingFunctions,
  }), [catalog, settings.showDuckDBTypes, settings.hideTableBackingFunctions]);
  const filteredData = useMemo(() => filterTree(treeData, search), [treeData, search]);

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
    <div className="w-72 border-r border-border bg-card flex flex-col h-full">
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
      </div>

      {/* Shell + Settings + Copyright */}
      <div className="border-t border-border">
        {onOpenShell && (
          <button
            onClick={onOpenShell}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          >
            <TerminalSquare className="h-4 w-4" />
            SQL Shell
          </button>
        )}
        <SettingsModal />
        <div className="px-3 pb-3 text-xs text-muted-foreground/60">
          &copy; 2026 &#x1F69C; <a href="https://query.farm" className="hover:text-primary transition-colors">Query.Farm LLC</a>
        </div>
      </div>
    </div>
  );
}
