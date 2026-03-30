import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { Search, TerminalSquare, Table2, ClipboardCopy } from "lucide-react";
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
  /** When true, tree clicks only expand/collapse — don't navigate to content. */
  treeOnly?: boolean;
  /** Insert text into the DuckDB shell (only when shell is open). */
  onShellInsert?: (text: string) => void;
}

export function Sidebar({ catalog, selection, onSelect, onOpenShell, treeOnly, onShellInsert }: Props) {
  const [search, setSearch] = useState("");
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; schema: string; table: string } | null>(null);
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
    // In treeOnly mode, just let the tree expand/collapse — don't navigate
    if (treeOnly) return;
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
      <div
        className="flex-1 overflow-y-auto p-2 text-sm relative"
        onContextMenu={(e) => {
          if (!onShellInsert) return; // Only show context menu when shell is open
          // Walk up from target to find the tree item with a data ID
          let el = e.target as HTMLElement;
          while (el && !el.getAttribute?.("role")?.includes("button") && el.parentElement) {
            el = el.parentElement;
          }
          const name = el?.textContent?.trim();
          if (!name) return;
          // Try to parse as a table reference from the tree
          const sel = parseSelection(
            // Find the closest accordion item ID
            el?.closest?.("[data-state]")?.querySelector?.("[role=button]")?.textContent?.trim() || name
          );
          // We need schema + table. Check the tree data structure.
          // Simpler: find the nearest tree button text and try to resolve it
          // For now, search the catalog for a matching table name
          for (const schema of catalog.schemas) {
            const table = schema.tables.find(t => t.name === name);
            if (table) {
              e.preventDefault();
              setContextMenu({ x: e.clientX, y: e.clientY, schema: schema.info.name, table: name });
              return;
            }
          }
        }}
      >
        <TreeView
          data={filteredData}
          expandAll={!!search}
          onSelectChange={handleSelectChange}
          initialSelectedItemId={selectedTreeId}
        />

        {/* Context menu for shell insertion */}
        {contextMenu && onShellInsert && (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            schema={contextMenu.schema}
            table={contextMenu.table}
            onInsert={(text) => { onShellInsert(text); setContextMenu(null); }}
            onClose={() => setContextMenu(null)}
          />
        )}
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

/** Context menu for inserting table references into the DuckDB shell. */
function ContextMenu({ x, y, schema, table, onInsert, onClose }: {
  x: number; y: number; schema: string; table: string;
  onInsert: (text: string) => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  const tableName = `${schema}.${table}`;
  const selectSql = `SELECT * FROM ${schema}.${table} LIMIT 10;`;

  return (
    <div
      ref={ref}
      className="fixed z-50 bg-card border border-border rounded-md shadow-lg py-1 min-w-[200px]"
      style={{ left: x, top: y }}
    >
      <button
        className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-left hover:bg-muted transition-colors"
        onClick={() => onInsert(tableName)}
      >
        <Table2 className="h-3.5 w-3.5 text-muted-foreground" />
        Paste table name
      </button>
      <button
        className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-left hover:bg-muted transition-colors"
        onClick={() => onInsert(selectSql)}
      >
        <ClipboardCopy className="h-3.5 w-3.5 text-muted-foreground" />
        Paste SELECT statement
      </button>
    </div>
  );
}
