import { useMemo } from "react";
import { CatalogIcon, getIconForType, getColorForType } from "./CatalogIcons";
import { CatalogListItem } from "./CatalogListItem";
import type { ResolvedSchema } from "@/lib/service";
import type { Selection } from "@/lib/tree";
import { useSettings } from "@/lib/settings";
import { Breadcrumb } from "./Breadcrumb";
import { TagsTable } from "./TagsTable";
import { ExampleQueries } from "./ExampleQueries";
import {
  filterDisplayTags,
  getTag,
  parseCategories,
  parseExecutableExamples,
  groupByCategory,
  categoryTitle,
  TAG_DOC_MD,
  TAG_EXAMPLE_QUERIES,
  TAG_TITLE,
  TAG_CATEGORY,
  type CategoryDef,
} from "@/lib/tags";
import { DescriptionSection } from "./DescriptionSection";
import { ChatMarkdown } from "@/components/chat/ChatMarkdown";
import { ObjectMeta } from "./ObjectMeta";

interface Props {
  schema: ResolvedSchema;
  onNavigate: (selection: Selection) => void;
  /** Catalog name to include in navigation selections. */
  catalogName?: string;
  onOpenShell?: () => void;
}

type ObjKind = "table" | "view" | "function" | "macro";

/** A schema object flattened to a uniform shape for category grouping / listing. */
interface ObjItem {
  kind: ObjKind;
  name: string;
  description?: string;
  tags: Record<string, string>;
  badge?: string;
}

export function SchemaDetail({ schema, onNavigate, catalogName, onOpenShell }: Props) {
  const schemaName = schema.info.name;
  const { settings } = useSettings();
  const visibleTables = useMemo(
    () => settings.hideDollarTables ? schema.tables.filter((t) => !t.name.includes("$")) : schema.tables,
    [schema, settings.hideDollarTables]
  );
  const visibleFunctions = useMemo(() => {
    if (!settings.hideTableBackingFunctions) return schema.functions;
    const tableNames = new Set(schema.tables.map((t) => t.name));
    return schema.functions.filter((f) => !tableNames.has(f.name));
  }, [schema, settings.hideTableBackingFunctions]);

  const title = getTag(schema.info.tags, TAG_TITLE);
  const docMd = getTag(schema.info.tags, TAG_DOC_MD);
  const executableExamples = useMemo(() => parseExecutableExamples(schema.info.tags), [schema.info.tags]);

  // Flatten every visible object (in kind order) into a uniform list, then try
  // to group it by the schema's `vgi.categories` registry via each object's
  // `vgi.category`. `groupByCategory` returns null when there's no registry or
  // nothing is categorized — the signal to fall back to the kind-grouped layout.
  const registry: CategoryDef[] = useMemo(() => parseCategories(schema.info.tags), [schema.info.tags]);
  const allItems: ObjItem[] = useMemo(() => [
    ...visibleTables.map((t): ObjItem => ({ kind: "table", name: t.name, description: t.comment || undefined, tags: t.tags })),
    ...schema.views.map((v): ObjItem => ({ kind: "view", name: v.name, description: v.comment || undefined, tags: v.tags })),
    ...visibleFunctions.map((f): ObjItem => ({ kind: "function", name: f.name, description: f.description || undefined, tags: f.tags })),
    ...(schema.macros ?? []).map((m): ObjItem => ({ kind: "macro", name: m.name, description: m.comment || undefined, tags: m.tags, badge: m.macro_type === "TABLE" ? "table" : "scalar" })),
  ], [visibleTables, schema.views, visibleFunctions, schema.macros]);
  const categoryGroups = useMemo(
    () => groupByCategory(allItems, (o) => getTag(o.tags, TAG_CATEGORY), registry),
    [allItems, registry],
  );

  const navFor = (o: ObjItem): Selection => ({ type: o.kind, name: o.name, schema: schemaName, catalog: catalogName });

  const renderItem = (o: ObjItem) => {
    const friendly = getTag(o.tags, TAG_TITLE);
    return (
      <CatalogListItem
        key={`${o.kind}:${o.name}`}
        icon={getIconForType(o.kind)}
        iconClassName={getColorForType(o.kind)}
        title={friendly || o.name}
        description={o.description}
        badge={o.badge}
        rightLabel={friendly && friendly !== o.name ? o.name : undefined}
        onClick={() => onNavigate(navFor(o))}
      />
    );
  };

  return (
    <div>
      <Breadcrumb catalogName={catalogName ?? ""} itemName={schemaName} itemType="schema" onNavigate={onNavigate} />

      {title && <h1 className="text-xl font-semibold mt-1 mb-1">{title}</h1>}

      {schema.info.comment && (
        <p className="text-muted-foreground mb-6">{schema.info.comment}</p>
      )}

      {docMd && <DescriptionSection markdown={docMd} />}

      <ObjectMeta tags={schema.info.tags} />

      <div className="flex gap-6 text-sm text-muted-foreground mb-6">
        <span className="flex items-center gap-1.5">
          <CatalogIcon type="table" className="h-4 w-4" /> {visibleTables.length} tables
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

      {categoryGroups ? (
        // Category-driven layout (schema declares a vgi.categories registry).
        categoryGroups.map((group) => (
          <div className="mb-6" key={group.def ? group.def.name : "__uncategorized"}>
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">
              {group.def ? categoryTitle(group.def) : "Uncategorized"}
            </h2>
            {group.def?.description && (
              <p className="text-sm text-muted-foreground mb-2">{group.def.description}</p>
            )}
            {group.def?.doc_md && (
              <div className="mb-3"><ChatMarkdown content={group.def.doc_md} /></div>
            )}
            <div className="grid gap-2 mt-2">
              {group.items.map(renderItem)}
            </div>
          </div>
        ))
      ) : (
        // Fallback: kind-grouped layout (no registry / nothing categorized).
        <>
          {visibleTables.length > 0 && (
            <div className="mb-6">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Tables</h2>
              <div className="grid gap-2">
                {visibleTables.map((t) => renderItem({ kind: "table", name: t.name, description: t.comment || undefined, tags: t.tags }))}
              </div>
            </div>
          )}

          {schema.views.length > 0 && (
            <div className="mb-6">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Views</h2>
              <div className="grid gap-2">
                {schema.views.map((v) => renderItem({ kind: "view", name: v.name, description: v.comment || undefined, tags: v.tags }))}
              </div>
            </div>
          )}

          {visibleFunctions.length > 0 && (
            <div className="mb-6">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Functions</h2>
              <div className="grid gap-2">
                {visibleFunctions.map((f) => renderItem({ kind: "function", name: f.name, description: f.description || undefined, tags: f.tags }))}
              </div>
            </div>
          )}

          {schema.macros?.length > 0 && (
            <div className="mb-6">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Macros</h2>
              <div className="grid gap-2">
                {schema.macros.map((m) => renderItem({ kind: "macro", name: m.name, description: m.comment || undefined, tags: m.tags, badge: m.macro_type === "TABLE" ? "table" : "scalar" }))}
              </div>
            </div>
          )}
        </>
      )}

      {(() => {
        const filtered = filterDisplayTags(schema.info.tags);
        return filtered ? <div className="mt-8"><TagsTable tags={filtered} /></div> : null;
      })()}

      <ExampleQueries exampleQueriesJson={schema.info.tags?.[TAG_EXAMPLE_QUERIES]} queries={executableExamples} onOpenShell={onOpenShell} />
    </div>
  );
}
