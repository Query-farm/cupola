import { ServiceSwitcher } from "./ServiceSwitcher";
import { BrandMark } from "./BrandMark";

interface Props {
  catalogName: string;
  catalogComment?: string | null;
  serviceUrl: string;
}

/**
 * Top bar. Layout: [🚜 Query.Farm] ⌁ [catalog name · comment]   [switcher]
 */
export function Header({ catalogName, catalogComment, serviceUrl }: Props) {
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

      <ServiceSwitcher currentUrl={serviceUrl} currentCatalogName={catalogName} />
    </header>
  );
}
