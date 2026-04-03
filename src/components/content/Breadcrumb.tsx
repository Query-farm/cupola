import { ChevronRight } from "lucide-react";
import type { Selection } from "@/lib/tree";
import { CatalogIcon, type CatalogObjectType } from "./CatalogIcons";

interface Crumb {
  type: Selection["type"];
  label: string;
  selection?: Selection;
}

interface Props {
  catalogName: string;
  schemaName?: string;
  itemName?: string;
  itemType?: "table" | "view" | "function" | "macro";
  onNavigate?: (selection: Selection) => void;
}

export function Breadcrumb({ catalogName, schemaName, itemName, itemType, onNavigate }: Props) {
  const crumbs: Crumb[] = [
    { type: "catalog", label: catalogName, selection: { type: "catalog", name: catalogName } },
  ];

  if (schemaName) {
    crumbs.push({
      type: "schema",
      label: schemaName,
      selection: itemName ? { type: "schema", name: schemaName, schema: schemaName, catalog: catalogName } : undefined,
    });
  }

  if (itemName && itemType) {
    crumbs.push({ type: itemType, label: itemName });
  }

  return (
    <nav className="flex items-center gap-1.5 text-xs text-muted-foreground mb-4 px-3 py-1.5 bg-muted/40 rounded-md border border-border/50">
      {crumbs.map((crumb, i) => {
        const isLast = i === crumbs.length - 1;
        return (
          <span key={i} className="inline-flex items-center gap-1.5">
            {i > 0 && <ChevronRight className="h-3 w-3 text-muted-foreground/50" />}
            {crumb.selection && !isLast ? (
              <a
                href="#"
                className="inline-flex items-center gap-1 hover:text-primary hover:underline transition-colors"
                onClick={(e) => { e.preventDefault(); onNavigate?.(crumb.selection!); }}
              >
                <CatalogIcon type={crumb.type as CatalogObjectType} className="h-3 w-3" />
                {crumb.label}
              </a>
            ) : (
              <span className="inline-flex items-center gap-1 text-foreground font-medium">
                <CatalogIcon type={crumb.type as CatalogObjectType} className="h-3 w-3" />
                {crumb.label}
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );
}
