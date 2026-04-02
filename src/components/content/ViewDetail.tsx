import { Eye } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { ViewInfo } from "vgi/client";
import type { Selection } from "@/lib/tree";
import { Breadcrumb } from "./Breadcrumb";

interface Props {
  view: ViewInfo;
  catalogName?: string;
  schemaName?: string;
  onNavigate?: (selection: Selection) => void;
}

export function ViewDetail({ view, catalogName, schemaName, onNavigate }: Props) {
  return (
    <div>
      <div className="flex items-center gap-3 mb-1">
        <Eye className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold font-mono text-primary">{view.name}</h1>
        <Badge variant="secondary" className="text-xs bg-purple-50 text-purple-700">view</Badge>
      </div>

      {catalogName && schemaName && (
        <Breadcrumb catalogName={catalogName} schemaName={schemaName} itemName={view.name} itemType="view" onNavigate={onNavigate} />
      )}

      {view.comment && (
        <p className="text-muted-foreground mb-6">{view.comment}</p>
      )}
    </div>
  );
}
