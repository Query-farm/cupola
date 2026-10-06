import { Play, Square, Sparkles, WandSparkles, Loader2, FileChartColumn, Info, History, ChevronDown, ListOrdered, Route, Radio, Database, Share2, Download, Link2, Check, Keyboard } from "lucide-react";
import { Popover as BaseUIPopover } from "@base-ui/react/popover";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import type { PerspectivePivotMode, QueryPivotMode } from "@/lib/pivot-source";
import { withShortcut } from "@/lib/keys";

interface Props {
  running: boolean;
  /** DuckDB booted, required extensions loaded, and the catalog attached. */
  queryReady: boolean;
  /** Another query tab owns the shared connection. */
  runBlocked?: boolean;
  /** True when text is selected in the editor (Run targets the selection). */
  hasSelection: boolean;
  onRun: () => void;
  /** Run every statement in the tab. */
  onRunAll: () => void;
  /** Run EXPLAIN on the statement Run would execute. */
  onExplain: () => void;
  /** Send the statement Run would execute straight to Perspective, without
   *  running it here — its result is never buffered in the editor. */
  onRunInPerspective: (mode: QueryPivotMode) => void;
  /** The Perspective mode being prepared, if any. */
  perspectiveBusy?: PerspectivePivotMode | null;
  onStop: () => void;
  onFormat: () => void;
  onAskAI: () => void;
  /** Whether the side panel is showing Ask AI (renders the button pressed). */
  aiActive?: boolean;
  /** A turn is in flight in some sub-tab's conversation. The panel may be
   *  closed, so the button is the only thing left to say so. */
  aiBusy?: boolean;
  onInspector: () => void;
  inspectorActive?: boolean;
  onHistory: () => void;
  historyActive?: boolean;
  onAddToReport: () => void;
  onDownloadSql: () => void;
  /** Copy a link that reopens this tab's SQL (unexecuted) against this catalog. */
  onShareLink: () => void;
  /** Renders the share row in its just-copied state. */
  shareCopied?: boolean;
  onShowShortcuts: () => void;
}

const RUN_KEY = "Mod-Enter";

const menuItem = "flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-foreground/5 disabled:pointer-events-none disabled:opacity-50";
const panelToggle = (active?: boolean) => `h-7 gap-1.5 ${active ? "bg-muted text-foreground" : "text-muted-foreground"}`;

/**
 * The editor toolbar is grouped by what an action does, left to right:
 *
 *   [▶ Run | ▾] [✨ Ask AI]  │  Format  Share ▾   ·········   Inspector  History
 *
 * - Run is the one primary action. Its menu holds the other ways to run the
 *   same query (all statements, EXPLAIN, Perspective), which used to be a
 *   second button as prominent as Run.
 * - Ask AI sits beside Run because it acts on the query being written.
 * - Format works on the text; Share holds everything that sends it somewhere
 *   (a link, a .sql file, a report).
 * - Inspector and History are reference panels: they open the side panel's
 *   tabs, at the edge nearest the panel.
 *
 * Result actions (pivot, save, pop out) stay in the results pane, next to the
 * grid they act on. Shortcuts are named in tooltips, in the reader's own
 * platform's terms, never on the buttons.
 */
