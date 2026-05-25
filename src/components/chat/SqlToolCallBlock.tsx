import { useState } from "react";
import { ChevronRight, Database, Copy, AlertCircle, Loader2, X } from "lucide-react";
import { SqlCodeBlock } from "../content/SqlCodeBlock";
import { QueryResultTable } from "./QueryResultTable";
import type { ToolCallEntry } from "./ChatMessageAssistant";

interface Props {
  toolCall: ToolCallEntry;
  /** Called when the user clicks the inline cancel button while the
   *  query is executing. Aborts the agent + cancels the in-flight DuckDB
   *  query via bridge.cancelQuery. */
  onCancel?: () => void;
}

export function SqlToolCallBlock({ toolCall, onCancel }: Props) {
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
      <div className="w-full flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
        <button
          className="flex items-center gap-2 flex-1 min-w-0 text-left hover:text-foreground transition-colors"
          onClick={() => setExpanded(!expanded)}
        >
          {toolCall.isExecuting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary shrink-0" />
          ) : isError ? (
            <AlertCircle className="h-3.5 w-3.5 text-destructive" />
          ) : (
            <Database className="h-3.5 w-3.5 text-primary/60" />
          )}
          <span className={`flex-1 truncate ${isError ? "text-destructive" : ""}`}>{summary}</span>
        </button>
        {toolCall.isExecuting && toolCall.progress != null && toolCall.progress > 0 && (
          <div className="w-20 h-1.5 bg-muted rounded-full overflow-hidden shrink-0">
            <div className="h-full bg-primary rounded-full transition-all duration-300" style={{ width: `${toolCall.progress}%` }} />
          </div>
        )}
        {toolCall.isExecuting && onCancel && (
          <button
            onClick={(e) => { e.stopPropagation(); onCancel(); }}
            className="shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-destructive bg-destructive/10 hover:bg-destructive/20 transition-colors"
            title="Cancel this query (Escape)"
          >
            <X className="h-3 w-3" />
            Cancel
          </button>
        )}
        <button
          className="shrink-0 hover:text-foreground transition-colors"
          onClick={() => setExpanded(!expanded)}
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          <ChevronRight className={`h-3 w-3 transition-transform ${expanded ? "rotate-90" : ""}`} />
        </button>
      </div>

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
