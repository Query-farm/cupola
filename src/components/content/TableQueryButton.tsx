import { useState } from "react";
import { Play, ChevronDown, Copy, Check } from "lucide-react";
import { Popover as BaseUIPopover } from "@base-ui/react/popover";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { bridge } from "@/lib/shell-bridge";

interface Props {
  /** The SQL to create/run (e.g. `SELECT * FROM cat.schema.table LIMIT 100`). */
  sql: string;
  /** Switch the workspace to the xterm SQL Shell tab (no SQL run). */
  onOpenShell?: () => void;
  /** Render the caret + dropdown of secondary actions (top control only). */
  withMenu?: boolean;
  /** Primary segment emphasis: filled `default` (top) or low-key `outline` (bottom). */
  primaryVariant?: "default" | "outline";
}

/**
 * "Create SELECT query" action for the Table detail page. The primary click
 * opens a new Query Editor tab pre-filled with `sql` and runs it (switching the
 * workspace to the editor); the optional caret menu holds the demoted
 * "Open SQL Shell" and a zero-side-effect "Copy SELECT query".
 */
export function TableQueryButton({ sql, onOpenShell, withMenu, primaryVariant = "default" }: Props) {
  const [copied, setCopied] = useState(false);

  // Deterministic "open a new editor tab + run" path, with the same fallback
  // ladder ExampleQueries uses when the editor surface isn't mounted.
  const runInEditor = () => {
    if (bridge.openInEditor) {
      bridge.openInEditor(sql);
      return;
    }
    bridge.activateShell?.();
    setTimeout(() => bridge.runQuery?.(sql), 150);
  };

  const copySql = () => {
    try {
      navigator.clipboard?.writeText(sql);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may reject on insecure contexts — ignore */
    }
  };

  const primary = (
    <Button
      variant={primaryVariant}
      size="sm"
      onClick={runInEditor}
      title="Create a SELECT query — opens a new SQL Editor tab and runs it"
      data-testid="table-query-create"
      className={cn("gap-1.5", withMenu && "rounded-r-none")}
    >
      <Play className="h-3.5 w-3.5" />
      Create SELECT query
    </Button>
  );

  if (!withMenu) return primary;

  return (
    <div className="inline-flex">
      {primary}
      <Popover>
        <PopoverTrigger
          aria-label="More query actions"
          data-testid="table-query-menu"
          className={cn(
            buttonVariants({ variant: primaryVariant, size: "icon-sm" }),
            "rounded-l-none border-l border-primary-foreground/25",
          )}
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </PopoverTrigger>
        <PopoverContent className="p-1 min-w-[200px]">
          <BaseUIPopover.Close
            onClick={runInEditor}
            data-testid="table-query-create-menu"
            className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-foreground/5 transition-colors text-left"
          >
            <Play className="h-3.5 w-3.5" />
            <span>Create SELECT query</span>
          </BaseUIPopover.Close>
          {onOpenShell && (
            <BaseUIPopover.Close
              onClick={onOpenShell}
              data-testid="table-open-shell"
              className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-foreground/5 transition-colors text-left"
            >
              <img src={`${import.meta.env.BASE_URL}duckdb-icon-light.svg`} alt="" className="h-3.5 w-3.5" />
              <span>Open SQL Shell</span>
            </BaseUIPopover.Close>
          )}
          <div className="my-1 h-px bg-border" />
          <BaseUIPopover.Close
            onClick={copySql}
            data-testid="table-copy-sql"
            className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-foreground/5 transition-colors text-left"
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            <span>{copied ? "Copied" : "Copy SELECT query"}</span>
          </BaseUIPopover.Close>
        </PopoverContent>
      </Popover>
    </div>
  );
}
