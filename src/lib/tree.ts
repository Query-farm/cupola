/**
 * Builds TreeDataItem[] from CatalogData for the sidebar tree view.
 * Structure: catalog → schemas → tables (with column children), views, functions
 */

import React from "react";
import { Database, Folder, FolderOpen, Table2, Eye, FunctionSquare, Columns3, TerminalSquare, RefreshCw, Loader2 } from "lucide-react";
import type { CatalogData, ResolvedSchema, ColumnInfo } from "./service";
import { getColumns } from "./service";

interface TreeDataItem {
  id: string;
  name: string;
  icon?: React.ComponentType<{ className?: string }>;
  selectedIcon?: React.ComponentType<{ className?: string }>;
  openIcon?: React.ComponentType<{ className?: string }>;
  children?: TreeDataItem[];
  actions?: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}

export type { TreeDataItem };

/** Selection state for the content panel. */
export interface Selection {
  type: "catalog" | "schema" | "table" | "view" | "function";
  name: string;
  schema?: string;
}

/** Convert a Selection back to a tree item ID. */
export function selectionToTreeId(selection: Selection, catalogName: string): string {
  if (selection.type === "catalog") return catalogName;
  const schema = selection.schema ?? selection.name;
  if (selection.type === "schema") return `${catalogName}::${schema}`;
  const prefix = selection.type === "table" ? "t" : selection.type === "view" ? "v" : "f";
  return `${catalogName}::${schema}::${prefix}:${selection.name}`;
}

/** Parse a tree item ID back into a Selection. */
export function parseSelection(id: string): Selection | null {
  const parts = id.split("::");
  if (parts.length === 1) return { type: "catalog", name: parts[0] };
  if (parts.length === 2) return { type: "schema", name: parts[1], schema: parts[1] };
  if (parts.length === 3) {
    const [, schema, rest] = parts;
    if (rest.startsWith("t:")) return { type: "table", name: rest.slice(2), schema };
    if (rest.startsWith("v:")) return { type: "view", name: rest.slice(2), schema };
    if (rest.startsWith("f:")) return { type: "function", name: rest.slice(2), schema };
    // Column — select the parent table
    if (rest.startsWith("c:")) {
      const colParts = rest.slice(2).split("/");
      return { type: "table", name: colParts[0], schema };
    }
  }
  return null;
}

/** Options for building tree data. */
export interface BuildTreeOptions {
  showDuckDBTypes?: boolean;
  hideTableBackingFunctions?: boolean;
  /** When provided, adds a paste action button to table nodes. */
  onTableAction?: (schema: string, table: string) => void;
  /** When provided, adds a refresh button to the catalog root node. */
  onRefresh?: () => void;
  refreshing?: boolean;
}

/** Build the full tree from catalog data. Root node is the catalog. */
export function buildTreeData(catalog: CatalogData, options: BuildTreeOptions = {}): TreeDataItem[] {
  const { showDuckDBTypes = true, hideTableBackingFunctions = true, onTableAction, onRefresh, refreshing } = options;
  const sortedSchemas = [...catalog.schemas].sort((a, b) =>
    a.info.name.localeCompare(b.info.name)
  );
  const root: TreeDataItem = {
    id: catalog.catalogName,
    name: catalog.catalogName,
    icon: Database,
    selectedIcon: Database,
    openIcon: Database,
    children: sortedSchemas.map((s) =>
      buildSchemaNode(catalog.catalogName, s, showDuckDBTypes, hideTableBackingFunctions, s.info.name === catalog.defaultSchema, onTableAction)
    ),
    actions: onRefresh
      ? React.createElement("button", {
          className: "p-0.5 text-muted-foreground hover:text-primary transition-colors cursor-pointer",
          title: "Refresh catalog",
          disabled: refreshing,
          onClick: (e: React.MouseEvent) => { e.stopPropagation(); onRefresh(); },
        }, React.createElement(refreshing ? Loader2 : RefreshCw, {
          className: `h-3.5 w-3.5${refreshing ? " animate-spin" : ""}`,
        }))
      : undefined,
  };
  return [root];
}

