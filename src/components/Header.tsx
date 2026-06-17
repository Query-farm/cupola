import { Database, FileCode2 } from "lucide-react";
import { ServiceSwitcher } from "./ServiceSwitcher";
import { BrandMark } from "./BrandMark";
import { cn } from "@/lib/utils";

interface Props {
  catalogName: string;
  catalogComment?: string | null;
  serviceUrl: string;
  /** Active surface: catalog browser or SQL editor. */
  appView?: "catalog" | "editor";
  onToggleView?: (view: "catalog" | "editor") => void;
}

/**
 * Top bar. Layout: [🚜 Query.Farm] ⌁ [catalog name · comment]   [view toggle] [switcher]
 */
export function Header({ catalogName, catalogComment, serviceUrl, appView = "catalog", onToggleView }: Props) {
  return (
    <header className="sticky top-0 z-40 flex items-center justify-between gap-4 px-4 h-14 border-b border-border bg-card/95 backdrop-blur-sm shadow-sm">
      <div className="flex items-center gap-3 min-w-0">
        <BrandMark />
        <span className="h-5 w-px bg-border select-none" aria-hidden="true" />
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="font-heading font-semibold text-foreground truncate">{catalogName}</span>
          {catalogComment && (
            <span className="text-xs text-muted-foreground hidden sm:inline truncate">{catalogComment}</span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        {onToggleView && (
          <div className="flex items-center rounded-md border border-border p-0.5 text-xs" role="tablist" aria-label="View">
            <button
              role="tab"
              aria-selected={appView === "catalog"}
              onClick={() => onToggleView("catalog")}
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1 rounded transition-colors",
                appView === "catalog" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
              data-testid="view-toggle-catalog"
            >
              <Database className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Catalog</span>
            </button>
            <button
              role="tab"
              aria-selected={appView === "editor"}
              onClick={() => onToggleView("editor")}
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1 rounded transition-colors",
                appView === "editor" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
              data-testid="view-toggle-editor"
            >
              <FileCode2 className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">SQL Editor</span>
            </button>
          </div>
        )}
        <ServiceSwitcher currentUrl={serviceUrl} currentCatalogName={catalogName} />
      </div>
    </header>
  );
}
