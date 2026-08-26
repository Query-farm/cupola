import type { ReportKpiBlock } from "@/lib/reports/types";
import { safeNumber as finiteNumber } from "@/lib/reports/numeric";

interface Props {
  block: ReportKpiBlock;
  row?: Record<string, any>;
  formatValue: (value: unknown, format?: ReportKpiBlock["format"]) => string;
}

function positionWithinRange(value: number, low: number, high: number): number {
  return Math.max(0, Math.min(100, ((value - low) / (high - low)) * 100));
}

export function ReportKpi({ block, row = {}, formatValue }: Props) {
  const rawValue = row[block.valueColumn];
  const value = finiteNumber(rawValue);
  const rawLow = block.lowColumn ? row[block.lowColumn] : null;
  const rawHigh = block.highColumn ? row[block.highColumn] : null;
  const firstBound = finiteNumber(rawLow);
  const secondBound = finiteNumber(rawHigh);
  const low = firstBound != null && secondBound != null ? Math.min(firstBound, secondBound) : null;
  const high = firstBound != null && secondBound != null ? Math.max(firstBound, secondBound) : null;
  const target = block.targetColumn ? finiteNumber(row[block.targetColumn]) : null;
  const hasRange = value != null && low != null && high != null && high > low;
  const valuePosition = hasRange ? positionWithinRange(value, low, high) : 0;
  const targetPosition = hasRange && target != null ? positionWithinRange(target, low, high) : null;
  const outside = hasRange ? (value < low ? "low" : value > high ? "high" : null) : null;

  return <div data-testid="report-kpi" className="flex h-full min-h-0 flex-col items-center justify-center text-center">
    <div data-testid="report-kpi-value" className="text-3xl font-semibold tabular-nums">{formatValue(rawValue, block.format)}</div>
    <div className="text-xs text-muted-foreground">{block.labelColumn ? String(row[block.labelColumn] ?? "") : block.title}</div>
    {hasRange && <div data-testid="report-kpi-range" className="mt-2 w-full max-w-56 px-1" aria-label={`${block.rangeLabel || "Range"}: ${formatValue(low, block.format)} to ${formatValue(high, block.format)}; current ${formatValue(rawValue, block.format)}${target != null ? `; target ${formatValue(target, block.format)}` : ""}`}>
      <div className="relative h-2 rounded-full border border-primary/20 bg-primary/15">
        {targetPosition != null && <span
          data-testid="report-kpi-range-target"
          title={`Target ${formatValue(target, block.format)}`}
          className="absolute -top-1 h-4 w-px bg-foreground/70"
          style={{ left: `${targetPosition}%` }}
        />}
        <span
          data-testid="report-kpi-range-value"
          data-outside={outside ?? "inside"}
          title={`Current ${formatValue(rawValue, block.format)}`}
          className="absolute top-1/2 h-3 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary ring-2 ring-background"
          style={{ left: `${valuePosition}%` }}
        />
        {outside && <span aria-hidden="true" className={`absolute -top-3 text-[9px] font-bold leading-none text-primary ${outside === "low" ? "left-0" : "right-0"}`}>{outside === "low" ? "‹" : "›"}</span>}
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-[9px] leading-none text-muted-foreground">
        <span className="tabular-nums">{formatValue(low, block.format)}</span>
        <span className="truncate">{block.rangeLabel || "Range"}</span>
        <span className="tabular-nums">{formatValue(high, block.format)}</span>
      </div>
    </div>}
  </div>;
}
