import { useState } from "react";
import { ChevronLeft, ChevronRight, Ellipsis } from "lucide-react";
import { useMediaQuery } from "@/lib/use-media-query";
import { selectionToHash } from "@/lib/navigation";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import type { Selection } from "@/lib/tree";
import { CatalogIcon, type CatalogObjectType } from "./CatalogIcons";
import { CatalogChip } from "../workspace/CatalogChip";
import { useCatalogColor } from "@/lib/workspace/catalog-colors";

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
  const mobile = useMediaQuery("(max-width: 767px)");
  const [actionsOpen, setActionsOpen] = useState(false);
  // The catalog crumb wears the catalog's chip, as its sidebar root does.
  const color = useCatalogColor(catalogName);
  const icon = (crumb: Crumb, className: string) => crumb.type === "catalog" && color !== undefined
    ? <CatalogChip alias={catalogName} color={color} />
    : <CatalogIcon type={crumb.type as CatalogObjectType} className={className} />;
  const crumbs: Crumb[] = [
    { type: "catalog", label: catalogName, selection: { type: "catalog", name: catalogName, catalog: catalogName } },
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

  if (mobile) {
    const current = crumbs[crumbs.length - 1];
    const parent = crumbs[crumbs.length - 2];
    return <div className="mobile-object-heading">
      <nav aria-label="Breadcrumb" className="mobile-object-path">
        {parent?.selection && <a href={selectionToHash(parent.selection)} aria-label={`Back to ${parent.label}`} title={`Back to ${parent.label}`}
          onClick={event => { if (onNavigate) { event.preventDefault(); onNavigate(parent.selection!); } }}>
          <ChevronLeft size={19} />
        </a>}
        <span aria-current="page" className="mobile-object-name">{icon(current, "size-5 shrink-0")}<span>{current.label}</span></span>
      </nav>
      {trailing && <>
        <button type="button" className="mobile-object-actions-trigger" aria-label={`Actions for ${current.label}`} aria-haspopup="dialog" onClick={() => setActionsOpen(true)}><Ellipsis size={20} /></button>
        <Dialog open={actionsOpen} onOpenChange={setActionsOpen}>
          <DialogContent className="mobile-more-sheet mobile-catalog-actions">
            <DialogHeader><DialogTitle className="break-all">{current.label} actions</DialogTitle></DialogHeader>
            <div className="mobile-catalog-action-list">{trailing}</div>
          </DialogContent>
        </Dialog>
      </>}
    </div>;
  }

  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground mb-4">
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
                {icon(crumb, "h-3.5 w-3.5")}
                {crumb.label}
              </a>
            ) : (
              <span className={`inline-flex items-center gap-1.5 ${isLast && itemType ? "font-heading text-xl font-bold text-foreground" : "text-foreground font-medium"}`}>
                {icon(crumb, isLast && itemType ? "h-5 w-5" : "h-3.5 w-3.5")}
                {crumb.label}
              </span>
            )}
          </span>
        );
      })}
      {trailing && <span className="ml-auto">{trailing}</span>}
    </nav>
  );
}
