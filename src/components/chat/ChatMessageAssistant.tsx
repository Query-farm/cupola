import { lazy, Suspense } from "react";
import { Sparkles, X } from "lucide-react";
import { ChatMarkdown } from "./ChatMarkdown";
import { SqlToolCallBlock } from "./SqlToolCallBlock";
import { AskUserBlock } from "./AskUserBlock";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { estimateCost, formatCost } from "@/lib/pricing";

// Lazy: pulls vega-embed (and transitively vega + vega-lite runtime) only
// when a chart block is actually present. Keeps the AskAIChat entry chunk
// out of the vega tree.
const VegaChartBlock = lazy(() =>
  import("./VegaChartBlock").then((m) => ({ default: m.VegaChartBlock })),
);

export interface ToolCallDisplayResult {
  /** SQL result shape (used by run_sql). */
  columns?: string[];
  rows?: Record<string, any>[];
  rowCount?: number;
  showing?: number;
  message?: string;
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

/** Vega-Lite chart block created by the render_chart tool. The actual rows
 *  live in src/lib/chart-rows-store.ts keyed by `chartId`; this block only
 *  carries the metadata needed to re-run the query and render the chart.
 *
 *  `spec` is intentionally typed as Record<string, any> here (NOT
 *  TopLevelSpec from vega-lite). The strongly-typed import only happens
 *  inside VegaChartBlock.tsx, which is dynamic-imported. This keeps the
 *  vega-lite runtime out of the eager bundle even if someone forgets the
 *  `type` keyword on an import elsewhere. */
export interface VegaChartContent {
  chartId: string;
  sql: string;
  spec: Record<string, any>;
  title?: string;
  rowCount: number;
  columns: string[];
  fetchedAt: number;
  /** Set after a failed refresh; chart from last successful fetch stays visible. */
  error?: string;
  /** Vega-Lite compile warnings (e.g. "shape dropped as it is incompatible
   *  with 'circle'", "Log scale domain includes zero"). The chart still
   *  renders — these are informational so the user knows the model's spec
   *  had issues. The model also receives them via the tool_result. */
  warnings?: string[];
  /** True while the agent's current turn is still in progress and the
   *  agent might call render_chart again to improve. UI shows a placeholder
   *  card instead of the chart. Cleared when the turn finishes; user sees
   *  only the version the agent settled on. */
  pending?: boolean;
}

export type ContentBlock =
  | { type: "text"; id: string; content: string }
  | { type: "tool_call"; id: string; toolCall: ToolCallEntry }
  | { type: "thinking"; id: string; label: string }
  | { type: "ask_user"; id: string; askUser: AskUserState }
  | { type: "vega_chart"; id: string; chart: VegaChartContent };

interface Props {
  blocks: ContentBlock[];
  isStreaming?: boolean;
  onAskUserSelect?: (option: string, index: number) => void;
  onCancel?: () => void;
  /** Patch a block in place by id — used by VegaChartBlock for refresh state. */
  onUpdateBlock?: (blockId: string, patch: Partial<VegaChartContent>) => void;
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
  blocks, isStreaming, onAskUserSelect, onCancel, onUpdateBlock, usage, model,
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
            if (
              tc.name === "list_tables" || tc.name === "describe_table" ||
              tc.name === "read_query_results"
            ) {
              const label = tc.name === "describe_table"
                ? `Looking up ${tc.input?.schema}.${tc.input?.table}`
                : tc.name === "list_tables"
                ? "Looking up tables"
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
          if (block.type === "vega_chart") {
            // While the agent's turn is still in progress, the chart may
            // get replaced by a follow-up render_chart call — don't show
            // the user a draft. Render a compact placeholder until the
            // turn ends (onDone clears pending).
            if (block.chart.pending) {
              return (
                <div
                  key={block.id}
                  data-testid="vega-chart-pending"
                  className="border border-border rounded-md bg-card px-3 py-3 flex items-center gap-2 text-xs text-muted-foreground"
                >
                  <Sparkles className="h-3.5 w-3.5 animate-pulse text-accent" />
                  <span className="flex-1 truncate">
                    {block.chart.title ? `Evaluating chart: ${block.chart.title}` : "Evaluating chart"}
                  </span>
                  <span className="text-[10px] font-mono">{block.chart.rowCount.toLocaleString()} rows</span>
                </div>
              );
            }
            return (
              <Suspense
                key={block.id}
                fallback={<div className="text-xs text-muted-foreground/60 py-2">Loading chart…</div>}
              >
                <VegaChartBlock
                  chart={block.chart}
                  onUpdate={(patch) => onUpdateBlock?.(block.id, patch)}
                />
              </Suspense>
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
