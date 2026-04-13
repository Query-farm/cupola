import { ServiceSwitcher } from "./ServiceSwitcher";

interface Props {
  catalogName: string;
  catalogComment?: string | null;
  serviceUrl: string;
  logoUrl?: string;
}

export function Header({ catalogName, catalogComment, serviceUrl, logoUrl }: Props) {
  return (
    <header className="flex items-center justify-between px-4 py-2 border-b border-border bg-card">
      <div className="flex items-center gap-3">
        <img
          src={logoUrl || `${import.meta.env.BASE_URL}logo-hero.png`}
          alt="VGI"
          className="w-7 h-7 rounded-full"
        />
        <div className="flex items-baseline gap-2">
          <span className="font-semibold text-primary">{catalogName}</span>
          {catalogComment && (
            <span className="text-xs text-muted-foreground hidden sm:inline">{catalogComment}</span>
          )}
        </div>
      </div>

      <ServiceSwitcher currentUrl={serviceUrl} currentCatalogName={catalogName} />
    </header>
  );
}
