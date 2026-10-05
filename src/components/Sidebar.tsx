import { SavedNotebooksSidebar } from './notebooks/SavedNotebooksSidebar';
import { SavedReportsSidebar } from "./evidence/SavedReportsSidebar";
import { useState, useMemo, useRef, useCallback } from "react";
import { Search, Cpu, RefreshCw, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { TreeView } from "@/components/tree-view";
import { SettingsModal } from "@/components/SettingsModal";
import type { CatalogData } from "@/lib/service";
import { quoteIdent } from "@/lib/duckdb-query";
import { useSettings } from "@/lib/settings";
import { buildTreeData, filterTree, parseSelection, selectionToTreeId, type Selection, type TreeDataItem } from "@/lib/tree";
import { callablesForSelection, type Callable } from "@/lib/callable";
import { findRelation } from "@/lib/relation";
import { CallableHoverCard, RelationHoverCard } from "@/components/inspector/HoverCards";

interface Props {
  catalogs: CatalogData[];
  defaultCatalogName: string;
  inventoryError?: string | null;
  serviceUrl?: string;
  activeNotebookId?: string | null;
  notebooksActive?: boolean;
  selection: Selection | null;
  onSelect: (selection: Selection | null) => void;
  /** Insert text into the DuckDB shell (or the editor, per `insertTarget`). */
  onShellInsert?: (text: string) => void;
  /** Insert a call to a function or macro. */
  onInsertCallable?: (callable: Callable) => void;
  /** Where inserts land. In the editor, a modifier-click inserts instead of selecting. */
  insertTarget?: "shell" | "editor";
  onRefresh?: () => void;
  refreshing?: boolean;
}

export function Sidebar({ activeNotebookId, notebooksActive, serviceUrl, catalogs, defaultCatalogName, inventoryError, selection, onSelect, onShellInsert, onInsertCallable, insertTarget = "shell", onRefresh, refreshing }: Props) {
  const [search, setSearch] = useState("");
  const { settings } = useSettings();
  // The parent passes fresh callbacks every render; read them through refs so
  // the tree (rebuilt only when its inputs change) never holds a stale one.
  const insertRef = useRef(onShellInsert);
  insertRef.current = onShellInsert;
  const insertCallableRef = useRef(onInsertCallable);
  insertCallableRef.current = onInsertCallable;
  const catalogsRef = useRef(catalogs);
  catalogsRef.current = catalogs;
  const canInsert = !!onShellInsert;
  const canInsertCallable = !!onInsertCallable;

  const insertRelation = useCallback((catalog: string, schema: string, name: string) => {
    insertRef.current?.([catalog, schema, name].map(quoteIdent).join("."));
  }, []);
  const insertCallable = useCallback((catalog: string, schema: string, name: string, kind: "function" | "macro") => {
    const [callable] = callablesForSelection(catalogsRef.current, { type: kind, catalog, schema, name });
    if (callable) insertCallableRef.current?.(callable);
  }, []);

  const combinedData = useMemo(() => catalogs.flatMap(catalog => buildTreeData(catalog, {
    showDuckDBTypes: settings.showDuckDBTypes,
    hideTableBackingFunctions: settings.hideTableBackingFunctions,
    hideDollarTables: settings.hideDollarTables,
    rootIcon: catalog.catalogName === "memory" ? Cpu : undefined,
    insertTarget,
    onTableAction: canInsert ? (schema, table) => insertRelation(catalog.catalogName, schema, table) : undefined,
    onCallableAction: canInsertCallable ? (schema, name, kind) => insertCallable(catalog.catalogName, schema, name, kind) : undefined,
  })).sort((a, b) => a.name.localeCompare(b.name)), [catalogs, settings.showDuckDBTypes, settings.hideTableBackingFunctions, settings.hideDollarTables, canInsert, canInsertCallable, insertTarget, insertRelation, insertCallable]);
  const filteredData = useMemo(() => filterTree(combinedData, search), [combinedData, search]);

  const selectedTreeId = useMemo(
    () => selection ? selectionToTreeId(selection, defaultCatalogName) : defaultCatalogName,
    [selection, defaultCatalogName]
  );

  function handleSelectChange(item: { id: string } | undefined, event?: React.MouseEvent | React.KeyboardEvent) {
    if (!item) {
      onSelect(null);
      return;
    }
    const sel = parseSelection(item.id);
    // In the editor, a modifier-click writes the object into the query.
    if (insertTarget === "editor" && event && (event.metaKey || event.ctrlKey) && sel?.catalog && sel.schema && !item.id.includes("::c:")) {
      if (sel.type === "function" || sel.type === "macro") {
        event.preventDefault();
        insertCallable(sel.catalog, sel.schema, sel.name, sel.type);
        return;
      }
      if (sel.type === "table" || sel.type === "view") {
        event.preventDefault();
        insertRelation(sel.catalog, sel.schema, sel.name);
        return;
      }
    }
    onSelect(sel);
  }

  // Built only when a card opens, so hovering costs nothing until then.
  const renderHover = useCallback((item: TreeDataItem) => {
    if (item.id.includes("::c:")) return null;
    const sel = parseSelection(item.id);
    if (!sel) return null;
    const editor = insertTarget === "editor";
    const callables = callablesForSelection(catalogsRef.current, sel);
    if (callables.length) return <CallableHoverCard callables={callables} editor={editor} />;
    const relation = findRelation(catalogsRef.current, sel);
    if (relation) return <RelationHoverCard relation={relation} editor={editor} />;
    return null;
  }, [insertTarget]);

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

      {inventoryError && <div role="alert" className="px-3 py-2 text-xs text-destructive">Could not refresh catalogs: {inventoryError}<button className="block underline mt-1" onClick={onRefresh}>Retry</button></div>}
      {catalogs.filter(c => c.metadataError).map(c => <div role="alert" key={c.catalogName} className="px-3 py-2 text-xs text-destructive">{c.catalogName}: metadata unavailable. <button className="underline" onClick={onRefresh}>Retry</button></div>)}
      {/* Tree */}
      <div className="flex-1 overflow-y-auto p-2 text-sm">
        <TreeView
          data={filteredData}
          expandAll={!!search}
          onSelectChange={handleSelectChange}
          renderHover={renderHover}
          initialSelectedItemId={selectedTreeId}
          trailingDropZone={false}
        />
        {serviceUrl && <SavedNotebooksSidebar key={`notebooks-${serviceUrl}`} serviceUrl={serviceUrl} search={search} activeId={notebooksActive ? activeNotebookId : undefined} libraryActive={notebooksActive && !activeNotebookId} />}
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
