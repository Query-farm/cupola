import { useState } from "react";
import { ChevronRight, Database, Copy, AlertCircle, Loader2 } from "lucide-react";
import { SqlCodeBlock } from "../content/SqlCodeBlock";
import { QueryResultTable } from "./QueryResultTable";
import type { ToolCallEntry } from "./ChatMessageAssistant";

interface Props {
  toolCall: ToolCallEntry;
}

export function SqlToolCallBlock({ toolCall }: Props) {
  const [expanded, setExpanded] = useState(false);

  const dr = toolCall.displayResult;
  const isError = !!toolCall.error;

  const summary = toolCall.isExecuting
    ? "Running query..."
    : isError
    ? "Query failed"
    : dr?.message
    ? dr.message
    : dr && dr.rowCount > 0
    ? `${dr.rowCount.toLocaleString()} row${dr.rowCount !== 1 ? "s" : ""} returned`
    : "Query completed";

  return (
    <div className="border border-border rounded-lg overflow-hidden bg-card">
      {/* Summary bar */}
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:bg-muted/40 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {toolCall.isExecuting ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary shrink-0" />
        ) : isError ? (
          <AlertCircle className="h-3.5 w-3.5 text-destructive" />
        ) : (
          <Database className="h-3.5 w-3.5 text-primary/60" />
        )}
        <span className={`flex-1 ${isError ? "text-destructive" : ""}`}>{summary}</span>
        {toolCall.isExecuting && toolCall.progress != null && toolCall.progress > 0 && (
          <div className="w-20 h-1.5 bg-muted rounded-full overflow-hidden shrink-0">
            <div className="h-full bg-primary rounded-full transition-all duration-300" style={{ width: `${toolCall.progress}%` }} />
          </div>
        )}
        <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`} />
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-border px-3 py-3 space-y-3">
          {/* SQL */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">SQL Query</span>
              <button
                className="text-muted-foreground/50 hover:text-primary transition-colors p-0.5"
                title="Copy SQL"
                onClick={() => navigator.clipboard.writeText(toolCall.input?.sql || "")}
              >
                <Copy className="h-3 w-3" />
              </button>
            </div>
            <div className="bg-muted/60 rounded-md px-3 py-2">
              <SqlCodeBlock query={toolCall.input?.sql || ""} />
            </div>
          </div>

          {/* Error */}
          {isError && (
            <div className="text-xs text-destructive bg-destructive/5 rounded-md px-3 py-2">
              {toolCall.error}
            </div>
          )}

          {/* Results table */}
          {dr && dr.rows.length > 0 && (
            <div>
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Results</span>
              <div className="mt-1">
                <QueryResultTable
                  columns={dr.columns}
                  rows={dr.rows}
                  rowCount={dr.rowCount}
                  showing={dr.showing}
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
