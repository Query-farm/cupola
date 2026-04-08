import type { FunctionInfo } from "vgi/client";
import type { Selection } from "@/lib/tree";
import { Breadcrumb } from "./Breadcrumb";

interface Props {
  func: FunctionInfo;
  catalogName?: string;
  schemaName?: string;
  onNavigate?: (selection: Selection) => void;
}

export function FunctionDetail({ func, catalogName, schemaName, onNavigate }: Props) {
  return (
    <div>
      {catalogName && schemaName && (
        <Breadcrumb catalogName={catalogName} schemaName={schemaName} itemName={func.name} itemType="function" onNavigate={onNavigate} />
      )}

      {func.description && (
        <p className="text-muted-foreground mb-6">{func.description}</p>
      )}
    </div>
  );
}
