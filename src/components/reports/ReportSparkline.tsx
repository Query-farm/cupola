import { useId } from "react";
import type { ReportSparklineBlock } from "@/lib/reports/types";
import { buildSparklineSeries, findSparklineSplit, selectSparklineHeadline } from "@/lib/reports/sparkline";

interface Props {
  block: ReportSparklineBlock;
  rows: Record<string, any>[];
  formatValue: (value: unknown, format?: ReportSparklineBlock["format"]) => string;
}

export function ReportSparkline({ block, rows, formatValue }: Props) {
  const id = useId().replace(/:/g, "");
  const series = buildSparklineSeries(rows, block.valueColumn);
  if (!series.latest) return <div className="h-full flex items-center justify-center text-xs text-muted-foreground">No numeric values</div>;
  const color = block.color || "var(--primary)";
  const split = block.splitColumn ? findSparklineSplit(series, block.splitColumn) : null;
  const headline = selectSparklineHeadline(series, split, block.headlineRow, block.headlineValueColumn)!;
  const splitColor = split && block.splitColor ? block.splitColor : null;
  const label = block.labelColumn ? headline.datum.row[block.labelColumn] : null;
  const [headlineX, headlineY] = series.points.split(" ")[headline.index].split(",");
  const headlineColor = splitColor && split && headline.index >= split.index ? splitColor : color;
  return <div data-testid="report-sparkline" className="h-full min-h-0 flex items-end gap-3 overflow-hidden">
    {block.showValue !== false && <div className="shrink-0 min-w-0 pb-0.5">
      <div data-testid="report-sparkline-value" className="text-2xl leading-none font-semibold tabular-nums">{formatValue(headline.value, block.format)}</div>
      {label != null && <div className="mt-1 max-w-28 truncate text-[10px] leading-none text-muted-foreground">{String(label)}</div>}
    </div>}
    <svg
      aria-label={`${block.title || block.valueColumn} trend`}
      className="min-w-0 flex-1 h-full max-h-16 overflow-visible"
      viewBox="0 0 100 32"
      preserveAspectRatio="none"
      role="img"
    >
      {splitColor && <defs>
        <clipPath id={`${id}-before`} clipPathUnits="userSpaceOnUse"><rect x="0" y="0" width={split!.x} height="32" /></clipPath>
        <clipPath id={`${id}-after`} clipPathUnits="userSpaceOnUse"><rect x={split!.x} y="0" width={100 - split!.x} height="32" /></clipPath>
      </defs>}
      <polygon points={series.areaPoints} fill={color} opacity="0.12" clipPath={splitColor ? `url(#${id}-before)` : undefined} />
      <polyline points={series.points} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" clipPath={splitColor ? `url(#${id}-before)` : undefined} />
      {splitColor && <>
        <polygon points={series.areaPoints} fill={splitColor} opacity="0.12" clipPath={`url(#${id}-after)`} />
        <polyline points={series.points} fill="none" stroke={splitColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" clipPath={`url(#${id}-after)`} />
      </>}
      {split && <g><title>{block.splitLabel || "Series split"}</title><line
        data-testid="report-sparkline-split"
        aria-label={block.splitLabel || "Series split"}
        x1={split.x}
        x2={split.x}
        y1="1"
        y2="31"
        stroke="var(--muted-foreground)"
        strokeWidth="1.25"
        strokeDasharray="2 2"
        vectorEffect="non-scaling-stroke"
      /></g>}
      <line data-testid="report-sparkline-headline-point" x1={headlineX} x2={headlineX} y1={headlineY} y2={headlineY} stroke={headlineColor} strokeWidth="4" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  </div>;
}
