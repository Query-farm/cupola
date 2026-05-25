import { Sparkles, X } from "lucide-react";
import { ChatMarkdown } from "./ChatMarkdown";
import { SqlToolCallBlock } from "./SqlToolCallBlock";
import { AskUserBlock } from "./AskUserBlock";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { MosaicChartBlock } from "./MosaicChartBlock";
import { estimateCost, formatCost } from "@/lib/pricing";

export interface ToolCallDisplayResult {
  /** SQL result shape (used by run_sql). */
  columns?: string[];
  rows?: Record<string, any>[];
  rowCount?: number;
  showing?: number;
  message?: string;
  /** Chart shape (used by generate_chart). Spec is a Mosaic vgplot JSON spec. */
  chart?: { spec: any; title: string };
}

export interface ToolCallEntry {
  name: string;
  input: any;
  result?: string;
  displayResult?: ToolCallDisplayResult;
  isExecuting?: boolean;
  error?: string;
  progress?: number;
}

export interface AskUserState {
  question: string;
  options: string[];
  selectedIndex?: number;
  resolved: boolean;
}

export type ContentBlock =
  | { type: "text"; id: string; content: string }
  | { type: "tool_call"; id: string; toolCall: ToolCallEntry }
  | { type: "thinking"; id: string; label: string }
  | { type: "ask_user"; id: string; askUser: AskUserState };

interface Props {
  blocks: ContentBlock[];
  isStreaming?: boolean;
  onAskUserSelect?: (option: string, index: number) => void;
  onCancel?: () => void;
  usage?: { inputTokens: number; outputTokens: number };
  model?: string;
}

/** Small inline cancel button shown next to a running tool indicator. */
function CancelChip({ onCancel }: { onCancel: () => void }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onCancel(); }}
      className="shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-destructive bg-destructive/10 hover:bg-destructive/20 transition-colors"
      title="Cancel (Escape)"
    >
      <X className="h-3 w-3" />
      Cancel
    </button>
  );
}

export function ChatMessageAssistant({
  blocks, isStreaming, onAskUserSelect, onCancel, usage, model,
}: Props) {
  return (
    <div className="flex gap-2.5">
      <div className="shrink-0 mt-1">
        <Sparkles className="h-4 w-4 text-accent" />
      </div>
      <div className="flex-1 min-w-0 space-y-3">
        {/* Render blocks in stream order */}
        {blocks.map((block) => {
          if (block.type === "text") {
            return block.content ? <ChatMarkdown key={block.id} content={block.content} /> : null;
          }
          if (block.type === "tool_call") {
            const tc = block.toolCall;
            if (tc.name === "run_sql") {
              return <SqlToolCallBlock key={block.id} toolCall={tc} onCancel={onCancel} />;
            }
            if (tc.name === "generate_chart") {
              const chart = tc.displayResult?.chart;
              const title = chart?.title || tc.input?.title;
              // Status indicator until the spec is ready, then the chart itself.
              if (tc.error) {
                return (
                  <div key={block.id} className="text-xs text-destructive/80 flex items-start gap-1.5 py-0.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-destructive/60 mt-1.5" />
                    <div>Chart failed{title ? `: ${title}` : ""} — {tc.error}</div>
                  </div>
                );
              }
              if (!chart) {
                return (
                  <div key={block.id} className="text-xs text-muted-foreground/60 flex items-center gap-1.5 py-0.5">
                    <span className={`w-1.5 h-1.5 rounded-full ${tc.isExecuting ? "bg-primary/40 animate-pulse" : "bg-muted-foreground/30"}`} />
                    <span className="flex-1">{tc.isExecuting ? `Preparing chart${title ? `: ${title}` : ""}…` : `Chart${title ? `: ${title}` : ""}`}</span>
                    {tc.isExecuting && onCancel && <CancelChip onCancel={onCancel} />}
                  </div>
                );
              }
              return <MosaicChartBlock key={block.id} spec={chart.spec} title={chart.title} />;
            }
            if (
              tc.name === "list_tables" || tc.name === "describe_table" ||
              tc.name === "read_query_results" || tc.name === "read_chart_docs" ||
              tc.name === "list_chart_examples" || tc.name === "read_chart_example"
            ) {
              const label = tc.name === "describe_table"
                ? `Looking up ${tc.input?.schema}.${tc.input?.table}`
                : tc.name === "list_tables"
                ? "Looking up tables"
                : tc.name === "read_chart_docs"
                ? "Reading chart docs"
                : tc.name === "list_chart_examples"
                ? "Browsing chart examples"
                : tc.name === "read_chart_example"
                ? `Reading chart example: ${tc.input?.name || "(unknown)"}`
                : "Reading more results";
              return (
                <div key={block.id} className="text-xs text-muted-foreground/60 flex items-center gap-1.5 py-0.5">
                  <span className={`w-1.5 h-1.5 rounded-full ${tc.isExecuting ? "bg-primary/40 animate-pulse" : "bg-muted-foreground/30"}`} />
                  <span className="flex-1">{tc.isExecuting ? `${label}...` : label}</span>
                  {tc.isExecuting && onCancel && <CancelChip onCancel={onCancel} />}
                </div>
              );
            }
            return null;
          }
          if (block.type === "thinking") {
            return <ThinkingIndicator key={block.id} label={block.label} onCancel={onCancel} />;
          }
          if (block.type === "ask_user") {
            return (
              <AskUserBlock
                key={block.id}
                question={block.askUser.question}
                options={block.askUser.options}
                selectedIndex={block.askUser.selectedIndex}
                resolved={block.askUser.resolved}
                onSelect={onAskUserSelect}
              />
            );
          }
          return null;
        })}

        {/* Usage stats */}
        {usage && !isStreaming && (
          <div className="text-[10px] text-muted-foreground/40 font-mono pt-1">
            {usage.inputTokens.toLocaleString()} in, {usage.outputTokens.toLocaleString()} out
            {model && ` · ${formatCost(estimateCost(model, usage.inputTokens, usage.outputTokens))}`}
          </div>
        )}
      </div>
    </div>
  );
}
