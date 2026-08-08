import { useState, useEffect, useMemo } from "react";
import { Copy, Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ViewInfo } from "vgi/client";
import type { Selection } from "@/lib/tree";
import { ColumnTypeBadge } from "./ColumnTypeBadge";
import { Breadcrumb } from "./Breadcrumb";
import { SqlCodeBlock } from "./SqlCodeBlock";
import { TagsTable } from "./TagsTable";
import { ExampleQueries } from "./ExampleQueries";
import { filterDisplayTags, getTag, parseExecutableExamples, TAG_DOC_MD, TAG_EXAMPLE_QUERIES, TAG_TITLE } from "@/lib/tags";
import { DescriptionSection } from "./DescriptionSection";
import { ObjectMeta } from "./ObjectMeta";
import { engine } from "@/lib/shell-bridge";
import { readRows, quoteLiteral } from "@/lib/duckdb-query";

interface ViewColumn {
  name: string;
  type: string;
}

interface Props {
  view: ViewInfo;
  catalogName?: string;
  schemaName?: string;
  onNavigate?: (selection: Selection) => void;
  onOpenShell?: () => void;
}

export function ViewDetail({ view, catalogName, schemaName, onNavigate, onOpenShell }: Props) {
  const [columns, setColumns] = useState<ViewColumn[] | null>(null);
  const [copied, setCopied] = useState(false);
  const displayTags = useMemo(() => filterDisplayTags(view.tags), [view.tags]);
  const title = getTag(view.tags, TAG_TITLE);
  const docMd = getTag(view.tags, TAG_DOC_MD);
  const executableExamples = useMemo(() => parseExecutableExamples(view.tags), [view.tags]);

  // Fetch columns from DuckDB if shell is available
  useEffect(() => {
    const queryFn = engine.query;
    if (!queryFn || !catalogName || !schemaName) return;

    (async () => {
      try {
        // These are VALUE comparisons — quoteLiteral, not raw interpolation.
        // Unescaped, any name containing an apostrophe terminated the literal
        // early and produced a parse error instead of the column list.
        const rows = await readRows(
          `SELECT column_name, data_type FROM duckdb_columns()` +
            ` WHERE database_name = ${quoteLiteral(catalogName)}` +
            ` AND schema_name = ${quoteLiteral(schemaName)}` +
            ` AND table_name = ${quoteLiteral(view.name)}` +
            ` ORDER BY column_index`
        );
        if (!rows) return;
        setColumns(
          rows.map((r) => ({
            name: String(r.column_name ?? ""),
            type: String(r.data_type ?? "VARCHAR"),
          }))
        );
      } catch (e) {
        console.error("Failed to fetch view columns:", e);
      }
    })();
  }, [view.name, catalogName, schemaName]);

  const handleCopyDef = () => {
    navigator.clipboard.writeText(view.definition);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div>
      <Breadcrumb catalogName={catalogName || ""} schemaName={schemaName || view.schema_name} itemName={view.name} itemType="view" onNavigate={onNavigate} />

      {title && <h1 className="text-xl font-semibold mt-1 mb-1">{title}</h1>}

      {view.comment && (
        <p className="text-muted-foreground mb-4">{view.comment}</p>
      )}

      {docMd && <DescriptionSection markdown={docMd} />}

      <ObjectMeta tags={view.tags} />

      {/* Columns */}
      {columns && columns.length > 0 && (
        <>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mt-4 mb-2">
            Columns
            <Badge variant="secondary" className="ml-2 text-xs px-1.5 py-0 normal-case">{columns.length}</Badge>
          </h2>
          <div className="border rounded-md overflow-hidden mb-4 bg-card shadow-sm">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left px-3 py-1.5 text-xs font-medium text-muted-foreground">Name</th>
                  <th className="text-left px-3 py-1.5 text-xs font-medium text-muted-foreground">Type</th>
                </tr>
              </thead>
              <tbody>
                {columns.map((col, i) => (
                  <tr key={i} className="border-t border-border">
                    <td className="px-3 py-1.5 font-mono font-medium text-foreground/80">{col.name}</td>
                    <td className="px-3 py-1.5">
                      <ColumnTypeBadge type={col.type} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* View Definition */}
      {view.definition && (
        <>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mt-6 mb-2">View Definition</h2>
          <div className="bg-card border rounded-md shadow-sm px-4 py-3 mb-4">
            <div className="flex items-start justify-between gap-2 mb-2">
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">SQL</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCopyDef}
                className="h-6 px-2 text-xs shrink-0"
              >
                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                <span className="ml-1">{copied ? "Copied" : "Copy"}</span>
              </Button>
            </div>
            <SqlCodeBlock query={view.definition} />
          </div>
        </>
      )}

      {/* Tags */}
      {displayTags && (
        <TagsTable tags={displayTags} />
      )}

      {/* Example Queries */}
      <ExampleQueries exampleQueriesJson={view.tags?.[TAG_EXAMPLE_QUERIES]} queries={executableExamples} onOpenShell={onOpenShell} />
    </div>
  );
}
