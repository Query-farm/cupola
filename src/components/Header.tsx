import { ServiceSwitcher } from "./ServiceSwitcher";

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
        <a
          href="https://query.farm"
          className="flex items-center gap-2 whitespace-nowrap group/brand"
          target="_blank"
          rel="noopener noreferrer"
          title="Cupola — a Query.Farm tool"
        >
          <img
            src={`${import.meta.env.BASE_URL}cupola-icon.png`}
            alt=""
            aria-hidden="true"
            className="w-8 h-8 text-foreground group-hover/brand:text-earth-700 transition-colors"
          />
          <span className="font-heading font-bold text-base leading-none text-foreground group-hover/brand:text-earth-700 transition-colors">
            Cupola
          </span>
          <span className="hidden md:inline font-heading text-sm leading-none text-muted-foreground group-hover/brand:text-foreground transition-colors">
            by <span aria-hidden="true">🚜&nbsp;</span>Query.Farm
          </span>
        </a>
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
