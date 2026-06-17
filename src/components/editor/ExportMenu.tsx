/**
 * Export dropdown for the results pane: CSV / Arrow / Excel, plus "Open in
 * Perspective". Mirrors ChartDownloadMenu's popover pattern.
 */
import { Download, FileText, FileSpreadsheet, Boxes, BarChart3 } from "lucide-react";
import { Popover as BaseUIPopover } from "@base-ui/react/popover";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { ExportFormat } from "@/lib/editor/result-export";

interface Props {
  onExport: (format: ExportFormat) => void | Promise<void>;
  onOpenInPerspective?: () => void;
  disabled?: boolean;
}

export function ExportMenu({ onExport, onOpenInPerspective, disabled }: Props) {
  return (
    <Popover>
      <PopoverTrigger
        className="flex items-center gap-1.5 px-2 py-1 text-xs rounded border border-border hover:bg-foreground/5 transition-colors disabled:opacity-40 disabled:pointer-events-none"
        title="Export results"
        disabled={disabled}
        data-testid="editor-export-menu"
      >
        <Download className="h-3.5 w-3.5" />
        <span>Export</span>
      </PopoverTrigger>
      <PopoverContent className="p-1 min-w-[180px]">
        <BaseUIPopover.Close
          onClick={() => onExport("csv")}
          data-testid="editor-export-csv"
          className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-foreground/5 transition-colors text-left"
        >
          <FileText className="h-3.5 w-3.5" />
          <span>CSV (.csv)</span>
        </BaseUIPopover.Close>
        <BaseUIPopover.Close
          onClick={() => onExport("excel")}
          data-testid="editor-export-excel"
          className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-foreground/5 transition-colors text-left"
        >
          <FileSpreadsheet className="h-3.5 w-3.5" />
          <span>Excel (.xlsx)</span>
        </BaseUIPopover.Close>
        <BaseUIPopover.Close
          onClick={() => onExport("arrow")}
          data-testid="editor-export-arrow"
          className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-foreground/5 transition-colors text-left"
        >
          <Boxes className="h-3.5 w-3.5" />
          <span>Arrow (.arrow)</span>
        </BaseUIPopover.Close>
        {onOpenInPerspective && (
          <>
            <div className="my-1 h-px bg-border" />
            <BaseUIPopover.Close
              onClick={() => onOpenInPerspective()}
              data-testid="editor-open-perspective"
              className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-foreground/5 transition-colors text-left"
            >
              <BarChart3 className="h-3.5 w-3.5" />
              <span>Open in Perspective</span>
            </BaseUIPopover.Close>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
