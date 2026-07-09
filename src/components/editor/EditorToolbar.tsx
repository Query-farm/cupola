import { Play, Square, Sparkles, WandSparkles, TerminalSquare, Download, Loader2, Link2, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ExportMenu } from "./ExportMenu";
import type { ExportFormat } from "@/lib/editor/result-export";

interface Props {
  running: boolean;
  /** bridge.query is available (DuckDB booted). */
  queryReady: boolean;
  /** Human-readable boot phase shown while the engine initializes. */
  bootPhase?: string | null;
  hasResult: boolean;
  /** True when text is selected in the editor (Run targets the selection). */
  hasSelection: boolean;
  onRun: () => void;
  onStop: () => void;
  onFormat: () => void;
  onExport: (format: ExportFormat) => void | Promise<void>;
  onOpenInPerspective: () => void;
  onOpenInShell: () => void;
  onAskAI: () => void;
  /** Whether the Ask AI panel is currently open (renders the button pressed). */
  aiActive?: boolean;
  onDownloadSql: () => void;
  /** Copy a link that reopens this tab's SQL (unexecuted) against this catalog. */
  onShareLink: () => void;
  /** Renders the share button in its just-copied state. */
  shareCopied?: boolean;
}

export function EditorToolbar({
  running,
  queryReady,
  bootPhase,
  hasResult,
  hasSelection,
  onRun,
  onStop,
  onFormat,
  onExport,
  onOpenInPerspective,
  onOpenInShell,
  onAskAI,
  aiActive,
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

      <ExportMenu
        onExport={onExport}
        onOpenInPerspective={onOpenInPerspective}
        disabled={!hasResult}
      />

      <Button
        size="sm"
        variant="ghost"
        onClick={onDownloadSql}
        className="h-7 gap-1.5"
        title="Download this tab's SQL as a .sql file"
        data-testid="editor-download-sql"
      >
        <Download className="h-3.5 w-3.5" />
        .sql
      </Button>

      <Button
        size="sm"
        variant="ghost"
        onClick={onShareLink}
        className="h-7 gap-1.5"
        title="Copy a link that opens this SQL in a new editor tab"
        data-testid="editor-share-link"
      >
        {shareCopied ? <Check className="h-3.5 w-3.5 text-accent" /> : <Link2 className="h-3.5 w-3.5" />}
        {shareCopied ? "Copied" : "Share"}
      </Button>

      <div className="flex-1" />

      <Button
        size="sm"
        variant={aiActive ? "default" : "ghost"}
        onClick={onAskAI}
        className="h-7 gap-1.5"
        title="Toggle the Ask AI panel"
        aria-pressed={aiActive}
        data-testid="editor-ask-ai"
      >
        <Sparkles className="h-3.5 w-3.5" />
        Ask AI
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={onOpenInShell}
        className="h-7 gap-1.5"
        title="Open current SQL in the terminal shell"
        data-testid="editor-open-shell"
      >
        <TerminalSquare className="h-3.5 w-3.5" />
        Shell
      </Button>
    </div>
  );
}
