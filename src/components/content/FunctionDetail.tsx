import { useMemo } from "react";
import type { FunctionInfo } from "vgi/client";
import type { Selection } from "@/lib/tree";
import {
  getFunctionArgs,
  getFunctionReturn,
  isTableFunction,
  formatFunctionSignature,
  type FunctionArg,
} from "@/lib/function-info";
import { Badge } from "@/components/ui/badge";
import { Breadcrumb } from "./Breadcrumb";
import { DescriptionSection } from "./DescriptionSection";
import { ExampleQueries } from "./ExampleQueries";
import { TagsTable } from "./TagsTable";
import { filterDisplayTags, TAG_EXAMPLE_QUERIES, TAG_DESCRIPTION_MD } from "@/lib/tags";

interface Props {
  func: FunctionInfo;
  catalogName?: string;
  schemaName?: string;
  onNavigate?: (selection: Selection) => void;
  onOpenShell?: () => void;
}

const SECTION_HEADING =
  "text-sm font-semibold text-muted-foreground uppercase tracking-wide mt-4 mb-2";

/** Human label for the function_type wire value. */
function functionTypeLabel(type: FunctionInfo["function_type"]): string {
  switch (type) {
    case "TABLE":
      return "Table function";
    case "TABLE_BUFFERING":
      return "Table function (buffering)";
    case "AGGREGATE":
      return "Aggregate function";
    case "SCALAR":
      return "Scalar function";
    default:
      return String(type);
  }
}

/** Small badges describing an argument's kind (named / table / any / varargs / const). */
function ArgKindBadges({ arg }: { arg: FunctionArg }) {
  const kinds: string[] = [];
  if (arg.named) kinds.push("named");
  if (arg.isTableInput) kinds.push("table input");
  if (arg.isAnyType) kinds.push("any");
  if (arg.isVarargs) kinds.push("varargs");
  if (arg.isConst) kinds.push("const");
  if (kinds.length === 0) return <span className="text-muted-foreground">positional</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {kinds.map((k) => (
        <Badge key={k} variant="outline" className="font-normal">
          {k}
        </Badge>
      ))}
    </span>
  );
}

