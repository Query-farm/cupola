/**
 * "Pivot" — open the result in Perspective, three ways. They differ in who
 * holds the data and when the query runs, which matters most for big results;
 * `src/lib/pivot-source.ts` has the details.
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
}

export function PivotMenu({ onPivot, busy }: Props) {
  return (
    <Popover>
      <PopoverTrigger
        className="flex items-center gap-1.5 px-2 py-1 text-xs rounded border border-border hover:bg-foreground/5 transition-colors disabled:opacity-60 disabled:pointer-events-none"
        title="Open these results in the Perspective pivot"
        disabled={!!busy}
        data-testid="editor-open-perspective"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <BarChart3 className="h-3.5 w-3.5" />}
        <span>{busy ? "Preparing pivot…" : "Pivot"}</span>
      </PopoverTrigger>
      <PopoverContent className="p-1 w-72">
        {MODES.map(({ mode, label, description, icon: Icon }) => (
          <BaseUIPopover.Close
            key={mode}
            onClick={() => onPivot(mode)}
            data-testid={`editor-pivot-${mode}`}
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
