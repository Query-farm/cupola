import { Sparkles } from "lucide-react";
import { ChatMarkdown } from "./ChatMarkdown";
import { SqlToolCallBlock } from "./SqlToolCallBlock";
import { AskUserBlock } from "./AskUserBlock";
import { ThinkingIndicator } from "./ThinkingIndicator";

export interface ToolCallDisplayResult {
  columns: string[];
  rows: Record<string, any>[];
  rowCount: number;
  showing: number;
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

export type ContentBlock =
  | { type: "text"; content: string }
  | { type: "tool_call"; toolCall: ToolCallEntry }
  | { type: "thinking"; label: string }
  | { type: "ask_user"; askUser: AskUserState };

interface Props {
  blocks: ContentBlock[];
  isStreaming?: boolean;
  onAskUserSelect?: (option: string, index: number) => void;
  usage?: { inputTokens: number; outputTokens: number };
  model?: string;
}

export function ChatMessageAssistant({
  blocks, isStreaming, onAskUserSelect, usage, model,
}: Props) {
  return (
    <div className="flex gap-2.5">
      <div className="shrink-0 mt-1">
        <Sparkles className="h-4 w-4 text-accent" />
      </div>
      <div className="flex-1 min-w-0 space-y-3">
        {/* Render blocks in stream order */}
        {blocks.map((block, i) => {
          if (block.type === "text") {
            return block.content ? <ChatMarkdown key={i} content={block.content} /> : null;
          }
          if (block.type === "tool_call") {
            const tc = block.toolCall;
            if (tc.name === "run_sql") {
              return <SqlToolCallBlock key={i} toolCall={tc} />;
            }
            if (tc.name === "list_tables" || tc.name === "describe_table" || tc.name === "read_query_results") {
              const label = tc.name === "describe_table"
                ? `Looking up ${tc.input?.schema}.${tc.input?.table}`
                : tc.name === "list_tables"
                ? "Looking up tables"
                : "Reading more results";
              return (
                <div key={i} className="text-xs text-muted-foreground/60 flex items-center gap-1.5 py-0.5">
                  <span className={`w-1.5 h-1.5 rounded-full ${tc.isExecuting ? "bg-primary/40 animate-pulse" : "bg-muted-foreground/30"}`} />
                  {tc.isExecuting ? `${label}...` : label}
                </div>
              );
            }
            return null;
          }
          if (block.type === "thinking") {
            return <ThinkingIndicator key={i} label={block.label} />;
          }
          if (block.type === "ask_user") {
            return (
              <AskUserBlock
                key={i}
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
            {model && (() => {
              const pricing: Record<string, [number, number]> = {
                "claude-haiku-4-5-20251001": [1, 5],
                "claude-sonnet-4-20250514": [3, 15],
                "claude-opus-4-20250514": [15, 75],
              };
              const [inR, outR] = pricing[model] || [3, 15];
              const cost = (usage.inputTokens * inR + usage.outputTokens * outR) / 1_000_000;
              return ` · ${cost < 0.01 ? "<$0.01" : `~$${cost.toFixed(2)}`}`;
            })()}
          </div>
        )}
      </div>
    </div>
  );
}
