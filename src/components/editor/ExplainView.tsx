import { useMemo, useState } from "react";
import { Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  /** apache-arrow Table from an EXPLAIN result (explain_key / explain_value). */
  table: any;
}

interface ExplainRow {
  key: string;
  value: string;
}

/**
 * Renders DuckDB EXPLAIN output the way the CLI does: the explain_value already
 * contains the box-drawn plan tree, so we print it verbatim in a monospace block
 * rather than cramming it into a 2-column grid cell.
 */
export function ExplainView({ table }: Props) {
  const [copied, setCopied] = useState(false);

  const rows = useMemo<ExplainRow[]>(() => {
    const fieldNames: string[] = table.schema.fields.map((f: any) => f.name);
    const keyIdx = fieldNames.indexOf("explain_key");
    const valIdx = fieldNames.indexOf("explain_value");
    const out: ExplainRow[] = [];
    for (let r = 0; r < table.numRows; r++) {
      out.push({
        key: String(table.getChildAt(keyIdx)?.get(r) ?? ""),
        value: String(table.getChildAt(valIdx)?.get(r) ?? ""),
      });
    }
    return out;
  }, [table]);

  function handleCopy() {
    const text = rows
      .map((row) => (row.key ? `${row.key}\n${row.value}` : row.value))
      .join("\n\n");
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  }

  return (
    <div className="relative h-full overflow-auto p-3">
      <Button
        variant="outline"
        size="sm"
        onClick={handleCopy}
        className={`absolute right-3 top-3 z-10 h-6 px-2 text-xs gap-1 ${
          copied ? "text-accent border-accent" : ""
        }`}
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        {copied ? "Copied" : "Copy"}
      </Button>
      {rows.map((row, i) => (
        <div key={i} className="mb-4 last:mb-0">
          {row.key && (
            <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {row.key}
            </div>
          )}
          <pre className="overflow-x-auto whitespace-pre text-xs font-mono leading-relaxed">
            {row.value}
          </pre>
        </div>
      ))}
    </div>
  );
}
