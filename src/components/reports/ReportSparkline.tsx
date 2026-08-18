import type { ReportSparklineBlock } from "@/lib/reports/types";
import { buildSparklineSeries } from "@/lib/reports/sparkline";

interface Props {
  block: ReportSparklineBlock;
  rows: Record<string, any>[];
  formatValue: (value: unknown, format?: ReportSparklineBlock["format"]) => string;
}

export function ReportSparkline({ block, rows, formatValue }: Props) {
  const series = buildSparklineSeries(rows, block.valueColumn);
  if (!series.latest) return <div className="h-full flex items-center justify-center text-xs text-muted-foreground">No numeric values</div>;
  const color = block.color || "var(--primary)";
  const label = block.labelColumn ? series.latest.row[block.labelColumn] : null;
  const [latestX, latestY] = series.points.split(" ").at(-1)!.split(",");
  return <div data-testid="report-sparkline" className="h-full min-h-0 flex items-end gap-3 overflow-hidden">
    {block.showValue !== false && <div className="shrink-0 min-w-0 pb-0.5">
      <div className="text-2xl leading-none font-semibold tabular-nums">{formatValue(series.latest.value, block.format)}</div>
      {label != null && <div className="mt-1 max-w-28 truncate text-[10px] leading-none text-muted-foreground">{String(label)}</div>}
    </div>}
    <svg
      aria-label={`${block.title || block.valueColumn} trend`}
      className="min-w-0 flex-1 h-full max-h-16 overflow-visible"
      viewBox="0 0 100 32"
      preserveAspectRatio="none"
      role="img"
    >
      <polygon points={series.areaPoints} fill={color} opacity="0.12" />
      <polyline points={series.points} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <line x1={latestX} x2={latestX} y1={latestY} y2={latestY} stroke={color} strokeWidth="4" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  </div>;
}
