import { useMemo } from "react";
import { Folder } from "lucide-react";
import { CatalogIcon, getIconForType, getColorForType } from "./CatalogIcons";
import { CatalogListItem } from "./CatalogListItem";
import type { ResolvedSchema } from "@/lib/service";
import type { Selection } from "@/lib/tree";
import { useSettings } from "@/lib/settings";
import { Breadcrumb } from "./Breadcrumb";
import { TagsTable } from "./TagsTable";
import { ExampleQueries } from "./ExampleQueries";
import { filterDisplayTags } from "@/lib/tags";
import { DescriptionSection } from "./DescriptionSection";

interface Props {
  schema: ResolvedSchema;
  onNavigate: (selection: Selection) => void;
  /** Catalog name to include in navigation selections. */
  catalogName?: string;
  onOpenShell?: () => void;
}

export function SchemaDetail({ schema, onNavigate, catalogName, onOpenShell }: Props) {
  const schemaName = schema.info.name;
  const { settings } = useSettings();
  const visibleFunctions = useMemo(() => {
    if (!settings.hideTableBackingFunctions) return schema.functions;
    const tableNames = new Set(schema.tables.map((t) => t.name));
    return schema.functions.filter((f) => !tableNames.has(f.name));
  }, [schema, settings.hideTableBackingFunctions]);

  return (
    <div>
      <div className="flex items-center gap-3 mb-1">
        <Folder className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold text-primary">{schemaName}</h1>
      </div>

      <Breadcrumb catalogName={catalogName ?? ""} schemaName={schemaName} onNavigate={onNavigate} />

      {schema.info.comment && (
        <p className="text-muted-foreground mb-6">{schema.info.comment}</p>
      )}

      {schema.info.tags?.description_md && (
        <DescriptionSection markdown={schema.info.tags.description_md} />
      )}

      <div className="flex gap-6 text-sm text-muted-foreground mb-6">
        <span className="flex items-center gap-1.5">
          <CatalogIcon type="table" className="h-4 w-4" /> {schema.tables.length} tables
        </span>
        {schema.views.length > 0 && (
          <span className="flex items-center gap-1.5">
            <CatalogIcon type="view" className="h-4 w-4" /> {schema.views.length} views
          </span>
        )}
        {visibleFunctions.length > 0 && (
          <span className="flex items-center gap-1.5">
            <CatalogIcon type="function" className="h-4 w-4" /> {visibleFunctions.length} functions
          </span>
        )}
      </div>

      {schema.tables.length > 0 && (
        <div className="mb-6">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Tables</h2>
          <div className="grid gap-2">
            {schema.tables.map((t) => (
              <CatalogListItem
                key={t.name}
                icon={getIconForType("table")}
                iconClassName={getColorForType("table")}
                title={t.name}
                description={t.comment || undefined}
                onClick={() => onNavigate({ type: "table", name: t.name, schema: schemaName, catalog: catalogName })}
              />
            ))}
          </div>
        </div>
      )}

      {schema.views.length > 0 && (
        <div className="mb-6">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Views</h2>
          <div className="grid gap-2">
            {schema.views.map((v) => (
              <CatalogListItem
                key={v.name}
                icon={getIconForType("view")}
                iconClassName={getColorForType("view")}
                title={v.name}
                description={v.comment || undefined}
                onClick={() => onNavigate({ type: "view", name: v.name, schema: schemaName, catalog: catalogName })}
              />
            ))}
          </div>
        </div>
      )}

      {visibleFunctions.length > 0 && (
        <div className="mb-6">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Functions</h2>
          <div className="grid gap-2">
            {visibleFunctions.map((f) => (
              <CatalogListItem
                key={f.name}
                icon={getIconForType("function")}
                iconClassName={getColorForType("function")}
                title={f.name}
                description={f.description || undefined}
                onClick={() => onNavigate({ type: "function", name: f.name, schema: schemaName, catalog: catalogName })}
              />
            ))}
          </div>
        </div>
      )}

      {schema.macros?.length > 0 && (
        <div className="mb-6">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Macros</h2>
          <div className="grid gap-2">
            {schema.macros.map((m) => (
              <CatalogListItem
                key={m.name}
                icon={getIconForType("macro")}
                title={m.name}
                description={m.comment || undefined}
                badge={m.macroType === "table" ? "table" : "scalar"}
                onClick={() => onNavigate({ type: "macro", name: m.name, schema: schemaName, catalog: catalogName })}
              />
            ))}
          </div>
        </div>
      )}

      {(() => {
        const filtered = filterDisplayTags(schema.info.tags);
        return filtered ? <div className="mt-8"><TagsTable tags={filtered} /></div> : null;
      })()}

      <ExampleQueries exampleQueriesJson={schema.info.tags?.example_queries} onOpenShell={onOpenShell} />
    </div>
  );
}
