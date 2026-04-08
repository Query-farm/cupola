import { ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { Selection } from "@/lib/tree";
import { CatalogIcon, getBadgeColorForType, type CatalogObjectType } from "./CatalogIcons";

interface Crumb {
  type: Selection["type"];
  label: string;
  selection?: Selection;
}

interface Props {
  catalogName: string;
  schemaName?: string;
  itemName?: string;
  itemType?: "schema" | "table" | "view" | "function" | "macro";
  onNavigate?: (selection: Selection) => void;
  /** Extra content rendered after the last breadcrumb item (e.g. buttons). */
  trailing?: React.ReactNode;
}

export function Breadcrumb({ catalogName, schemaName, itemName, itemType, onNavigate, trailing }: Props) {
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
    <nav className="flex items-center gap-1.5 text-sm text-muted-foreground mb-4">
      {crumbs.map((crumb, i) => {
        const isLast = i === crumbs.length - 1;
        return (
          <span key={i} className="inline-flex items-center gap-1.5">
            {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50" />}
            {crumb.selection && !isLast ? (
              <a
                href="#"
                className="inline-flex items-center gap-1.5 hover:text-primary hover:underline transition-colors"
                onClick={(e) => { e.preventDefault(); onNavigate?.(crumb.selection!); }}
              >
                <CatalogIcon type={crumb.type as CatalogObjectType} className="h-3.5 w-3.5" />
                {crumb.label}
              </a>
            ) : (
              <span className={`inline-flex items-center gap-1.5 ${isLast && itemType ? "text-xl font-bold font-mono text-primary" : "text-foreground font-medium"}`}>
                <CatalogIcon type={crumb.type as CatalogObjectType} className={isLast && itemType ? "h-5 w-5" : "h-3.5 w-3.5"} />
                {crumb.label}
                {isLast && itemType && (
                  <Badge variant="secondary" className={`text-xs ml-1 ${getBadgeColorForType(itemType)}`}>{itemType}</Badge>
                )}
              </span>
            )}
          </span>
        );
      })}
      {trailing && <span className="ml-auto">{trailing}</span>}
    </nav>
  );
}
