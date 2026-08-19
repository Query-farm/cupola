import { ServiceSwitcher } from "./ServiceSwitcher";
import { BrandMark } from "./BrandMark";

interface Props {
  catalogName: string;
  serviceUrl: string;
  showServiceSwitcher?: boolean;
}

/**
 * Top bar. Layout: [🚜 Query.Farm]   [switcher]
 *
 * This bar used to also carry the catalog's name and its comment. Both are
 * gone: the comment is the same string `CatalogOverview` prints under the
 * catalog title (and here it was a one-line truncate in a 56px bar, so this
 * copy was usually the cut-off one), and the name is already the root node of
 * the sidebar tree — which is where it stays legible regardless of who is
 * signed in.
 *
 * `catalogName` is still a prop: `ServiceSwitcher` needs it, both as the
 * avatar's fallback initial and as its trigger label when nobody is
 * authenticated. It just isn't rendered by this component any more.
 */
export function Header({ catalogName, serviceUrl, showServiceSwitcher = true }: Props) {
  return (
    <header className="sticky top-0 z-40 flex items-center justify-between gap-4 px-4 h-14 border-b border-border bg-card/95 backdrop-blur-sm shadow-sm">
      <BrandMark />
      {showServiceSwitcher
        ? <ServiceSwitcher currentUrl={serviceUrl} currentCatalogName={catalogName} />
        : <span className="rounded-full border bg-muted/50 px-3 py-1 text-xs font-medium text-muted-foreground">Local report examples</span>}
    </header>
  );
}
