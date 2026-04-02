import { FunctionSquare } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
      <div className="flex items-center gap-3 mb-1">
        <FunctionSquare className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold font-mono text-primary">{func.name}</h1>
        <Badge variant="secondary" className="text-xs bg-green-50 text-green-700">function</Badge>
      </div>

      {catalogName && schemaName && (
        <Breadcrumb catalogName={catalogName} schemaName={schemaName} itemName={func.name} itemType="function" onNavigate={onNavigate} />
      )}

      {func.description && (
        <p className="text-muted-foreground mb-6">{func.description}</p>
      )}
    </div>
  );
}
