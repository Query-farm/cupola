/**
 * "Save Results" — the result-data actions, living in the RESULTS pane header
 * rather than the editor toolbar.
 *
 * That placement is deliberate and follows the desktop tools: DBeaver puts its
 * "Export data" control on the results grid's own toolbar, and its docs are
 * explicit that saving the script and exporting the result data are separate
 * workflows. CloudBeaver's editor toolbar is script actions only. Ours had
 * result actions sitting in the editor toolbar next to script actions, which
 * is most of why that row felt like a junk drawer.
 *
 * "Open in Perspective" used to be an item in this menu. It is not a save, so
 * it moved out to its own button beside this one — under a menu called "Save
 * Results" it read as a file format.
 */
import { Download, FileText, FileSpreadsheet, Boxes } from "lucide-react";
import { Popover as BaseUIPopover } from "@base-ui/react/popover";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { ExportFormat } from "@/lib/editor/result-export";

interface Props {
  onExport: (format: ExportFormat) => void | Promise<void>;
  disabled?: boolean;
}

export function SaveResultsMenu({ onExport, disabled }: Props) {
  return (
    <Popover>
      <PopoverTrigger
        className="flex items-center gap-1.5 px-2 py-1 text-xs rounded border border-border hover:bg-foreground/5 transition-colors disabled:opacity-40 disabled:pointer-events-none"
        title="Save these results to a file"
        disabled={disabled}
        data-testid="editor-export-menu"
      >
        <Download className="h-3.5 w-3.5" />
        <span>Save Results</span>
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
      </PopoverContent>
    </Popover>
  );
}
