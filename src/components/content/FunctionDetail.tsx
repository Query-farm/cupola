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
import { useSettings } from "@/lib/settings";
import { Breadcrumb } from "./Breadcrumb";
import { ColumnTypeBadge } from "./ColumnTypeBadge";
import { DescriptionSection } from "./DescriptionSection";
import { ExampleQueries } from "./ExampleQueries";
import { TagsTable } from "./TagsTable";
import { ObjectMeta } from "./ObjectMeta";
import { ChatMarkdown } from "@/components/chat/ChatMarkdown";
import { filterDisplayTags, getTag, parseExecutableExamples, TAG_EXAMPLE_QUERIES, TAG_DOC_MD, TAG_TITLE, TAG_RESULT_COLUMNS_MD } from "@/lib/tags";

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

// Color-coded pills for an argument's kind. Calling convention (positional/named)
// reads as a neutral/blue base; the modifiers (const/varargs/table input/any) get
// their own tint from the same palette family as typeColorClass, so the Kind column
// scans as fast as the Type column.
const KIND_PILL: Record<string, string> = {
  positional: "bg-soil-100 text-soil-600 dark:bg-soil-800 dark:text-soil-300",
  named: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  const: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  varargs: "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300",
  "table input": "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  any: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300",
};

/** Color-coded pills describing an argument's kind (positional / named + any modifiers). */
function ArgKindBadges({ arg }: { arg: FunctionArg }) {
  // Calling convention is always shown (positional or named); modifiers append after.
  const kinds: string[] = [arg.named ? "named" : "positional"];
  if (arg.isConst) kinds.push("const");
  if (arg.isVarargs) kinds.push("varargs");
  if (arg.isTableInput) kinds.push("table input");
  if (arg.isAnyType) kinds.push("any");
  return (
    <span className="flex flex-wrap gap-1">
      {kinds.map((k) => (
        <span
          key={k}
          className={`text-[11px] px-1.5 py-0.5 rounded font-medium ${KIND_PILL[k] ?? KIND_PILL.positional}`}
        >
          {k}
        </span>
      ))}
    </span>
  );
}

/** True when the argument carries any discovery constraint (default/choices/range/pattern). */
function hasArgConstraints(arg: FunctionArg): boolean {
  return (
    arg.defaultValue !== undefined ||
    (arg.choices?.length ?? 0) > 0 ||
    arg.range !== undefined ||
    arg.pattern !== undefined
  );
}

/** Stacked constraint lines for one argument (default / allowed values / range / pattern).
 *  Renders nothing when the argument is unconstrained — callers gate on hasArgConstraints. */
function ArgConstraints({ arg }: { arg: FunctionArg }) {
  return (
    <div className="flex flex-col gap-1 text-xs">
      {arg.defaultValue !== undefined && (
        <div>
          <span className="text-muted-foreground">default </span>
          <code className="font-mono text-foreground/80">{arg.defaultValue}</code>
        </div>
      )}
      {arg.range !== undefined && (
        <div>
          <span className="text-muted-foreground">range </span>
          <code className="font-mono text-foreground/80">{arg.range}</code>
        </div>
      )}
      {arg.choices && arg.choices.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-muted-foreground">one of</span>
          {arg.choices.map((c) => (
            <Badge key={c} variant="secondary" className="font-mono font-normal">
              {c}
            </Badge>
          ))}
        </div>
      )}
      {arg.pattern !== undefined && (
        <div>
          <span className="text-muted-foreground">matches </span>
          <code className="font-mono text-foreground/80 break-all">{arg.pattern}</code>
        </div>
      )}
    </div>
  );
}

