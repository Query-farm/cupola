/**
 * "History" — every query run against this server, from any surface (this
 * editor, the shell, the AI panels), newest first. Kept in localStorage per
 * server (`query-history.ts`), so it outlives the page.
 *
 * Choosing an entry opens it in a new editor tab without running it; Run
 * opens it and runs it there. This replaced a top-level Query History tab
 * whose Re-run always went to the shell, wherever the query came from.
 */
import { useMemo, useState, useSyncExternalStore } from "react";
import { Check, Copy, History, Play, Trash2, X } from "lucide-react";
import { Popover as BaseUIPopover } from "@base-ui/react/popover";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import type { QueryHistoryEntry, QuerySource } from "@/lib/shell-bridge";
import { clearQueryHistory, loadQueryHistory, removeQueryHistoryEntry, subscribeQueryHistory } from "@/lib/editor/query-history";

interface Props {
  serviceUrl: string;
  /** Open the SQL in a new editor tab; `run` also executes it. */
  onOpen: (sql: string, run: boolean) => void;
}

const SOURCE_LABELS: Record<QuerySource, string> = {
  editor: "Editor", shell: "Shell", "ask-ai": "Ask AI", "editor-ai": "Editor AI", "shell-ai": "Shell AI",
};
const isAi = (entry: QueryHistoryEntry) => entry.source ? entry.source.endsWith("ai") : !!(entry.conversationId || entry.userQuestion);
const sourceLabel = (entry: QueryHistoryEntry) => entry.source ? SOURCE_LABELS[entry.source] : isAi(entry) ? "AI" : "SQL";

export function formatWhen(timestamp: number, now = Date.now()): string {
  const seconds = Math.round((now - timestamp) / 1000);
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min ago`;
  const date = new Date(timestamp);
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return time;
  const yesterday = new Date(now - 86_400_000);
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }) })} ${time}`;
}
const formatDuration = (ms: number) => ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;

export function QueryHistoryMenu({ serviceUrl, onOpen }: Props) {
  const entries = useSyncExternalStore(subscribeQueryHistory, () => loadQueryHistory(serviceUrl), () => loadQueryHistory(serviceUrl));
  const [filter, setFilter] = useState("");
  const [copied, setCopied] = useState<number | null>(null);
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? entries.filter((entry) => entry.sql.toLowerCase().includes(q) || entry.userQuestion?.toLowerCase().includes(q) || entry.conversationName?.toLowerCase().includes(q)) : entries;
  }, [entries, filter]);
  const copy = (entry: QueryHistoryEntry) => {
    void navigator.clipboard.writeText(entry.sql).then(() => {
      setCopied(entry.id);
      setTimeout(() => setCopied((id) => id === entry.id ? null : id), 1500);
    }).catch(() => { /* Clipboard denied; nothing to undo. */ });
  };

  return (
    <Popover onOpenChange={(open) => { if (!open) setFilter(""); }}>
      <PopoverTrigger
        className="flex items-center gap-1.5 h-7 px-2 text-xs rounded hover:bg-foreground/5 transition-colors"
        title="Queries run against this server, from the editor, the shell and the AI panels"
        data-testid="editor-history"
      >
        <History className="h-3.5 w-3.5" />
        <span>History</span>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(560px,calc(100vw-2rem))] p-0" data-testid="editor-history-panel">
        <div className="flex items-center gap-2 border-b border-border p-2">
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter by SQL or question"
            aria-label="Filter query history"
            className="h-7 text-xs"
            autoFocus
          />
          {entries.length > 0 && (
            <button
              type="button"
              onClick={() => { if (window.confirm(`Clear all ${entries.length} queries from history?`)) clearQueryHistory(serviceUrl); }}
              className="flex shrink-0 items-center gap-1 h-7 px-2 text-xs rounded text-muted-foreground hover:text-destructive hover:bg-foreground/5"
              data-testid="editor-history-clear"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Clear
            </button>
          )}
        </div>
        {shown.length === 0 ? (
          <p className="px-4 py-8 text-center text-xs text-muted-foreground">
            {entries.length === 0 ? "No queries yet. Queries you run here, in the shell or through Ask AI appear here." : "No queries match."}
          </p>
        ) : (
          <ol className="max-h-[60vh] overflow-y-auto divide-y divide-border" aria-label="Query history">
            {shown.map((entry, index) => {
              const conversation = entry.conversationId && shown[index - 1]?.conversationId !== entry.conversationId
                ? entry.conversationName || entry.userQuestion : null;
              return (
                <li key={entry.id} className="group relative" data-testid="editor-history-entry">
                  {conversation && <div className="px-3 pt-2 text-[11px] font-medium text-violet-600 dark:text-violet-400 truncate">AI conversation: {conversation}</div>}
                  <BaseUIPopover.Close
                    onClick={() => onOpen(entry.sql, false)}
                    className="block w-full px-3 py-2 text-left hover:bg-foreground/5 focus-visible:bg-foreground/5 focus-visible:outline-none"
                    title="Open in a new tab"
                    data-testid="editor-history-open"
                  >
                    <div className="flex items-center gap-2 pr-20 text-[11px] text-muted-foreground">
                      <span className={`shrink-0 rounded px-1.5 py-px font-medium ${isAi(entry) ? "bg-violet-500/10 text-violet-700 dark:text-violet-300" : "bg-foreground/5 text-foreground/70"}`}>{sourceLabel(entry)}</span>
                      {entry.userQuestion && !entry.conversationId && <span className="truncate italic">&ldquo;{entry.userQuestion}&rdquo;</span>}
                      <span className="ml-auto shrink-0 tabular-nums" title={new Date(entry.timestamp).toLocaleString()}>{formatWhen(entry.timestamp)}</span>
                    </div>
                    <pre className="mt-1 line-clamp-3 whitespace-pre-wrap break-all font-mono text-xs text-foreground">{entry.sql.trim()}</pre>
                    <div className="mt-1 flex items-center gap-2 text-[11px] tabular-nums">
                      {entry.success
                        ? <span className="text-accent">{entry.rowCount != null ? `${entry.rowCount.toLocaleString()} row${entry.rowCount === 1 ? "" : "s"}` : "OK"}</span>
                        : <span className="truncate text-destructive">{entry.error || "Failed"}</span>}
                      <span className="shrink-0 text-muted-foreground">{formatDuration(entry.executionTimeMs)}</span>
                      {(entry.runs ?? 1) > 1 && <span className="shrink-0 text-muted-foreground">· ran {entry.runs} times</span>}
                    </div>
                  </BaseUIPopover.Close>
                  <div className="absolute right-2 top-1.5 flex items-center gap-0.5 rounded bg-popover opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                    <BaseUIPopover.Close
                      onClick={() => onOpen(entry.sql, true)}
                      className="p-1 rounded text-muted-foreground hover:text-accent hover:bg-foreground/5"
                      title="Open in a new tab and run"
                      aria-label="Open in a new tab and run"
                      data-testid="editor-history-run"
                    >
                      <Play className="h-3.5 w-3.5" />
                    </BaseUIPopover.Close>
                    <button type="button" onClick={() => copy(entry)} className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-foreground/5" title="Copy SQL" aria-label="Copy SQL">
                      {copied === entry.id ? <Check className="h-3.5 w-3.5 text-accent" /> : <Copy className="h-3.5 w-3.5" />}
                    </button>
                    <button type="button" onClick={() => removeQueryHistoryEntry(serviceUrl, entry.id)} className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-foreground/5" title="Remove from history" aria-label="Remove from history">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </PopoverContent>
    </Popover>
  );
}
