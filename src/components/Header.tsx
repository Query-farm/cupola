import { ServiceSwitcher } from "./ServiceSwitcher";

interface Props {
  catalogName: string;
  catalogComment?: string | null;
  serviceUrl: string;
  logoUrl?: string;
}

/**
 * Top bar. Layout: [🚜 Query.Farm] ⌁ [VGI logo · catalog name · comment]   [switcher]
 *
 * Sticky + frosted to match the marketing site rhythm. The Query.Farm
 * wordmark anchors the family relationship without overriding the
 * per-deployment VGI logo (which a theme can still customize via `logoUrl`).
 */
export function Header({ catalogName, catalogComment, serviceUrl, logoUrl }: Props) {
  return (
    <header className="sticky top-0 z-40 flex items-center justify-between gap-4 px-4 h-14 border-b border-border bg-card/95 backdrop-blur-sm shadow-sm">
      <div className="flex items-center gap-3 min-w-0">
        <a
          href="https://query.farm"
          className="flex items-baseline gap-2 whitespace-nowrap group/brand"
          target="_blank"
          rel="noopener noreferrer"
          title="Cupola — a Query.Farm tool"
        >
          <img
            src={`${import.meta.env.BASE_URL}cupola-icon.png`}
            alt=""
            aria-hidden="true"
            className="w-5 h-5 self-center text-foreground group-hover/brand:text-earth-700 transition-colors"
          />
          <span className="font-heading font-bold text-base leading-none text-foreground group-hover/brand:text-earth-700 transition-colors">
            Cupola
          </span>
          <span className="hidden md:inline font-heading text-sm leading-none text-muted-foreground group-hover/brand:text-foreground transition-colors">
            by <span aria-hidden="true">🚜&nbsp;</span>Query.Farm
          </span>
        </a>
        <span className="h-5 w-px bg-border select-none" aria-hidden="true" />
        <img
          src={logoUrl || `${import.meta.env.BASE_URL}logo-hero.png`}
          alt="VGI"
          className="w-7 h-7 rounded-full ring-1 ring-soil-200 shrink-0"
        />
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
