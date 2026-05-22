import { HardDrive, Folder, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { CatalogData } from "@/lib/service";
import type { Selection } from "@/lib/tree";

interface Props {
  catalog: CatalogData;
  onNavigate: (selection: Selection) => void;
}

export function MemoryCatalogOverview({ catalog, onNavigate }: Props) {
  const totalTables = catalog.schemas.reduce((sum, s) => sum + s.tables.length, 0);

  return (
    <div>
      <div className="flex items-center gap-3 mb-2">
        <HardDrive className="h-8 w-8 text-primary" />
        <div>
          <h1 className="text-2xl font-bold text-primary">In-Memory Database</h1>
          <p className="text-sm text-muted-foreground">
            {catalog.schemas.length} schema{catalog.schemas.length !== 1 ? "s" : ""}, {totalTables} table{totalTables !== 1 ? "s" : ""}
          </p>
        </div>
      </div>

      <p className="text-sm text-muted-foreground mb-6">
        Tables created in the DuckDB shell are stored here. This data lives in browser memory and will be lost when the page is closed.
      </p>

      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
        Schemas
      </h2>
      <div className="grid gap-2">
        {catalog.schemas.map((s) => (
          <button
            key={s.info.name}
            onClick={() => onNavigate({ type: "schema", name: s.info.name, schema: s.info.name, catalog: "memory" })}
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
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground">
                {s.tables.length} table{s.tables.length !== 1 ? "s" : ""}
              </span>
              <ChevronRight className="h-4 w-4 text-muted-foreground/50 group-hover:text-primary transition-colors" />
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
