import { Play, Square, Sparkles, WandSparkles, TerminalSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ExportMenu } from "./ExportMenu";
import type { ExportFormat } from "@/lib/editor/result-export";

interface Props {
  running: boolean;
  /** bridge.query is available (DuckDB booted). */
  queryReady: boolean;
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
}

export function EditorToolbar({
  running,
  queryReady,
  hasResult,
  hasSelection,
  onRun,
  onStop,
  onFormat,
  onExport,
  onOpenInPerspective,
  onOpenInShell,
  onAskAI,
}: Props) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-card shrink-0">
      {running ? (
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
      ) : (
        <Button
          size="sm"
          onClick={onRun}
          disabled={!queryReady}
          className="h-7 gap-1.5"
          title={hasSelection ? "Run selection (⌘/Ctrl+Enter for statement)" : "Run statement at cursor (⌘/Ctrl+Enter)"}
          data-testid="editor-run"
        >
          <Play className="h-3.5 w-3.5" />
          {hasSelection ? "Run selection" : "Run"}
        </Button>
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

      <div className="flex-1" />

      <Button
        size="sm"
        variant="ghost"
        onClick={onAskAI}
        className="h-7 gap-1.5"
        title="Ask AI to write or explain SQL"
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