function buildSchemaNode(catalogName: string, schema: ResolvedSchema, showDuckDBTypes: boolean, hideTableBackingFunctions: boolean, isDefault: boolean, onTableAction?: (schema: string, table: string) => void): TreeDataItem {
  const schemaId = `${catalogName}::${schema.info.name}`;
  const children: TreeDataItem[] = [];

  // Tables with column children (sorted alphabetically)
  const sortedTables = [...schema.tables].sort((a, b) => a.name.localeCompare(b.name));
  for (const table of sortedTables) {
    const tableId = `${schemaId}::t:${table.name}`;
    const columns = getColumns(table);
    const columnChildren: TreeDataItem[] = columns.map((col) => ({
      id: `${schemaId}::c:${table.name}/${col.name}`,
      name: col.name,
      icon: Columns3,
      draggable: !!onTableAction,
      actions: React.createElement("span", {
        className: "text-xs text-muted-foreground/70 font-mono ml-1 truncate",
      }, showDuckDBTypes ? col.duckdbType : col.arrowType),
    }));

    children.push({
      id: tableId,
      name: table.name,
      icon: Table2,
      selectedIcon: Table2,
      draggable: !!onTableAction,
      children: columnChildren.length > 0 ? columnChildren : undefined,
      actions: onTableAction
        ? React.createElement("button", {
            className: "opacity-0 group-hover:opacity-100 p-0.5 text-muted-foreground hover:text-primary transition-all",
            title: `Paste ${schema.info.name}.${table.name} into shell`,
            onClick: (e: React.MouseEvent) => { e.stopPropagation(); onTableAction(schema.info.name, table.name); },
          }, React.createElement(TerminalSquare, { className: "h-3 w-3" }))
        : undefined,
    });
  }

  // Views (sorted alphabetically)
  const sortedViews = [...schema.views].sort((a, b) => a.name.localeCompare(b.name));
  for (const view of sortedViews) {
    children.push({
      id: `${schemaId}::v:${view.name}`,
      name: view.name,
      icon: Eye,
      selectedIcon: Eye,
    });
  }

  // Functions (sorted alphabetically, optionally hiding table-backing ones)
  const tableNames = hideTableBackingFunctions ? new Set(schema.tables.map((t) => t.name)) : null;
  const filteredFunctions = schema.functions.filter((f) => !tableNames || !tableNames.has(f.name));
  const sortedFunctions = [...filteredFunctions].sort((a, b) => a.name.localeCompare(b.name));
  for (const func of sortedFunctions) {
    children.push({
      id: `${schemaId}::f:${func.name}`,
      name: func.name,
      icon: FunctionSquare,
      selectedIcon: FunctionSquare,
    });
  }

  return {
    id: schemaId,
    name: schema.info.name,
    icon: Folder,
    className: isDefault ? "text-primary font-semibold" : undefined,
    openIcon: FolderOpen,
    selectedIcon: Folder,
    children,
  };
}

/** Filter tree nodes by search query. Returns a new tree with only matching nodes. */
export function filterTree(nodes: TreeDataItem[], query: string): TreeDataItem[] {
  if (!query) return nodes;
  const lower = query.toLowerCase();
  return nodes
    .map((node) => filterNode(node, lower))
    .filter((n): n is TreeDataItem => n !== null);
}

function filterNode(node: TreeDataItem, query: string): TreeDataItem | null {
  // If this node matches, include it with all children
  if (node.name.toLowerCase().includes(query)) return node;

  // If children match, include this node with filtered children
  if (node.children) {
    const filtered = node.children
      .map((child) => filterNode(child, query))
      .filter((c): c is TreeDataItem => c !== null);
    if (filtered.length > 0) {
      return { ...node, children: filtered };
    }
  }

  return null;
}
