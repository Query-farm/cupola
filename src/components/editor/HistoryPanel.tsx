/**
 * History, in the editor's side panel. Two views of the same per-server store
 * (`query-history.ts`):
 *
 * - **This tab**: the tab's revisions (`tab-revisions.ts`), newest first:
 *   snapshots of the whole buffer taken at each run and around each Ask AI
 *   apply, Restore and Format, each shown as a diff against the one before.
 *   Restore puts a version back (undoable in the editor). This is the
 *   recovery path: the editor's own undo is gone after a reload, and one Ask
 *   AI "Replace document" can overwrite a query that worked.
 * - **All**: every query run against this server, from the editor, the shell
 *   and the AI panels, with a filter. It replaced a dropdown, which could not
 *   hold hundreds of entries.
 */
import { useMemo, useState, useSyncExternalStore } from "react";
import { Check, Copy, ExternalLink, Play, RotateCcw, Trash2, X } from "lucide-react";
import { loadTabRevisions, revisionText, subscribeTabRevisions, type RevisionKind, type TabRevision, type TabRevisions } from "@/lib/editor/tab-revisions";
import { Input } from "@/components/ui/input";
import type { QueryHistoryEntry, QuerySource } from "@/lib/shell-bridge";
import { clearQueryHistory, loadQueryHistory, removeQueryHistoryEntry, runSnapshot, subscribeQueryHistory } from "@/lib/editor/query-history";

const NO_REVISIONS: TabRevisions = { revisions: [], blobs: {} };
const KIND_LABELS: Record<RevisionKind, string> = {
  run: "Ran", ai: "Ask AI applied", restore: "Restored", format: "Formatted", edit: "Your edits",
};
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

interface Props {
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
  const q = filter.trim().toLowerCase();

  const getRevisions = () => (activeDocId ? loadTabRevisions(serviceUrl, activeDocId) : NO_REVISIONS);
  const revisions = useSyncExternalStore(subscribeTabRevisions, getRevisions, getRevisions);
  const shownTab = useMemo(
    () => (q ? revisions.revisions.filter((r) => revisionText(revisions, r).toLowerCase().includes(q)) : revisions.revisions),
    [revisions, q],
  );
  const shownAll = useMemo(() => (q ? entries.filter((e) => matches(e, q)) : entries), [entries, q]);

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
            {segment("tab", "This tab", revisions.revisions.length)}
            {segment("all", "All", entries.length)}
          </div>
          {view === "all" && entries.length > 0 && (
            <button
              type="button"
              onClick={() => { if (window.confirm(`Clear all ${entries.length} queries from history?`)) clearQueryHistory(serviceUrl); }}
              className="ml-auto flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-foreground/5 hover:text-destructive"
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
          ? <TabRevisionList shown={shownTab} value={revisions} filtered={!!q} onOpen={onOpen} onRestore={onRestore} />
          : <AllRuns entries={shownAll} total={entries.length} serviceUrl={serviceUrl} onOpen={onOpen} />}
      </div>
    </div>
  );
}

/** This tab's revisions, each compared with the one before it. */
function TabRevisionList({ shown, value, filtered, onOpen, onRestore }: {
  shown: TabRevision[];
  value: TabRevisions;
  filtered: boolean;
  onOpen: (sql: string, run: boolean) => void;
  onRestore: (sql: string) => void;
}) {
  if (shown.length === 0) {
    return (
      <p className="px-4 py-8 text-center text-xs text-muted-foreground">
        {filtered ? "No versions match." : "Versions of this tab's query are kept here: each time it runs, and before and after Ask AI, Restore or Format changes it. Each is compared with the one before."}
      </p>
    );
  }
  return (
    <ol className="divide-y divide-border" aria-label="Versions of this tab">
      {shown.map((revision) => {
        const previous = value.revisions[value.revisions.indexOf(revision) + 1];
        return (
          <TabRevisionItem
            key={revision.id}
            revision={revision}
            text={revisionText(value, revision)}
            before={previous ? revisionText(value, previous) : null}
            onOpen={onOpen}
            onRestore={onRestore}
          />
        );
      })}
    </ol>
  );
}

