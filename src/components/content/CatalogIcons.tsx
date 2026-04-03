import { Table2, Eye, FunctionSquare, Database, Folder, Columns3, Key, Braces } from "lucide-react";
import type { ComponentType } from "react";

export type CatalogObjectType = "catalog" | "schema" | "table" | "view" | "function" | "macro" | "column" | "primaryKey";

const iconMap: Record<CatalogObjectType, ComponentType<{ className?: string }>> = {
  catalog: Database,
  schema: Folder,
  table: Table2,
  view: Eye,
  function: FunctionSquare,
  macro: Braces,
  column: Columns3,
  primaryKey: Key,
};

const colorMap: Record<CatalogObjectType, string> = {
  catalog: "text-primary",
  schema: "text-primary",
  table: "text-blue-600",
  view: "text-violet-500",
  function: "text-amber-600",
  macro: "text-teal-600",
  column: "text-muted-foreground",
  primaryKey: "text-amber-500",
};

const badgeColorMap: Record<string, string> = {
  table: "bg-blue-50 text-blue-700",
  view: "bg-violet-50 text-violet-700",
  function: "bg-amber-50 text-amber-700",
  macro: "bg-teal-50 text-teal-700",
};

interface Props {
  type: CatalogObjectType;
  className?: string;
}

export function CatalogIcon({ type, className = "h-4 w-4" }: Props) {
  const Icon = iconMap[type];
  const color = colorMap[type];
  return <Icon className={`${className} ${color}`} />;
}

/** Get the icon component for a catalog object type. */
export function getIconForType(type: CatalogObjectType): ComponentType<{ className?: string }> {
  return iconMap[type];
}

/** Get the color class for a catalog object type. */
export function getColorForType(type: CatalogObjectType): string {
  return colorMap[type];
}

/** Get the badge background + text color classes for a catalog object type. */
export function getBadgeColorForType(type: string): string {
  return badgeColorMap[type] ?? "bg-gray-50 text-gray-700";
}
