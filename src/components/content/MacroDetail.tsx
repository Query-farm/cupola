import type { MacroInfo } from "vgi/client";
import type { Selection } from "@/lib/tree";
import { Breadcrumb } from "./Breadcrumb";
import { SqlCodeBlock } from "./SqlCodeBlock";
import { TagsTable } from "./TagsTable";
import { filterDisplayTags } from "@/lib/tags";
import { useMemo } from "react";

interface Props {
  macro: MacroInfo;
  catalogName: string;
  schemaName?: string;
  onNavigate?: (selection: Selection) => void;
}

export function MacroDetail({ macro, catalogName, schemaName, onNavigate }: Props) {
  const displayTags = useMemo(() => filterDisplayTags(macro.tags), [macro.tags]);

  return (
    <div>
      <Breadcrumb catalogName={catalogName} schemaName={schemaName || macro.schema_name} itemName={macro.name} itemType="macro" onNavigate={onNavigate} />
      {macro.comment && (
        <p className="text-muted-foreground mb-4">{macro.comment}</p>
      )}

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
    </div>
  );
}