const PREVIEW_LINES = 12;

function RevisionOutcome({ revision }: { revision: TabRevision }) {
  const o = revision.outcome;
  if (!o) return null;
  return (
    <span className="flex min-w-0 items-center gap-2 text-[11px] tabular-nums">
      {o.success
        ? <span className="text-accent">{o.rowCount != null ? `${o.rowCount.toLocaleString()} row${o.rowCount === 1 ? "" : "s"}` : "OK"}</span>
        : <span className="truncate text-destructive">{o.error || "Failed"}</span>}
      <span className="shrink-0 text-muted-foreground">{formatDuration(o.ms)}</span>
      {(o.runs ?? 1) > 1 && <span className="shrink-0 text-muted-foreground">· ran {o.runs} times</span>}
    </span>
  );
}

function TabRevisionItem({ revision, text, before, onOpen, onRestore }: {
  revision: TabRevision;
  text: string;
  before: string | null;
  onOpen: (sql: string, run: boolean) => void;
  onRestore: (sql: string) => void;
}) {
  const diff = useMemo(() => (before === null || before === text ? null : lineDiff(before, text)), [before, text]);
  const [expanded, setExpanded] = useState(false);
  const lines = text.split("\n");
  const ranPart = revision.statement?.trim().split("\n")[0];

  return (
    <li className="group px-3 py-2.5" data-testid="editor-history-revision" data-kind={revision.kind}>
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className={`shrink-0 rounded px-1.5 py-px font-medium ${revision.kind === "ai" ? "bg-violet-500/10 text-violet-700 dark:text-violet-300" : revision.kind === "run" ? "bg-accent/10 text-accent" : "bg-foreground/5 text-foreground/70"}`}>
          {KIND_LABELS[revision.kind]}
        </span>
        <span className="tabular-nums" title={new Date(revision.at).toLocaleString()}>{formatWhen(revision.at)}</span>
        <RevisionOutcome revision={revision} />
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
      {diff ? (
        <pre className="mt-1.5 max-h-60 overflow-auto rounded bg-muted/60 p-2 font-mono text-[11px] leading-snug whitespace-pre-wrap break-words" aria-label="Changes since the version before" data-testid="editor-history-diff">
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

/** Every query run against this server. */
function AllRuns({ entries, total, serviceUrl, onOpen }: {
  entries: QueryHistoryEntry[];
  total: number;
  serviceUrl: string;
  onOpen: (sql: string, run: boolean) => void;
}) {
  const [copied, setCopied] = useState<number | null>(null);
  const copy = (entry: QueryHistoryEntry) => {
    void navigator.clipboard.writeText(entry.sql).then(() => {
      setCopied(entry.id);
      setTimeout(() => setCopied((id) => (id === entry.id ? null : id)), 1500);
    }).catch(() => { /* Clipboard denied; nothing to undo. */ });
  };
  if (entries.length === 0) {
    return (
      <p className="px-4 py-8 text-center text-xs text-muted-foreground">
        {total === 0 ? "No queries yet. Queries you run here, in the shell or through Ask AI appear here." : "No queries match."}
      </p>
    );
  }
  return (
    <ol className="divide-y divide-border" aria-label="Query history">
      {entries.map((entry, index) => {
        const conversation = entry.conversationId && entries[index - 1]?.conversationId !== entry.conversationId
          ? entry.conversationName || entry.userQuestion : null;
        return (
          <li key={entry.id} className="group relative" data-testid="editor-history-entry">
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
              <button type="button" onClick={() => removeQueryHistoryEntry(serviceUrl, entry.id)} className={`${iconButton} hover:text-destructive`} title="Remove from history" aria-label="Remove from history">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
