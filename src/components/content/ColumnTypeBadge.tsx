/**
 * Renders a column/parameter type as a color-coded badge.
 *
 * Scalar types render on a single line. STRUCT types — which can be deeply
 * nested and unreadable on one line — are pretty-printed with newlines and
 * indentation via formatTypeMultiline, in a horizontally-scrollable <pre>.
 */

import { typeColorClass } from "@/lib/tree";
import { formatTypeMultiline } from "@/lib/arrow-to-duckdb";

interface ColumnTypeBadgeProps {
  type: string;
  className?: string;
}

export function ColumnTypeBadge({ type, className = "" }: ColumnTypeBadgeProps) {
  const base = `font-mono text-[11px] px-1.5 py-0.5 rounded ${typeColorClass(type)} ${className}`;
  if (type.includes("STRUCT<")) {
    return (
      <pre className={`${base} whitespace-pre overflow-x-auto m-0 inline-block align-top`}>
        {formatTypeMultiline(type)}
      </pre>
    );
  }
  return <span className={base}>{type}</span>;
}
