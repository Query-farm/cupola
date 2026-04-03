import { useState } from "react";
import { Copy, Play, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SqlCodeBlock } from "./SqlCodeBlock";
import * as Accordion from "@radix-ui/react-accordion";
import { bridge } from "@/lib/shell-bridge";

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

function QueryBlock({ query, index, onOpenShell }: { query: ExampleQuery; index: number; onOpenShell?: () => void }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(query.sql);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleRun = () => {
    bridge.activateShell?.();
    setTimeout(() => {
      bridge.runQuery?.(query.sql);
    }, 150);
  };

  return (
    <div className="flex items-start gap-2 bg-muted/60 rounded-md px-3 py-2">
      <div className="flex-1 min-w-0">
        <SqlCodeBlock query={query.sql} />
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleCopy}
          className="h-6 px-2 text-xs"
        >
          <Copy className="h-3 w-3" />
          <span className="ml-1">{copied ? "Copied" : "Copy"}</span>
        </Button>
        {onOpenShell && (
          <Button
            variant="default"
            size="sm"
            onClick={handleRun}
            className="h-6 px-2 text-xs gap-1"
          >
            <Play className="h-3 w-3" />
            Run
          </Button>
        )}
      </div>
    </div>
  );
}

export function ExampleQueries({ exampleQueriesJson, defaultSql, onOpenShell }: Props) {
  const queries: ExampleQuery[] =
    (exampleQueriesJson ? parseExampleQueries(exampleQueriesJson) : null)
    || (defaultSql ? [{ sql: defaultSql }] : []);

  if (queries.length === 0) return null;

  return (
    <>
      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mt-6 mb-2">
        {queries.length === 1 ? "Example Query" : "Example Queries"}
        {queries.length > 1 && <span className="ml-2 text-xs font-normal text-muted-foreground/60">({queries.length})</span>}
      </h2>
      <Accordion.Root type="multiple" className="mb-6">
        {queries.map((q, i) => {
          const title = q.name || q.description || `Query ${i + 1}`;
          const subtitle = q.name && q.description ? q.description : null;
          return (
            <Accordion.Item
              key={i}
              value={`q-${i}`}
              className="border border-border rounded-lg mb-2 overflow-hidden bg-card"
            >
              <Accordion.Trigger className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-muted/40 transition-colors group cursor-pointer">
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50 transition-transform group-data-[state=open]:rotate-90 shrink-0" />
                <div className="flex-1 min-w-0">
                  <span className="font-medium text-foreground/80">{title}</span>
                  {subtitle && (
                    <span className="ml-2 text-xs text-muted-foreground">{subtitle}</span>
                  )}
                </div>
              </Accordion.Trigger>
              <Accordion.Content className="overflow-hidden data-[state=open]:animate-accordion-down data-[state=closed]:animate-accordion-up">
                <div className="px-3 pb-3 pt-1">
                  <QueryBlock query={q} index={i} onOpenShell={onOpenShell} />
                </div>
              </Accordion.Content>
            </Accordion.Item>
          );
        })}
      </Accordion.Root>
    </>
  );
}

// Re-export for backward compatibility — consumers should migrate to filterDisplayTags
export { filterDisplayTags as filterExampleQueriesTag } from "@/lib/tags";
