import { useMemo } from "react";
import { Folder, Table2, Eye, FunctionSquare, ChevronRight } from "lucide-react";
import type { ResolvedSchema } from "@/lib/service";
import type { Selection } from "@/lib/tree";
import { useSettings } from "@/lib/settings";

interface Props {
  schema: ResolvedSchema;
  onNavigate: (selection: Selection) => void;
}

export function SchemaDetail({ schema, onNavigate }: Props) {
  const schemaName = schema.info.name;
  const { settings } = useSettings();
  const visibleFunctions = useMemo(() => {
    if (!settings.hideTableBackingFunctions) return schema.functions;
    const tableNames = new Set(schema.tables.map((t) => t.name));
    return schema.functions.filter((f) => !tableNames.has(f.name));
  }, [schema, settings.hideTableBackingFunctions]);

  return (
    <div>
      <div className="flex items-center gap-3 mb-2">
        <Folder className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold text-primary">{schemaName}</h1>
      </div>
      {schema.info.comment && (
        <p className="text-muted-foreground mb-6">{schema.info.comment}</p>
      )}

      <div className="flex gap-6 text-sm text-muted-foreground mb-6">
        <span className="flex items-center gap-1.5">
          <Table2 className="h-4 w-4" /> {schema.tables.length} tables
        </span>
        {schema.views.length > 0 && (
          <span className="flex items-center gap-1.5">
            <Eye className="h-4 w-4" /> {schema.views.length} views
          </span>
        )}
        {visibleFunctions.length > 0 && (
          <span className="flex items-center gap-1.5">
            <FunctionSquare className="h-4 w-4" /> {visibleFunctions.length} functions
          </span>
        )}
      </div>

      {schema.tables.length > 0 && (
        <div className="mb-6">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Tables</h2>
          <div className="grid gap-1">
            {schema.tables.map((t) => (
              <button
                key={t.name}
                onClick={() => onNavigate({ type: "table", name: t.name, schema: schemaName })}
                className="flex items-start gap-3 px-4 py-2.5 rounded-md text-sm text-left hover:bg-accent/5 hover:border-primary/20 border border-transparent transition-colors group cursor-pointer"
              >
                <Table2 className="h-4 w-4 text-muted-foreground group-hover:text-primary shrink-0 mt-0.5 transition-colors" />
                <div className="flex-1 min-w-0">
                  <div className="font-mono font-medium group-hover:text-primary transition-colors">{t.name}</div>
                  {t.comment && (
                    <div className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{t.comment}</div>
                  )}
                </div>
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/30 group-hover:text-primary shrink-0 mt-1 transition-colors" />
              </button>
            ))}
          </div>
        </div>
      )}

      {schema.views.length > 0 && (
        <div className="mb-6">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Views</h2>
          <div className="grid gap-1">
            {schema.views.map((v) => (
              <button
                key={v.name}
                onClick={() => onNavigate({ type: "view", name: v.name, schema: schemaName })}
                className="flex items-start gap-3 px-4 py-2.5 rounded-md text-sm text-left hover:bg-accent/5 hover:border-primary/20 border border-transparent transition-colors group cursor-pointer"
              >
                <Eye className="h-4 w-4 text-muted-foreground group-hover:text-primary shrink-0 mt-0.5 transition-colors" />
                <div className="flex-1 min-w-0">
                  <div className="font-mono font-medium group-hover:text-primary transition-colors">{v.name}</div>
                  {v.comment && (
                    <div className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{v.comment}</div>
                  )}
                </div>
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/30 group-hover:text-primary shrink-0 mt-1 transition-colors" />
              </button>
            ))}
          </div>
        </div>
      )}

      {visibleFunctions.length > 0 && (
        <div className="mb-6">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Functions</h2>
          <div className="grid gap-1">
            {visibleFunctions.map((f) => (
              <button
                key={f.name}
                onClick={() => onNavigate({ type: "function", name: f.name, schema: schemaName })}
                className="flex items-start gap-3 px-4 py-2.5 rounded-md text-sm text-left hover:bg-accent/5 hover:border-primary/20 border border-transparent transition-colors group cursor-pointer"
              >
                <FunctionSquare className="h-4 w-4 text-muted-foreground group-hover:text-primary shrink-0 mt-0.5 transition-colors" />
                <div className="flex-1 min-w-0">
                  <div className="font-mono font-medium group-hover:text-primary transition-colors">{f.name}</div>
                  {f.description && (
                    <div className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{f.description}</div>
                  )}
                </div>
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/30 group-hover:text-primary shrink-0 mt-1 transition-colors" />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
