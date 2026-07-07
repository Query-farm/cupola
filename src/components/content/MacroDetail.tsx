import type { MacroInfo } from "vgi/client";
import type { Selection } from "@/lib/tree";
import { Breadcrumb } from "./Breadcrumb";
import { SqlCodeBlock } from "./SqlCodeBlock";
import { TagsTable } from "./TagsTable";
import { ExampleQueries } from "./ExampleQueries";
import { filterDisplayTags, getTag, parseExecutableExamples, TAG_DOC_MD, TAG_EXAMPLE_QUERIES, TAG_TITLE } from "@/lib/tags";
import { DescriptionSection } from "./DescriptionSection";
import { ObjectMeta } from "./ObjectMeta";
import { useMemo } from "react";

interface Props {
  macro: MacroInfo;
  catalogName: string;
  schemaName?: string;
  onNavigate?: (selection: Selection) => void;
  onOpenShell?: () => void;
}

export function MacroDetail({ macro, catalogName, schemaName, onNavigate, onOpenShell }: Props) {
  const displayTags = useMemo(() => filterDisplayTags(macro.tags), [macro.tags]);
  const title = getTag(macro.tags, TAG_TITLE);
  const docMd = getTag(macro.tags, TAG_DOC_MD);
  const executableExamples = useMemo(() => parseExecutableExamples(macro.tags), [macro.tags]);

  return (
    <div>
      <Breadcrumb catalogName={catalogName} schemaName={schemaName || macro.schema_name} itemName={macro.name} itemType="macro" onNavigate={onNavigate} />
      {title && <h1 className="text-xl font-semibold mt-1 mb-1">{title}</h1>}
      {macro.comment && (
        <p className="text-muted-foreground mb-4">{macro.comment}</p>
      )}

      {docMd && <DescriptionSection markdown={docMd} />}

      <ObjectMeta tags={macro.tags} />

      {/* Parameters */}
      {macro.parameters.length > 0 && (
        <>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mt-4 mb-2">Parameters</h2>
          <div className="border rounded-md overflow-hidden mb-4">
            <table className="text-sm" style={{ tableLayout: "auto", width: "100%" }}>
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left px-3 py-1.5 text-xs font-medium text-muted-foreground">Name</th>
                </tr>
              </thead>
              <tbody>
                {macro.parameters.map((param, i) => (
                  <tr key={i} className="border-t border-border">
                    <td className="px-3 py-1.5 font-mono font-medium text-foreground/80">{param}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Definition */}
      {macro.definition && (
        <>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mt-4 mb-2">Definition</h2>
          <div className="bg-muted/60 rounded-md px-4 py-3 mb-4">
            <SqlCodeBlock query={macro.definition} />
          </div>
        </>
      )}

      {/* Tags */}
      {displayTags && (
        <TagsTable tags={displayTags} />
      )}

      <ExampleQueries
        exampleQueriesJson={macro.tags?.[TAG_EXAMPLE_QUERIES]}
        queries={executableExamples}
        onOpenShell={onOpenShell}
      />
    </div>
  );
}