export function FunctionDetail({ func, catalogName, schemaName, onNavigate, onOpenShell }: Props) {
  const displayTags = useMemo(() => filterDisplayTags(func.tags), [func.tags]);
  const args = useMemo(() => getFunctionArgs(func), [func]);
  const ret = useMemo(() => getFunctionReturn(func), [func]);
  const signature = useMemo(() => formatFunctionSignature(func), [func]);
  const tableFn = isTableFunction(func);

  const descriptionMd = func.tags?.[TAG_DESCRIPTION_MD];
  const plainDescription = func.description || func.comment;

  // FunctionInfo has TWO example channels — a structured first-class
  // `examples: CatalogExample[]` (server-defined) and an optional
  // `vgi.example_queries` JSON tag (user-defined). Pass both to
  // ExampleQueries, which merges and de-dupes by SQL.
  const structuredExamples = (func.examples || []).map((e) => ({
    description: e.description || null,
    sql: e.sql,
  }));

  const hasProperties = Boolean(func.stability || func.null_handling || func.categories?.length);

  return (
    <div>
      {catalogName && schemaName && (
        <Breadcrumb catalogName={catalogName} schemaName={schemaName} itemName={func.name} itemType="function" onNavigate={onNavigate} />
      )}

      {/* Type badges */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <Badge variant="secondary">{functionTypeLabel(func.function_type)}</Badge>
        {func.stability && (
          <Badge variant="outline" className="font-normal">
            {func.stability}
          </Badge>
        )}
      </div>

      {/* Signature */}
      <h2 className={SECTION_HEADING}>Signature</h2>
      <div className="bg-muted/60 rounded-md px-4 py-3 mb-4">
        <code className="font-mono text-sm whitespace-pre-wrap break-words text-foreground/90">{signature}</code>
      </div>

      {/* Description */}
      {descriptionMd ? (
        <DescriptionSection markdown={descriptionMd} />
      ) : (
        plainDescription && <p className="text-muted-foreground mb-4">{plainDescription}</p>
      )}

      {/* Parameters */}
      {args.length > 0 && (
        <>
          <h2 className={SECTION_HEADING}>Parameters</h2>
          <div className="border rounded-md overflow-hidden mb-4">
            <table className="text-sm" style={{ tableLayout: "auto", width: "100%" }}>
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left px-3 py-1.5 text-xs font-medium text-muted-foreground">Name</th>
                  <th className="text-left px-3 py-1.5 text-xs font-medium text-muted-foreground">Type</th>
                  <th className="text-left px-3 py-1.5 text-xs font-medium text-muted-foreground">Kind</th>
                  <th className="text-left px-3 py-1.5 text-xs font-medium text-muted-foreground">Nullable</th>
                </tr>
              </thead>
              <tbody>
                {args.map((arg, i) => (
                  <tr key={i} className="border-t border-border">
                    <td className="px-3 py-1.5 font-mono font-medium text-foreground/80">{arg.name}</td>
                    <td className="px-3 py-1.5 font-mono text-foreground/70">
                      {arg.isAnyType ? "ANY" : arg.isTableInput ? "TABLE" : arg.duckdbType}
                    </td>
                    <td className="px-3 py-1.5 text-xs">
                      <ArgKindBadges arg={arg} />
                    </td>
                    <td className="px-3 py-1.5 text-muted-foreground">{arg.nullable ? "yes" : "no"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Returns */}
      <h2 className={SECTION_HEADING}>Returns</h2>
      {tableFn ? (
        ret.columns.length > 0 ? (
          <div className="border rounded-md overflow-hidden mb-4">
            <table className="text-sm" style={{ tableLayout: "auto", width: "100%" }}>
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left px-3 py-1.5 text-xs font-medium text-muted-foreground">Column</th>
                  <th className="text-left px-3 py-1.5 text-xs font-medium text-muted-foreground">Type</th>
                </tr>
              </thead>
              <tbody>
                {ret.columns.map((col, i) => (
                  <tr key={i} className="border-t border-border">
                    <td className="px-3 py-1.5 font-mono font-medium text-foreground/80">{col.name}</td>
                    <td className="px-3 py-1.5 font-mono text-foreground/70">{col.duckdbType}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-muted-foreground mb-4">A table whose columns are determined at query time.</p>
        )
      ) : (
        <p className="text-muted-foreground mb-4 font-mono">{ret.columns[0]?.duckdbType ?? "—"}</p>
      )}

      {/* Properties (light) */}
      {hasProperties && (
        <>
          <h2 className={SECTION_HEADING}>Properties</h2>
          <div className="border rounded-md overflow-hidden mb-4">
            <table className="text-sm" style={{ tableLayout: "auto", width: "100%" }}>
              <tbody>
                {func.stability && (
                  <tr className="border-b border-border last:border-0">
                    <td className="px-3 py-1.5 text-muted-foreground w-40">Stability</td>
                    <td className="px-3 py-1.5 font-mono text-foreground/80">{func.stability}</td>
                  </tr>
                )}
                {func.null_handling && (
                  <tr className="border-b border-border last:border-0">
                    <td className="px-3 py-1.5 text-muted-foreground w-40">Null handling</td>
                    <td className="px-3 py-1.5 font-mono text-foreground/80">{func.null_handling}</td>
                  </tr>
                )}
                {func.categories?.length > 0 && (
                  <tr className="border-b border-border last:border-0">
                    <td className="px-3 py-1.5 text-muted-foreground w-40">Categories</td>
                    <td className="px-3 py-1.5">
                      <span className="flex flex-wrap gap-1">
                        {func.categories.map((c) => (
                          <Badge key={c} variant="outline" className="font-normal">
                            {c}
                          </Badge>
                        ))}
                      </span>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
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
