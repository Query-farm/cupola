import { Database, Folder, ChevronRight } from "lucide-react";
import { ConnectBox } from "@/components/ConnectBox";
import { Badge } from "@/components/ui/badge";
import { useSettings } from "@/lib/settings";
import type { CatalogData } from "@/lib/service";
import type { Selection } from "@/lib/tree";

interface Props {
  catalog: CatalogData;
  serviceUrl: string;
  onNavigate: (selection: Selection) => void;
}

export function CatalogOverview({ catalog, serviceUrl, onNavigate }: Props) {
  const { settings } = useSettings();
  const totalTables = catalog.schemas.reduce((sum, s) => sum + s.tables.length, 0);
  const totalViews = catalog.schemas.reduce((sum, s) => sum + s.views.length, 0);
  const totalFunctions = catalog.schemas.reduce((sum, s) => {
    if (settings.hideTableBackingFunctions) {
      const tableNames = new Set(s.tables.map((t) => t.name));
      return sum + s.functions.filter((f) => !tableNames.has(f.name)).length;
    }
    return sum + s.functions.length;
  }, 0);

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <Database className="h-8 w-8 text-primary" />
        <div>
          <h1 className="text-2xl font-bold text-primary">{catalog.catalogName}</h1>
          <p className="text-sm text-muted-foreground">
            {catalog.schemas.length} schemas, {totalTables} tables
            {totalViews > 0 && `, ${totalViews} views`}
            {totalFunctions > 0 && `, ${totalFunctions} functions`}
          </p>
        </div>
      </div>

      <ConnectBox catalogName={catalog.catalogName} serviceUrl={serviceUrl} />

      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3 mt-8">
        Schemas
      </h2>
      <div className="grid gap-2">
        {catalog.schemas.map((s) => (
          <button
            key={s.info.name}
            onClick={() => onNavigate({ type: "schema", name: s.info.name, schema: s.info.name })}
            className="flex items-center justify-between px-4 py-3 rounded-lg border border-border bg-card hover:border-primary/30 hover:bg-accent/5 transition-colors text-left group cursor-pointer"
          >
            <div className="flex items-center gap-3">
              <Folder className="h-5 w-5 text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-medium group-hover:text-primary transition-colors">{s.info.name}</span>
                  {s.info.name === catalog.defaultSchema && (
                    <Badge variant="secondary" className="text-xs">default</Badge>
                  )}
                </div>
                {s.info.comment && (
                  <p className="text-sm text-muted-foreground mt-0.5">{s.info.comment}</p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground">
                {s.tables.length} tables
                {s.views.length > 0 && `, ${s.views.length} views`}
              </span>
              <ChevronRight className="h-4 w-4 text-muted-foreground/50 group-hover:text-primary transition-colors" />
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
