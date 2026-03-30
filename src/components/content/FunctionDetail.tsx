import { FunctionSquare } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { FunctionInfo } from "vgi/client";

interface Props {
  func: FunctionInfo;
}

export function FunctionDetail({ func }: Props) {
  return (
    <div>
      <div className="flex items-center gap-3 mb-2">
        <FunctionSquare className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold font-mono text-primary">{func.name}</h1>
        <Badge variant="secondary" className="text-xs bg-green-50 text-green-700">function</Badge>
      </div>
      {func.description && (
        <p className="text-muted-foreground mb-6">{func.description}</p>
      )}
    </div>
  );
}
