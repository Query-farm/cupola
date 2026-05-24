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
      <div className="flex items-center gap-2 min-w-0">
        <a
          href="https://query.farm"
          className="font-heading font-bold text-base text-foreground hover:text-earth-700 transition-colors whitespace-nowrap"
          target="_blank"
          rel="noopener noreferrer"
        >
          🚜 Query.Farm
        </a>
        <span className="text-soil-400 text-lg font-light select-none" aria-hidden="true">⌁</span>
        <img
          src={logoUrl || `${import.meta.env.BASE_URL}logo-hero.png`}
          alt="VGI"
          className="w-7 h-7 rounded-full ring-1 ring-soil-200 shrink-0"
        />
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="font-heading font-semibold text-earth-700 truncate">{catalogName}</span>
          {catalogComment && (
            <span className="text-xs text-muted-foreground hidden sm:inline truncate">{catalogComment}</span>
          )}
        </div>
      </div>

      <ServiceSwitcher currentUrl={serviceUrl} currentCatalogName={catalogName} />
    </header>
  );
}
