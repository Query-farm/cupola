/**
 * Builds TreeDataItem[] from CatalogData for the sidebar tree view.
 * Structure: catalog → schemas → tables (with column children), views, functions
 */

import React from "react";
import { Database, Folder, FolderOpen, Table2, Eye, FunctionSquare, Braces, Columns3, Key, TerminalSquare, RefreshCw, Loader2 } from "lucide-react";
import { getColorForType } from "@/components/content/CatalogIcons";
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
  type: "catalog" | "schema" | "table" | "view" | "function" | "macro";
  name: string;
  schema?: string;
  /** Catalog name this selection belongs to (e.g. "memory" for in-memory tables). */
  catalog?: string;
}

/** Convert a Selection back to a tree item ID. */
export function selectionToTreeId(selection: Selection, catalogName: string): string {
  const cat = selection.catalog ?? catalogName;
  if (selection.type === "catalog") return cat;
  const schema = selection.schema ?? selection.name;
  if (selection.type === "schema") return `${cat}::${schema}`;
  const prefix = selection.type === "table" ? "t" : selection.type === "view" ? "v" : selection.type === "macro" ? "m" : "f";
  return `${cat}::${schema}::${prefix}:${selection.name}`;
}

/** Parse a tree item ID back into a Selection. */
export function parseSelection(id: string): Selection | null {
  const parts = id.split("::");
  if (parts.length === 1) return { type: "catalog", name: parts[0], catalog: parts[0] };
  if (parts.length === 2) return { type: "schema", name: parts[1], schema: parts[1], catalog: parts[0] };
  if (parts.length === 3) {
    const catalog = parts[0];
    const schema = parts[1];
    const rest = parts[2];
    if (rest.startsWith("t:")) return { type: "table", name: rest.slice(2), schema, catalog };
    if (rest.startsWith("v:")) return { type: "view", name: rest.slice(2), schema, catalog };
    if (rest.startsWith("f:")) return { type: "function", name: rest.slice(2), schema, catalog };
    if (rest.startsWith("m:")) return { type: "macro", name: rest.slice(2), schema, catalog };
    // Column — select the parent table
    if (rest.startsWith("c:")) {
      const colParts = rest.slice(2).split("/");
      return { type: "table", name: colParts[0], schema, catalog };
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
  /** Override the root node icon (default: Database). */
  rootIcon?: React.ComponentType<{ className?: string }>;
}

/** Build the full tree from catalog data. Root node is the catalog. */
export function buildTreeData(catalog: CatalogData, options: BuildTreeOptions = {}): TreeDataItem[] {
  const { showDuckDBTypes = true, hideTableBackingFunctions = true, onTableAction, onRefresh, refreshing, rootIcon } = options;
  const sortedSchemas = [...catalog.schemas].sort((a, b) =>
    a.info.name.localeCompare(b.info.name)
  );
  const root: TreeDataItem = {
    id: catalog.catalogName,
    name: catalog.catalogName,
    icon: rootIcon || Database,
    selectedIcon: rootIcon || Database,
    openIcon: rootIcon || Database,
    className: "text-primary font-bold",
    children: sortedSchemas.map((s) =>
      buildSchemaNode(catalog.catalogName, s, showDuckDBTypes, hideTableBackingFunctions, s.info.name === catalog.defaultSchema, onTableAction)
    ),
    actions: onRefresh
      ? React.createElement("div", {
          role: "button",
          tabIndex: 0,
          className: "p-0.5 text-muted-foreground hover:text-primary transition-colors cursor-pointer",
          title: "Refresh catalog",
          "aria-disabled": refreshing || undefined,
          onClick: (e: React.MouseEvent) => { e.stopPropagation(); if (!refreshing) onRefresh(); },
          onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); e.preventDefault(); if (!refreshing) onRefresh(); } },
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
    const pkColumns = new Set(
      table.primaryKeyConstraints?.flatMap((pk: number[]) =>
        pk.map((idx: number) => columns[idx]?.name).filter(Boolean)
      ) ?? []
    );
    const columnChildren: TreeDataItem[] = columns.map((col) => {
      const typeLabel = showDuckDBTypes ? col.duckdbType : col.arrowType;
      const isPK = pkColumns.has(col.name);
      return {
        id: `${schemaId}::c:${table.name}/${col.name}`,
        name: col.name,
        icon: isPK ? Key : Columns3,
        className: "text-muted-foreground text-xs",
        draggable: !!onTableAction,
        actions: React.createElement("span", {
          className: `tree-col-type text-[10px] font-mono ml-1 truncate px-1 py-0.5 rounded ${typeColorClass(typeLabel)}`,
        }, typeLabel),
      };
    });

    children.push({
      id: tableId,
      name: table.name,
      icon: Table2,
      selectedIcon: Table2,
      className: "font-medium",
      draggable: !!onTableAction,
      children: columnChildren.length > 0 ? columnChildren : undefined,
      actions: onTableAction
        ? React.createElement("div", {
            role: "button",
            tabIndex: 0,
            className: "opacity-0 group-hover:opacity-100 p-0.5 text-muted-foreground hover:text-primary transition-all cursor-pointer",
            title: `Paste ${schema.info.name}.${table.name} into shell`,
            onClick: (e: React.MouseEvent) => { e.stopPropagation(); onTableAction(schema.info.name, table.name); },
            onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); e.preventDefault(); onTableAction(schema.info.name, table.name); } },
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
      className: "text-accent/80",
      draggable: !!onTableAction,
      actions: onTableAction
        ? React.createElement("div", {
            role: "button",
            tabIndex: 0,
            className: "opacity-0 group-hover:opacity-100 p-0.5 text-muted-foreground hover:text-primary transition-all cursor-pointer",
            title: `Paste ${schema.info.name}.${view.name} into shell`,
            onClick: (e: React.MouseEvent) => { e.stopPropagation(); onTableAction(schema.info.name, view.name); },
            onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); e.preventDefault(); onTableAction(schema.info.name, view.name); } },
          }, React.createElement(TerminalSquare, { className: "h-3 w-3" }))
        : undefined,
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
      className: "text-muted-foreground",
    });
  }

  // Macros (sorted alphabetically)
  if (schema.macros?.length > 0) {
    const sortedMacros = [...schema.macros].sort((a, b) => a.name.localeCompare(b.name));
    for (const macro of sortedMacros) {
      children.push({
        id: `${schemaId}::m:${macro.name}`,
        name: macro.name,
        icon: Braces,
        selectedIcon: Braces,
        className: "text-muted-foreground",
      });
    }
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

/** Map a DuckDB/Arrow type name to a background + text color class for type badges. */
export function typeColorClass(type: string): string {
  const t = type.toUpperCase();
  // Integer types
  if (t === "INTEGER" || t === "INT" || t === "BIGINT" || t === "SMALLINT" || t === "TINYINT" ||
      t === "HUGEINT" || t === "UHUGEINT" || t === "UBIGINT" || t === "UINTEGER" || t === "USMALLINT" || t === "UTINYINT" ||
      t === "INT8" || t === "INT16" || t === "INT32" || t === "INT64" || t === "UINT8" || t === "UINT16" || t === "UINT32" || t === "UINT64" ||
      t === "BIGNUM" || t === "VARINT")
    return "bg-blue-100 text-blue-700";
  // Float / decimal types
  if (t === "FLOAT" || t === "DOUBLE" || t === "REAL" || t === "DECIMAL" || t.startsWith("DECIMAL("))
    return "bg-sky-100 text-sky-700";
  // String types
  if (t === "VARCHAR" || t === "TEXT" || t === "STRING" || t === "UTF8" || t === "CHAR" || t.startsWith("VARCHAR(") || t === "JSON")
    return "bg-green-100 text-green-700";
  // Boolean
  if (t === "BOOLEAN" || t === "BOOL")
    return "bg-amber-100 text-amber-700";
  // Date
  if (t === "DATE" || t === "DATE32" || t === "DATE64")
    return "bg-purple-100 text-purple-700";
  // Timestamp (TIMESTAMP, TIMESTAMP_S/MS/NS, TIMESTAMP WITH TIME ZONE, TIMESTAMPTZ, DATETIME)
  if (t === "DATETIME" || t.startsWith("TIMESTAMP"))
    return "bg-violet-100 text-violet-700";
  // Time (TIME, TIME_NS, TIME WITH TIME ZONE, TIMETZ, INTERVAL)
  if (t === "INTERVAL" || t.startsWith("TIME"))
    return "bg-fuchsia-100 text-fuchsia-700";
  // UUID
  if (t === "UUID")
    return "bg-teal-100 text-teal-700";
  // Enum
  if (t.startsWith("ENUM"))
    return "bg-amber-100 text-amber-700";
  // Bit
  if (t === "BIT")
    return "bg-gray-200 text-gray-700";
  // Geometry / spatial / blob
  if (t === "GEOMETRY" || t === "WKB" || t === "BLOB" || t.startsWith("GEOARROW"))
    return "bg-orange-100 text-orange-700";
  // Struct / list / map / union / array types (includes fixed-size arrays like INTEGER[3])
  if (t.startsWith("STRUCT") || t.startsWith("LIST") || t.startsWith("MAP") || t.startsWith("UNION") || t.includes("["))
    return "bg-rose-100 text-rose-700";
  // Default
  return "bg-gray-100 text-gray-600";
}
