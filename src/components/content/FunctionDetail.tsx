import { useMemo } from "react";
import type { FunctionInfo } from "vgi/client";
import type { Selection } from "@/lib/tree";
import { Breadcrumb } from "./Breadcrumb";
import { ExampleQueries } from "./ExampleQueries";
import { TagsTable } from "./TagsTable";
import { filterDisplayTags, TAG_EXAMPLE_QUERIES } from "@/lib/tags";

interface Props {
  func: FunctionInfo;
  catalogName?: string;
  schemaName?: string;
  onNavigate?: (selection: Selection) => void;
  onOpenShell?: () => void;
}

export function FunctionDetail({ func, catalogName, schemaName, onNavigate, onOpenShell }: Props) {
  const displayTags = useMemo(() => filterDisplayTags(func.tags), [func.tags]);

  // FunctionInfo has TWO example channels — a structured first-class
  // `examples: CatalogExample[]` (server-defined) and an optional
  // `vgi.example_queries` JSON tag (user-defined). Pass both to
  // ExampleQueries, which merges and de-dupes by SQL.
  const structuredExamples = (func.examples || []).map((e) => ({
    description: e.description || null,
    sql: e.sql,
  }));

  return (
    <div>
      {catalogName && schemaName && (
        <Breadcrumb catalogName={catalogName} schemaName={schemaName} itemName={func.name} itemType="function" onNavigate={onNavigate} />
      )}

      {func.description && (
        <p className="text-muted-foreground mb-6">{func.description}</p>
      )}

      {displayTags && <TagsTable tags={displayTags} />}

      <ExampleQueries
        exampleQueriesJson={func.tags?.[TAG_EXAMPLE_QUERIES]}
        queries={structuredExamples}
        onOpenShell={onOpenShell}
      />
    </div>
  );
}
