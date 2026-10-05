/**
 * History, in the editor's side panel. Two views of the same per-workspace
 * store (`query-history.ts`; per service URL outside a workspace):
 *
 * - **This tab**: the runs of the current query, newest first, each shown as
 *   a diff against the run before it. Restore puts that version back in the
 *   tab (undoable in the editor). This is the recovery path: the editor's own
 *   undo is gone after a reload, and one Ask AI "Replace document" can
 *   overwrite a query that worked.
 * - **All**: every query run in this workspace, from the editor, the shell
 *   and the AI panels, with a filter. It replaced a dropdown, which could not
 *   hold hundreds of entries. **All workspaces** widens it to every
 *   workspace this browser knows (`loadAllQueryHistories`), each entry
 *   labelled with its workspace.
 */
import { useMemo, useState, useSyncExternalStore } from "react";
import { Check, Copy, ExternalLink, Play, RotateCcw, Trash2, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import type { QueryHistoryEntry, QuerySource } from "@/lib/shell-bridge";
import { listWorkspaces, workspaceLabel } from "@/lib/workspace/store";
import { clearQueryHistory, loadAllQueryHistories, loadQueryHistory, removeQueryHistoryEntry, runSnapshot, subscribeQueryHistory } from "@/lib/editor/query-history";
import { diffWithContext, lineDiff } from "@/lib/line-diff";
import { keyLabel } from "@/lib/keys";

type View = "tab" | "all";
const VIEW_KEY = "cupola.editor-history-view";

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

const matches = (entry: QueryHistoryEntry, q: string) =>
  runSnapshot(entry).toLowerCase().includes(q) || entry.sql.toLowerCase().includes(q)
  || !!entry.userQuestion?.toLowerCase().includes(q) || !!entry.conversationName?.toLowerCase().includes(q);

/** An "All" row: the entry, the store it lives in, and its workspace's name
 *  when the list spans every workspace. */
interface Row { scope: string; entry: QueryHistoryEntry; label: string | null }

interface Props {
  /** The workspace whose history this is (a service URL outside a workspace). */
  serviceUrl: string;
  /** The editor tab whose runs "This tab" shows. */
  activeDocId: string | null;
  /** Open SQL in a new editor tab; `run` also executes it. */
  onOpen: (sql: string, run: boolean) => void;
  /** Replace the current tab's text with an earlier version. */
  onRestore: (sql: string) => void;
}

function Outcome({ entry }: { entry: QueryHistoryEntry }) {
  return (
    <span className="flex min-w-0 items-center gap-2 text-[11px] tabular-nums">
      {entry.success
        ? <span className="text-accent">{entry.rowCount != null ? `${entry.rowCount.toLocaleString()} row${entry.rowCount === 1 ? "" : "s"}` : "OK"}</span>
        : <span className="truncate text-destructive">{entry.error || "Failed"}</span>}
      <span className="shrink-0 text-muted-foreground">{formatDuration(entry.executionTimeMs)}</span>
      {(entry.runs ?? 1) > 1 && <span className="shrink-0 text-muted-foreground">· ran {entry.runs} times</span>}
    </span>
  );
}

const iconButton = "p-1 rounded text-muted-foreground hover:bg-foreground/5";

export function HistoryPanel({ serviceUrl, activeDocId, onOpen, onRestore }: Props) {
  const entries = useSyncExternalStore(subscribeQueryHistory, () => loadQueryHistory(serviceUrl), () => loadQueryHistory(serviceUrl));
  const [view, setView] = useState<View>(() => {
    try { return localStorage.getItem(VIEW_KEY) === "all" ? "all" : "tab"; } catch { return "tab"; }
  });
  const choose = (v: View) => { setView(v); try { localStorage.setItem(VIEW_KEY, v); } catch {} };
  const [filter, setFilter] = useState("");
  const [allWorkspaces, setAllWorkspaces] = useState(false);
  const q = filter.trim().toLowerCase();

  // Every workspace's list, read only while that view is showing.
  const rows = useMemo<Row[]>(() => {
    if (view !== "all" || !allWorkspaces) return entries.map((entry) => ({ scope: serviceUrl, entry, label: null }));
    const known = new Map(listWorkspaces().map((w) => [w.id, workspaceLabel(w)]));
    known.set(serviceUrl, known.get(serviceUrl) ?? "This workspace");
    return loadAllQueryHistories((scope) => known.has(scope)).map(({ scope, entry }) => ({
      scope, entry, label: scope === serviceUrl ? `${known.get(scope)} (this one)` : known.get(scope)!,
    }));
  }, [view, allWorkspaces, entries, serviceUrl]);

  const tabRuns = useMemo(() => entries.filter((e) => activeDocId && e.docId === activeDocId), [entries, activeDocId]);
  const shownTab = useMemo(() => (q ? tabRuns.filter((e) => matches(e, q)) : tabRuns), [tabRuns, q]);
  const shownAll = useMemo(() => (q ? rows.filter((r) => matches(r.entry, q) || !!r.label?.toLowerCase().includes(q)) : rows), [rows, q]);

  const segment = (v: View, label: string, count: number) => (
    <button
      role="tab"
      aria-selected={view === v}
      onClick={() => choose(v)}
      className={`rounded px-2 py-0.5 text-xs ${view === v ? "bg-background font-medium text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"}`}
      data-testid={`editor-history-view-${v}`}
    >
      {label} <span className="tabular-nums text-muted-foreground">{count}</span>
    </button>
  );

  return (
    <div className="flex h-full flex-col bg-background" data-testid="editor-history-panel">
      <div className="flex flex-col gap-2 border-b border-border p-2">
        <div className="flex items-center gap-2">
          <div role="tablist" aria-label="History view" className="flex rounded-md bg-muted p-0.5">
            {segment("tab", "This tab", tabRuns.length)}
            {segment("all", "All", entries.length)}
          </div>
          {view === "all" && (
            <label className="ml-auto flex shrink-0 cursor-pointer select-none items-center gap-1 text-xs text-muted-foreground" title="List the queries of every workspace in this browser">
              <input type="checkbox" checked={allWorkspaces} onChange={(e) => setAllWorkspaces(e.target.checked)} data-testid="editor-history-all" />
              All workspaces
            </label>
          )}
          {view === "all" && !allWorkspaces && entries.length > 0 && (
            <button
              type="button"
              onClick={() => { if (window.confirm(`Clear all ${entries.length} queries from history?`)) clearQueryHistory(serviceUrl); }}
              className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-foreground/5 hover:text-destructive"
              data-testid="editor-history-clear"
            >
              <Trash2 className="h-3.5 w-3.5" /> Clear
            </button>
          )}
        </div>
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by SQL or question" aria-label="Filter query history" className="h-7 text-xs" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {view === "tab"
          ? <TabRuns runs={shownTab} all={tabRuns} filtered={!!q} onOpen={onOpen} onRestore={onRestore} />
          : <AllRuns rows={shownAll} total={rows.length} onOpen={onOpen} />}
      </div>
    </div>
  );
}

