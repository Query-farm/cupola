import { useState } from "react";
import { Copy, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SqlCodeBlock } from "./SqlCodeBlock";

interface ExampleQuery {
  name?: string | null;
  description?: string | null;
  sql: string;
}

interface Props {
  /** Raw JSON string from the example_queries tag, or null for default query. */
  exampleQueriesJson?: string | null;
  /** Fallback query when no example_queries tag exists. */
  defaultSql?: string;
  /** Whether the shell can be opened to run queries. */
  onOpenShell?: () => void;
}

function parseExampleQueries(json: string): ExampleQuery[] | null {
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) {
      return parsed.map((q: any) =>
        typeof q === "string"
          ? { sql: q }
          : {
              name: q.name || q.label || null,
              description: q.description || null,
              sql: q.sql || q.query || String(q),
            }
      );
    }
  } catch {}
  return null;
}

export function ExampleQueries({ exampleQueriesJson, defaultSql, onOpenShell }: Props) {
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  const queries: ExampleQuery[] =
    (exampleQueriesJson ? parseExampleQueries(exampleQueriesJson) : null)
    || (defaultSql ? [{ sql: defaultSql }] : []);

  if (queries.length === 0) return null;

  const handleCopy = (sql: string, idx: number) => {
    navigator.clipboard.writeText(sql);
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx(null), 1500);
  };

  const handleRun = (sql: string) => {
    (window as any).__shellActivate?.();
    setTimeout(() => {
      (window as any).__shellRunQuery?.(sql);
    }, 150);
  };

  return (
    <>
      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mt-6 mb-2">
        {queries.length > 1 ? "Example Queries" : "Example Query"}
      </h2>
      <div className="flex flex-col gap-2 mb-6">
        {queries.map((q, i) => (
          <div key={i}>
            {(q.name || q.description) && (
              <div className="mb-1">
                {q.name && <span className="text-xs font-medium text-foreground/80">{q.name}</span>}
                {q.name && q.description && <span className="text-xs text-muted-foreground"> — </span>}
                {q.description && <span className="text-xs text-muted-foreground">{q.description}</span>}
              </div>
            )}
            <div className="flex items-start gap-2 bg-muted/60 rounded-md px-3 py-2">
              <div className="flex-1 min-w-0">
                <SqlCodeBlock query={q.sql} />
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleCopy(q.sql, i)}
                className="h-6 px-2 text-xs shrink-0"
              >
                <Copy className="h-3 w-3" />
                <span className="ml-1">{copiedIdx === i ? "Copied" : "Copy"}</span>
              </Button>
              {onOpenShell && (
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => handleRun(q.sql)}
                  className="h-6 px-2 text-xs shrink-0 gap-1"
                >
                  <Play className="h-3 w-3" />
                  Run
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/** Filter example_queries out of a tags record for display in TagsTable. */
export function filterExampleQueriesTag(tags?: Record<string, string> | null): Record<string, string> | null {
  if (!tags) return null;
  const filtered: Record<string, string> = {};
  for (const [k, v] of Object.entries(tags)) {
    if (k !== "example_queries") filtered[k] = v;
  }
  return Object.keys(filtered).length > 0 ? filtered : null;
}
