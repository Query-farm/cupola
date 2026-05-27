/**
 * Download menu trigger for chart blocks. One icon button with a popover
 * listing PNG and SVG options — replaces the two separate icon buttons
 * the first iteration used (per user feedback).
 *
 * Shared by both the inline VegaChartBlock toolbar and the
 * MaximizedChartDialog header so the UX is identical at both sizes.
 */
import { Download, Image as ImageIcon, FileImage } from "lucide-react";
import { Popover as BaseUIPopover } from "@base-ui/react/popover";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

interface Props {
  /** Called with the chosen format. The caller does the actual download. */
  onDownload: (format: "png" | "svg") => void | Promise<void>;
  /** Trigger icon sizing — "sm" for the inline chat block, "md" for the
   *  maximize dialog where the toolbar buttons are larger. */
  size?: "sm" | "md";
  testId?: string;
}

export function ChartDownloadMenu({ onDownload, size = "sm", testId }: Props) {
  const iconClass = size === "md" ? "h-4 w-4" : "h-3.5 w-3.5";
  const buttonClass =
    size === "md"
      ? "p-1.5 rounded hover:bg-foreground/5 transition-colors"
      : "p-1 rounded hover:bg-foreground/5 transition-colors";

  return (
    <Popover>
      <PopoverTrigger
        className={buttonClass}
        title="Download"
        data-testid={testId}
      >
        <Download className={iconClass} />
      </PopoverTrigger>
      <PopoverContent className="p-1 min-w-[140px]">
        {/* PopoverClose dismisses the menu after the click; without it the
            popover stays open after the download which feels broken. */}
        <BaseUIPopover.Close
          onClick={() => onDownload("png")}
          data-testid="chart-download-png"
          className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-foreground/5 transition-colors text-left"
        >
          <ImageIcon className="h-3.5 w-3.5" />
          <span>PNG</span>
        </BaseUIPopover.Close>
        <BaseUIPopover.Close
          onClick={() => onDownload("svg")}
          data-testid="chart-download-svg"
          className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-foreground/5 transition-colors text-left"
        >
          <FileImage className="h-3.5 w-3.5" />
          <span>SVG</span>
        </BaseUIPopover.Close>
      </PopoverContent>
    </Popover>
  );
}