/** Each run of this tab, compared with the run before it. */
function TabRuns({ runs, all, filtered, onOpen, onRestore }: {
  runs: QueryHistoryEntry[];
  all: QueryHistoryEntry[];
  filtered: boolean;
  onOpen: (sql: string, run: boolean) => void;
  onRestore: (sql: string) => void;
}) {
  if (runs.length === 0) {
    return (
      <p className="px-4 py-8 text-center text-xs text-muted-foreground">
        {filtered ? "No runs match." : "Each time you run this tab's query, the version that ran is kept here, compared with the one before."}
      </p>
    );
  }
  return (
    <ol className="divide-y divide-border" aria-label="Runs of this tab">
      {runs.map((entry) => {
        const previous = all[all.indexOf(entry) + 1];
        return <TabRun key={entry.id} entry={entry} previous={previous} onOpen={onOpen} onRestore={onRestore} />;
      })}
    </ol>
  );
}

const PREVIEW_LINES = 12;

function TabRun({ entry, previous, onOpen, onRestore }: {
  entry: QueryHistoryEntry;
  previous?: QueryHistoryEntry;
  onOpen: (sql: string, run: boolean) => void;
  onRestore: (sql: string) => void;
}) {
  const text = runSnapshot(entry);
  const before = previous ? runSnapshot(previous) : null;
  const diff = useMemo(() => (before === null || before === text ? null : lineDiff(before, text)), [before, text]);
  const [expanded, setExpanded] = useState(false);
  const lines = text.split("\n");
  const ranPart = entry.docSql !== undefined && entry.sql.trim() !== text.trim() ? entry.sql.trim().split("\n")[0] : null;

  return (
    <li className="group px-3 py-2.5" data-testid="editor-history-run-entry">
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="tabular-nums" title={new Date(entry.timestamp).toLocaleString()}>{formatWhen(entry.timestamp)}</span>
        <Outcome entry={entry} />
        <span className="ml-auto flex items-center gap-0.5">
          <button
            className={`${iconButton} hover:text-foreground`}
            onClick={() => onRestore(text)}
            title={`Put this version back in the tab (undo with ${keyLabel("Mod-z")})`}
            aria-label="Restore this version"
            data-testid="editor-history-restore"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
          <button className={`${iconButton} hover:text-foreground`} onClick={() => onOpen(text, false)} title="Open in a new tab" aria-label="Open in a new tab">
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
        </span>
      </div>
      {ranPart && <div className="mt-1 truncate text-[11px] text-muted-foreground">Ran <code className="font-mono">{ranPart}</code></div>}
      {before !== null && before === text ? (
        <p className="mt-1 text-[11px] italic text-muted-foreground">Same text as the run before.</p>
      ) : diff ? (
        <pre className="mt-1.5 max-h-60 overflow-auto rounded bg-muted/60 p-2 font-mono text-[11px] leading-snug whitespace-pre-wrap break-words" aria-label="Changes since the run before" data-testid="editor-history-diff">
          {diffWithContext(diff, 1).map((line, i) => line === null
            ? <div key={i} className="text-muted-foreground">⋯</div>
            : <div key={i} className={line.kind === "added" ? "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300" : line.kind === "removed" ? "bg-red-500/15 text-red-800 dark:text-red-300 line-through decoration-red-500/40" : ""}>
                <span aria-hidden className="select-none text-muted-foreground">{line.kind === "added" ? "+ " : line.kind === "removed" ? "- " : "  "}</span>{line.text || " "}
              </div>)}
        </pre>
      ) : (
        <>
          <pre className="mt-1.5 overflow-auto rounded bg-muted/60 p-2 font-mono text-[11px] leading-snug whitespace-pre-wrap break-words">
            {expanded ? text : lines.slice(0, PREVIEW_LINES).join("\n")}
          </pre>
          {lines.length > PREVIEW_LINES && (
            <button className="mt-1 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setExpanded((x) => !x)}>
              {expanded ? "Show less" : `Show all ${lines.length} lines`}
            </button>
          )}
        </>
      )}
    </li>
  );
}

