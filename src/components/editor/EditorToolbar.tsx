import { Play, Square, Sparkles, WandSparkles, Loader2, FileChartColumn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScriptMenu } from "./ScriptMenu";

interface Props {
  running: boolean;
  /** DuckDB booted, required extensions loaded, and the catalog attached. */
  queryReady: boolean;
  /** Human-readable boot phase shown while the engine initializes. */
  bootPhase?: string | null;
  /** True when text is selected in the editor (Run targets the selection). */
  hasSelection: boolean;
  onRun: () => void;
  onStop: () => void;
  onFormat: () => void;
  onAskAI: () => void;
  onAddToReport: () => void;
  /** Whether the Ask AI panel is currently open (renders the button pressed). */
  aiActive?: boolean;
  /** A turn is in flight in some sub-tab's conversation. The panel may be
   *  closed, so the button is the only thing left to say so. */
  aiBusy?: boolean;
  onDownloadSql: () => void;
  /** Copy a link that reopens this tab's SQL (unexecuted) against this catalog. */
  onShareLink: () => void;
  /** Renders the share row in its just-copied state. */
  shareCopied?: boolean;
}

/**
 * The editor toolbar carries EXECUTION and SCRIPT actions only.
 *
 * Result actions (save to CSV/Excel/Arrow, open in Perspective) used to live
 * here too, which made one row serve three unrelated jobs. They now sit in the
 * results pane's own header, next to the grid they act on — the arrangement
 * DBeaver and CloudBeaver both use.
 *
 * Layout, left to right:
 *
 *   [▶ Run] [✨ Ask AI]  │  Format   Script ▾
 *
 * Ask AI sits in the execute cluster with a filled background because it is a
 * primary action, not a utility. Its fill is `primary` (brown) rather than the
 * accent green Run uses: two saturated greens side by side compete for the
 * same job, and brown is already this app's "active" colour.
 */
export function EditorToolbar({
  running,
  queryReady,
  bootPhase,
  hasSelection,
  onRun,
  onStop,
  onFormat,
  onAskAI,
  onAddToReport,
  aiActive,
  aiBusy,
  onDownloadSql,
  onShareLink,
  shareCopied,
}: Props) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-card shrink-0">
      {running ? (
        <>
          <Button
            size="sm"
            variant="destructive"
            onClick={onStop}
            className="h-7 gap-1.5"
            data-testid="editor-stop"
          >
            <Square className="h-3.5 w-3.5" />
            Stop
          </Button>
          <span
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
            data-testid="editor-running"
          >
            <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
            Running…
          </span>
        </>
      ) : (
        <Button
          size="sm"
          onClick={onRun}
          disabled={!queryReady}
          className="h-7 gap-1.5 bg-accent text-white hover:bg-accent/90 shadow-sm"
          title={hasSelection ? "Run selection (⌘/Ctrl+Enter for statement)" : "Run statement at cursor (⌘/Ctrl+Enter)"}
          data-testid="editor-run"
        >
          <Play className="h-3.5 w-3.5" />
          {hasSelection ? "Run selection" : "Run"}
        </Button>
      )}

      <Button
        size="sm"
        onClick={onAskAI}
        className={
          aiActive
            ? "h-7 gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm ring-2 ring-primary/40"
            : "h-7 gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm"
        }
        title={aiBusy ? "Ask AI is working — click to show the panel" : "Toggle the Ask AI panel"}
        aria-pressed={aiActive}
        aria-busy={aiBusy || undefined}
        data-testid="editor-ask-ai"
      >
        {aiBusy
          ? <Loader2 className="h-3.5 w-3.5 animate-spin" data-testid="editor-ask-ai-busy" />
          : <Sparkles className="h-3.5 w-3.5" />}
        Ask AI
      </Button>

      <Button
        size="sm"
        variant="outline"
        onClick={onAddToReport}
        className="h-7 gap-1.5"
        title="Use the current selection or statement as the basis of a report"
        data-testid="editor-add-to-report"
      >
        <FileChartColumn className="h-3.5 w-3.5" />
        Add to report
      </Button>

      {!queryReady && !running && (
        <span
          className="flex items-center gap-1.5 text-xs text-muted-foreground"
          data-testid="editor-engine-initializing"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {bootPhase ? `${bootPhase}…` : "Initializing SQL engine…"}
        </span>
      )}

      <span className="h-5 w-px bg-border" aria-hidden="true" />

      <Button
        size="sm"
        variant="ghost"
        onClick={onFormat}
        className="h-7 gap-1.5"
        title="Format SQL"
        data-testid="editor-format"
      >
        <WandSparkles className="h-3.5 w-3.5" />
        Format
      </Button>

      <ScriptMenu
        onDownloadSql={onDownloadSql}
        onShareLink={onShareLink}
        shareCopied={shareCopied}
      />

      <div className="flex-1" />
    </div>
  );
}
