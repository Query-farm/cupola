import { lazy, Suspense } from "react";
import { Sparkles, X, Loader2, FileChartColumn, ChevronRight } from "lucide-react";
import { ChatMarkdown } from "./ChatMarkdown";
import { SqlToolCallBlock } from "./SqlToolCallBlock";
import { AskUserBlock } from "./AskUserBlock";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { toolActivityLabel } from "@/lib/ai/tool-labels";
import { estimateCost, formatCost } from "@/lib/pricing";
import { cacheHitRate, totalInputTokens, type AgentUsage } from "@/lib/ai-usage";
import { promoteToReport } from "@/lib/reports/events";

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
/** Metadata for one of a chart's extra named datasets (overlays, layers,
 *  reference data). Up to 5 per chart. Each has its own SQL that the
 *  refresh button re-runs alongside the primary. */
export interface VegaChartExtraSource {
  name: string;
  sql: string;
  rowCount: number;
  columns: string[];
}

export interface VegaChartContent {
  chartId: string;
  sql: string;
  spec: Record<string, any>;
  title?: string;
  /** Primary dataset's row count + columns. */
  rowCount: number;
  columns: string[];
  /** Additional named datasets injected as Vega-Lite's top-level `datasets`.
   *  Undefined for single-source charts (the common case). */
  extraSources?: VegaChartExtraSource[];
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
  usage?: AgentUsage;
  model?: string;
  /** Override how a `run_sql` tool call renders (the editor panel uses this to
   *  add "apply to editor" actions). Defaults to the plain SqlToolCallBlock. */
  renderSqlToolCall?: (toolCall: ToolCallEntry, onCancel?: () => void) => React.ReactNode;
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

function formatToolValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function ToolCallActivity({ toolCall, onCancel }: { toolCall: ToolCallEntry; onCancel?: () => void }) {
  const label = toolActivityLabel(toolCall.name, toolCall.input);
  const sql = typeof toolCall.input?.sql === "string" ? toolCall.input.sql : null;
  const remainingInput = sql && toolCall.input && typeof toolCall.input === "object" && !Array.isArray(toolCall.input)
    ? Object.fromEntries(Object.entries(toolCall.input).filter(([key]) => key !== "sql"))
    : toolCall.input;
  const argumentsText = formatToolValue(remainingInput);
  const showArguments = argumentsText !== "{}" && argumentsText !== "undefined";
  const activityLabel = toolCall.isExecuting
    ? `${label}...`
    : toolCall.error
      ? `${label} failed`
      : label;

  return (
    <div className="flex items-start gap-1.5 text-xs text-muted-foreground/70">
      <details
        data-testid={`tool-call-details-${toolCall.name}`}
        className="group min-w-0 flex-1 rounded-md border border-transparent open:border-border open:bg-muted/20"
      >
        <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md py-1 pr-2 hover:bg-muted/40 [&::-webkit-details-marker]:hidden">
          <ChevronRight className="h-3 w-3 shrink-0 transition-transform group-open:rotate-90" aria-hidden="true" />
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${toolCall.error ? "bg-destructive/70" : toolCall.isExecuting ? "bg-primary/40 animate-pulse" : "bg-muted-foreground/30"}`} />
          <span className="min-w-0 flex-1 truncate">{activityLabel}</span>
          <span className="shrink-0 font-mono text-[9px] text-muted-foreground/50">{toolCall.name}</span>
        </summary>
        <div className="space-y-2 border-t px-3 py-2">
          {sql && <div>
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">SQL</div>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-background p-2 font-mono text-[11px] leading-relaxed text-foreground">{sql}</pre>
          </div>}
          {showArguments && <div>
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Arguments</div>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-background p-2 font-mono text-[11px] leading-relaxed text-foreground">{argumentsText}</pre>
          </div>}
          {toolCall.error && <div>
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-destructive">Error</div>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-destructive/5 p-2 font-mono text-[11px] leading-relaxed text-destructive">{toolCall.error}</pre>
          </div>}
          {!toolCall.error && toolCall.result && <div>
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Result</div>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-background p-2 font-mono text-[11px] leading-relaxed text-foreground">{toolCall.result}</pre>
          </div>}
          {!sql && !showArguments && !toolCall.error && !toolCall.result && <div className="text-[11px] text-muted-foreground">No additional details yet.</div>}
        </div>
      </details>
      {toolCall.isExecuting && onCancel && <div className="pt-1"><CancelChip onCancel={onCancel} /></div>}
    </div>
  );
}

export function ChatMessageAssistant({
  blocks, isStreaming, onAskUserSelect, onCancel, onUpdateBlock, usage, model, renderSqlToolCall,
}: Props) {
  const narrative = blocks.filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text").map((b) => b.content).join("\n\n");
  return (
    <div className="flex gap-2.5">
      <div className="shrink-0 mt-1">
        <Sparkles className="h-4 w-4 text-accent" />
      </div>
      <div className="flex-1 min-w-0 space-y-3">
        {/* Render blocks in stream order */}
        {blocks.map((block) => {
          if (block.type === "text") {
            return block.content ? <ChatMarkdown key={block.id} content={block.content} copyTables /> : null;
          }
          if (block.type === "tool_call") {
            const tc = block.toolCall;
            if (tc.name === "run_sql") {
              return (
                <div key={block.id}>
                  {renderSqlToolCall
                    ? renderSqlToolCall(tc, onCancel)
                    : <SqlToolCallBlock toolCall={tc} onCancel={onCancel} />}
                  {!tc.isExecuting && tc.input?.sql && !tc.error && (
                    <button
                      className="mt-1 inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-primary"
                      onClick={() => promoteToReport({ sql: tc.input.sql, title: "AI query", markdown: narrative || undefined })}
                    >
                      <FileChartColumn className="h-3 w-3" /> Add to report
                    </button>
                  )}
                </div>
              );
            }
            // ask_user renders its own block (pushed by the tool itself), so a
            // status row here would just duplicate it. Every OTHER tool gets
            // one — including render_chart, which previously fell through to
            // `return null` and so spent its whole pipeline (compile, SQL,
            // extras, PNG render) with nothing on screen at all.
            if (tc.name === "ask_user") return null;
            return <ToolCallActivity key={block.id} toolCall={tc} onCancel={onCancel} />;
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
            // the user a draft. Render a spinner-bearing placeholder that
            // makes it obvious work is happening; the placeholder
            // disappears (and the real chart appears) when the agent's
            // turn ends or it calls render_chart again with revisions.
            if (block.chart.pending) {
              return (
                <div
                  key={block.id}
                  data-testid="vega-chart-pending"
                  className="border border-accent/30 rounded-md bg-accent/5 px-4 py-3 flex items-center gap-3 text-sm"
                  role="status"
                  aria-live="polite"
                >
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-accent" />
                  <span className="flex-1 truncate text-foreground/80">
                    Agent is reviewing the chart
                    {block.chart.title ? <span className="text-muted-foreground"> — {block.chart.title}</span> : null}
                    <span className="ml-0.5 inline-block animate-pulse text-accent">…</span>
                  </span>
                  <span className="text-[10px] font-mono text-muted-foreground shrink-0">
                    {block.chart.rowCount.toLocaleString()} rows
                  </span>
                </div>
              );
            }
            return (
              <div key={block.id}>
                <Suspense fallback={<div className="text-xs text-muted-foreground/60 py-2">Loading chart…</div>}>
                  <VegaChartBlock
                    chart={block.chart}
                    onUpdate={(patch) => onUpdateBlock?.(block.id, patch)}
                  />
                </Suspense>
                <button
                  className="mt-1 inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-primary"
                  onClick={() => promoteToReport({ sql: block.chart.sql, title: block.chart.title || "AI chart", chartSpec: block.chart.spec, markdown: narrative || undefined })}
                >
                  <FileChartColumn className="h-3 w-3" /> Add to report
                </button>
              </div>
            );
          }
          return null;
        })}

        {/* Usage stats */}
        {usage && !isStreaming && (
          <div className="text-[10px] leading-relaxed text-muted-foreground/50 font-mono pt-1" data-testid="ai-usage">
            <div>
              {totalInputTokens(usage).toLocaleString()} input · {usage.outputTokens.toLocaleString()} output
              {` · ${usage.rounds.toLocaleString()} ${usage.rounds === 1 ? "round" : "rounds"}`}
              {model && ` · ${formatCost(estimateCost(model, usage))}`}
            </div>
            {(usage.cacheReadTokens > 0 || usage.cacheWriteTokens > 0) && (
              <div title="Prompt-cache reads are discounted input; writes create a reusable five-minute cache entry.">
                {(cacheHitRate(usage) * 100).toFixed(0)}% cache hit · {usage.cacheReadTokens.toLocaleString()} read · {usage.cacheWriteTokens.toLocaleString()} written · {usage.inputTokens.toLocaleString()} uncached
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
