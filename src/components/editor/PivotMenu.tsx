/**
 * Open a query in Perspective. They differ in who holds the data and when the
 * query runs, which matters most for big results; `src/lib/pivot-source.ts`
 * has the details. Two placements: "Pivot" in the results pane offers all
 * three modes for a result already on screen, and "Run in Perspective" in the
 * toolbar offers the two SQL-backed ones, which never run the query in the
 * editor and so never buffer its result there.
 */
import { BarChart3, Camera, Database, Loader2, Radio } from "lucide-react";
import { Popover as BaseUIPopover } from "@base-ui/react/popover";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { PerspectivePivotMode } from "@/lib/pivot-source";

const MODES: Array<{ mode: PerspectivePivotMode; label: string; description: string; icon: typeof Radio }> = [
  {
    mode: "view",
    label: "Live view",
    description: "Perspective queries DuckDB as you pivot and scroll. Nothing is copied; your query re-runs for each change.",
    icon: Radio,
  },
  {
    mode: "table",
    label: "Table",
    description: "Runs your query once into a DuckDB temp table, then pivots with SQL against it.",
    icon: Database,
  },
  {
    mode: "snapshot",
    label: "Snapshot",
    description: "Copies these results into Perspective. Works for any result; frozen, and uses the most memory.",
    icon: Camera,
  },
];

interface Props {
  onPivot: (mode: PerspectivePivotMode) => void;
  /** The mode being prepared; a table pivot runs the whole query first. */
  busy?: PerspectivePivotMode | null;
  disabled?: boolean;
  /** Modes offered, in menu order. */
  modes?: PerspectivePivotMode[];
  label?: string;
  title?: string;
  triggerClassName?: string;
  testId?: string;
  /** Each item's test id is `${itemTestIdPrefix}-${mode}`. */
  itemTestIdPrefix?: string;
  align?: "start" | "center" | "end";
}

const RESULTS_PANE_TRIGGER = "flex items-center gap-1.5 px-2 py-1 text-xs rounded border border-border hover:bg-foreground/5 transition-colors disabled:opacity-60 disabled:pointer-events-none";

export function PivotMenu({
  onPivot,
  busy,
  disabled,
  modes = ["view", "table", "snapshot"],
  label = "Pivot",
  title = "Open these results in the Perspective pivot",
  triggerClassName = RESULTS_PANE_TRIGGER,
  testId = "editor-open-perspective",
  itemTestIdPrefix = "editor-pivot",
  align = "end",
}: Props) {
  return (
    <Popover>
      <PopoverTrigger
        className={triggerClassName}
        title={title}
        disabled={disabled || !!busy}
        data-testid={testId}
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <BarChart3 className="h-3.5 w-3.5" />}
        <span>{busy ? "Preparing pivot…" : label}</span>
      </PopoverTrigger>
      <PopoverContent className="p-1 w-72" align={align}>
        {MODES.filter(({ mode }) => modes.includes(mode)).map(({ mode, label, description, icon: Icon }) => (
          <BaseUIPopover.Close
            key={mode}
            onClick={() => onPivot(mode)}
            data-testid={`${itemTestIdPrefix}-${mode}`}
            className="flex items-start gap-2 w-full px-2 py-1.5 text-left rounded hover:bg-foreground/5 transition-colors"
          >
            <Icon className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>
              <span className="block text-xs font-medium">{label}</span>
              <span className="block text-[10px] leading-snug text-muted-foreground">{description}</span>
            </span>
          </BaseUIPopover.Close>
        ))}
      </PopoverContent>
    </Popover>
  );
}