export function FunctionDetail({ func, catalogName, schemaName, onNavigate, onOpenShell }: Props) {
  const { settings } = useSettings();
  const displayTags = useMemo(() => filterDisplayTags(func.tags), [func.tags]);
  const args = useMemo(() => getFunctionArgs(func), [func]);
  // Only render the Constraints / Description columns when at least one argument
  // declares them — keeps simple functions' argument tables uncluttered.
  const anyConstraints = useMemo(() => args.some(hasArgConstraints), [args]);
  const anyDescriptions = useMemo(() => args.some((a) => Boolean(a.description)), [args]);
  const ret = useMemo(() => getFunctionReturn(func), [func]);
  const signature = useMemo(() => formatFunctionSignature(func), [func]);
  const tableFn = isTableFunction(func);

  const title = getTag(func.tags, TAG_TITLE);
  const descriptionMd = getTag(func.tags, TAG_DOC_MD);
  const plainDescription = func.description || func.comment;
  const resultColumnsMd = getTag(func.tags, TAG_RESULT_COLUMNS_MD);

  // FunctionInfo has TWO example channels — a structured first-class
  // `examples: CatalogExample[]` (server-defined) and an optional
  // `vgi.example_queries` JSON tag (user-defined). Also merge in any
  // `vgi.executable_examples`. ExampleQueries merges and de-dupes by SQL.
  const structuredExamples = useMemo(() => [
    ...(func.examples || []).map((e) => ({ description: e.description || null, sql: e.sql })),
    ...parseExecutableExamples(func.tags),
  ], [func.examples, func.tags]);

  const hasProperties = Boolean(func.stability || func.null_handling || func.categories?.length);

  return (
    <div>
      {catalogName && schemaName && (
        <Breadcrumb catalogName={catalogName} schemaName={schemaName} itemName={func.name} itemType="function" onNavigate={onNavigate} />
      )}

      {title && <h1 className="text-xl font-semibold mt-1 mb-2">{title}</h1>}

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

      <ObjectMeta tags={func.tags} />

      {/* Arguments */}
      {args.length > 0 && (
        <>
          <h2 className={SECTION_HEADING}>Arguments</h2>
          <div className="border rounded-md overflow-hidden mb-4">
            <table className="text-sm" style={{ tableLayout: "auto", width: "100%" }}>
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left px-3 py-1.5 text-xs font-medium text-muted-foreground align-top">Name</th>
                  <th className="text-left px-3 py-1.5 text-xs font-medium text-muted-foreground align-top">Type</th>
                  <th className="text-center px-3 py-1.5 text-xs font-medium text-muted-foreground align-top">Not Null</th>
                  <th className="text-left px-3 py-1.5 text-xs font-medium text-muted-foreground align-top">Kind</th>
                  {anyConstraints && (
                    <th className="text-left px-3 py-1.5 text-xs font-medium text-muted-foreground align-top">Constraints</th>
                  )}
                  {anyDescriptions && (
                    <th className="text-left px-3 py-1.5 text-xs font-medium text-muted-foreground align-top">Description</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {args.map((arg, i) => (
                  <tr key={i} className="border-t border-border align-top">
                    <td className="px-3 py-1.5 font-mono font-medium text-foreground/80">{arg.name}</td>
                    <td className="px-3 py-1.5 font-mono text-foreground/70">
                      <ColumnTypeBadge
                        type={arg.isAnyType ? "ANY" : arg.isTableInput ? "TABLE" : settings.showDuckDBTypes ? arg.duckdbType : arg.arrowType}
                      />
                    </td>
                    <td className="px-3 py-1.5 text-center">
                      {arg.nullable ? null : (
                        <span className="block text-center text-[10px] font-medium text-primary/60" title="Not null">✓</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-xs">
                      <ArgKindBadges arg={arg} />
                    </td>
                    {anyConstraints && (
                      <td className="px-3 py-1.5">
                        {hasArgConstraints(arg) ? (
                          <ArgConstraints arg={arg} />
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    )}
                    {anyDescriptions && (
                      <td className="px-3 py-1.5 text-muted-foreground max-w-md">
                        {arg.description ? (
                          <span className="whitespace-pre-wrap break-words">{arg.description}</span>
                        ) : (
                          <span>—</span>
                        )}
                      </td>
                    )}
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
                    <td className="px-3 py-1.5 font-mono text-foreground/70"><ColumnTypeBadge type={col.duckdbType} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : resultColumnsMd ? (
          <div className="mb-4"><ChatMarkdown content={resultColumnsMd} /></div>
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