export function EditorToolbar({
  running,
  queryReady,
  runBlocked,
  hasSelection,
  onRun,
  onRunAll,
  onExplain,
  onRunInPerspective,
  perspectiveBusy,
  onStop,
  onFormat,
  onAskAI,
  aiActive,
  aiBusy,
  onInspector,
  inspectorActive,
  onHistory,
  historyActive,
  onAddToReport,
  onDownloadSql,
  onShareLink,
  shareCopied,
  onShowShortcuts,
}: Props) {
  const canRun = queryReady && !running && !runBlocked;
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-card shrink-0">
      {running ? (
        <>
          <Button size="sm" variant="destructive" onClick={onStop} className="h-7 gap-1.5" data-testid="editor-stop">
            <Square className="h-3.5 w-3.5" />
            Stop
          </Button>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="editor-running">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
            Running…
          </span>
        </>
      ) : (
        // One shape: the container owns the colour and the rounding, and the two
        // halves are borderless. The shared Button paints inside a transparent
        // border, which left a ring of toolbar showing around each half.
        <div className={`inline-flex h-7 items-stretch overflow-hidden rounded-lg bg-accent text-white shadow-sm ${canRun ? "" : "opacity-50"}`}>
          <button
            type="button"
            onClick={onRun}
            disabled={!canRun}
            className="inline-flex items-center gap-1.5 px-3 text-sm font-medium hover:bg-black/10 focus-visible:bg-black/10 focus-visible:outline-none disabled:pointer-events-none"
            title={runBlocked ? "Another query tab is running" : withShortcut(hasSelection ? "Run the selected SQL" : "Run the statement at the cursor", RUN_KEY)}
            data-testid="editor-run"
          >
            <Play className="h-3.5 w-3.5" />
            {hasSelection ? "Run selection" : "Run"}
          </button>
          <span className="my-1.5 w-px bg-white/35" aria-hidden="true" />
          <Popover>
            <PopoverTrigger
              disabled={!canRun}
              className="inline-flex items-center px-1.5 hover:bg-black/10 focus-visible:bg-black/10 focus-visible:outline-none disabled:pointer-events-none"
              title={perspectiveBusy ? "Preparing Perspective…" : "More ways to run"}
              aria-label="More ways to run"
              data-testid="editor-run-menu"
            >
              {perspectiveBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72 p-1">
              <BaseUIPopover.Close onClick={onRunAll} className={menuItem} data-testid="editor-run-all">
                <ListOrdered className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span><span className="block font-medium">Run all statements</span><span className="block text-muted-foreground">Everything in this tab, in order.</span></span>
              </BaseUIPopover.Close>
              <BaseUIPopover.Close onClick={onExplain} className={menuItem} data-testid="editor-explain">
                <Route className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span><span className="block font-medium">Explain</span><span className="block text-muted-foreground">Show DuckDB's plan for {hasSelection ? "the selection" : "the statement at the cursor"}.</span></span>
              </BaseUIPopover.Close>
              <div className="my-1 border-t border-border" />
              <div className="px-2 pb-0.5 pt-1 text-[11px] font-medium text-muted-foreground">Run in Perspective, without loading the result here</div>
              <BaseUIPopover.Close onClick={() => onRunInPerspective("view")} className={menuItem} data-testid="editor-run-perspective-view">
                <Radio className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span><span className="block font-medium">Live view</span><span className="block text-muted-foreground">Perspective queries DuckDB as you pivot. Nothing is copied.</span></span>
              </BaseUIPopover.Close>
              <BaseUIPopover.Close onClick={() => onRunInPerspective("table")} className={menuItem} data-testid="editor-run-perspective-table">
                <Database className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span><span className="block font-medium">Table</span><span className="block text-muted-foreground">Runs the query once into a temp table, then pivots against it.</span></span>
              </BaseUIPopover.Close>
            </PopoverContent>
          </Popover>
        </div>
      )}

      <Button
        size="sm"
        onClick={onAskAI}
        className={`h-7 gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm ${aiActive ? "ring-2 ring-primary/40" : ""}`}
        title={aiBusy ? "Ask AI is working — click to show it" : "Ask AI to write, explain or fix this query"}
        aria-pressed={!!aiActive}
        aria-busy={aiBusy || undefined}
        data-testid="editor-ask-ai"
      >
        {aiBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" data-testid="editor-ask-ai-busy" /> : <Sparkles className="h-3.5 w-3.5" />}
        Ask AI
      </Button>

      <span className="h-5 w-px bg-border" aria-hidden="true" />

      <Button size="sm" variant="ghost" onClick={onFormat} className="h-7 gap-1.5" title="Format this tab's SQL" data-testid="editor-format">
        <WandSparkles className="h-3.5 w-3.5" />
        <span className="hidden md:inline">Format</span>
      </Button>

      <Popover>
        <PopoverTrigger
          className="flex h-7 items-center gap-1.5 rounded px-2 text-xs hover:bg-foreground/5"
          title="Share this query: a link, a .sql file, or a report"
          data-testid="editor-share-menu"
        >
          <Share2 className="h-3.5 w-3.5" />
          <span className="hidden md:inline">Share</span>
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-60 p-1">
          <BaseUIPopover.Close onClick={onShareLink} className={menuItem} data-testid="editor-share-link">
            {shareCopied ? <Check className="h-3.5 w-3.5 text-accent" /> : <Link2 className="h-3.5 w-3.5" />}
            <span>{shareCopied ? "Link copied" : "Copy link to this query"}</span>
          </BaseUIPopover.Close>
          <BaseUIPopover.Close onClick={onDownloadSql} className={menuItem} data-testid="editor-download-sql">
            <Download className="h-3.5 w-3.5" />
            <span>Download .sql</span>
          </BaseUIPopover.Close>
          <BaseUIPopover.Close onClick={onAddToReport} className={menuItem} title="Start a report from the selection or the statement at the cursor" data-testid="editor-add-to-report">
            <FileChartColumn className="h-3.5 w-3.5" />
            <span>Add to report</span>
          </BaseUIPopover.Close>
          <div className="my-1 border-t border-border" />
          <BaseUIPopover.Close onClick={onShowShortcuts} className={menuItem} data-testid="editor-shortcuts">
            <Keyboard className="h-3.5 w-3.5" />
            <span>Keyboard shortcuts</span>
          </BaseUIPopover.Close>
        </PopoverContent>
      </Popover>

      <div className="flex-1" />

      <Button
        size="sm"
        variant="ghost"
        onClick={onInspector}
        className={panelToggle(inspectorActive)}
        title="Details of what you pick in the sidebar"
        aria-pressed={!!inspectorActive}
        data-testid="editor-inspector-toggle"
      >
        <Info className="h-3.5 w-3.5" />
        <span className="hidden lg:inline">Inspector</span>
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={onHistory}
        className={panelToggle(historyActive)}
        title="This tab's earlier runs, and every query run against this server"
        aria-pressed={!!historyActive}
        data-testid="editor-history"
      >
        <History className="h-3.5 w-3.5" />
        <span className="hidden lg:inline">History</span>
      </Button>
    </div>
  );
}