/** Every query run in this workspace, or in every workspace. */
function AllRuns({ rows, total, onOpen }: {
  rows: Row[];
  total: number;
  onOpen: (sql: string, run: boolean) => void;
}) {
  const [copied, setCopied] = useState<number | null>(null);
  const copy = (entry: QueryHistoryEntry) => {
    void navigator.clipboard.writeText(entry.sql).then(() => {
      setCopied(entry.id);
      setTimeout(() => setCopied((id) => (id === entry.id ? null : id)), 1500);
    }).catch(() => { /* Clipboard denied; nothing to undo. */ });
  };
  if (rows.length === 0) {
    return (
      <p className="px-4 py-8 text-center text-xs text-muted-foreground">
        {total === 0 ? "No queries yet. Queries you run here, in the shell or through Ask AI appear here." : "No queries match."}
      </p>
    );
  }
  return (
    <ol className="divide-y divide-border" aria-label="Query history">
      {rows.map(({ scope, entry, label }, index) => {
        const conversation = entry.conversationId && rows[index - 1]?.entry.conversationId !== entry.conversationId
          ? entry.conversationName || entry.userQuestion : null;
        return (
          <li key={`${scope}:${entry.id}`} className="group relative" data-testid="editor-history-entry" data-workspace={label ?? undefined}>
            {label && <div className="px-3 pt-2 text-[11px] font-medium text-muted-foreground truncate" data-testid="editor-history-workspace">{label}</div>}
            {conversation && <div className="px-3 pt-2 text-[11px] font-medium text-violet-600 dark:text-violet-400 truncate">AI conversation: {conversation}</div>}
            <button
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
              <div className="mt-1"><Outcome entry={entry} /></div>
            </button>
            <div className="absolute right-2 top-1.5 flex items-center gap-0.5 rounded bg-background opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
              <button onClick={() => onOpen(entry.sql, true)} className={`${iconButton} hover:text-accent`} title="Open in a new tab and run" aria-label="Open in a new tab and run" data-testid="editor-history-run">
                <Play className="h-3.5 w-3.5" />
              </button>
              <button type="button" onClick={() => copy(entry)} className={`${iconButton} hover:text-foreground`} title="Copy SQL" aria-label="Copy SQL">
                {copied === entry.id ? <Check className="h-3.5 w-3.5 text-accent" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
              <button type="button" onClick={() => removeQueryHistoryEntry(scope, entry.id)} className={`${iconButton} hover:text-destructive`} title="Remove from history" aria-label="Remove from history">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
