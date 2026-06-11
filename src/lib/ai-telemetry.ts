/**
 * Pure helpers for Sentry AI-agent monitoring (gen_ai semantic conventions).
 *
 * Maps the agent's internal Anthropic message/usage shapes to the attribute
 * payloads Sentry's AI Agents / Conversations views expect. Kept free of
 * Sentry imports so the mapping rules stay unit-testable (the actual spans
 * are started in ai-agent.ts).
 */

import type { ContentBlock, MessageParam, Tool, ToolResult } from "./ai-agent";

export const AGENT_NAME = "cupola-data-analyst";

/** gen_ai.* attribute names as of @sentry/core 10.55 — see
 *  @sentry/core/build/types/tracing/ai/gen-ai-attributes.d.ts. Centralized so
 *  a convention rename is a one-file change. */
export const ATTR = {
  OPERATION_NAME: "gen_ai.operation.name",
  AGENT_NAME: "gen_ai.agent.name",
  REQUEST_MODEL: "gen_ai.request.model",
  SYSTEM: "gen_ai.system",
  INPUT_MESSAGES: "gen_ai.input.messages",
  OUTPUT_MESSAGES: "gen_ai.output.messages",
  SYSTEM_INSTRUCTIONS: "gen_ai.system_instructions",
  AVAILABLE_TOOLS: "gen_ai.request.available_tools",
  FINISH_REASONS: "gen_ai.response.finish_reasons",
  USAGE_INPUT: "gen_ai.usage.input_tokens",
  USAGE_INPUT_CACHED: "gen_ai.usage.input_tokens.cached",
  USAGE_INPUT_CACHE_WRITE: "gen_ai.usage.input_tokens.cache_write",
  USAGE_OUTPUT: "gen_ai.usage.output_tokens",
  USAGE_TOTAL: "gen_ai.usage.total_tokens",
  TOOL_NAME: "gen_ai.tool.name",
  TOOL_TYPE: "gen_ai.tool.type",
  TOOL_CALL_ID: "gen_ai.tool.call.id",
  TOOL_INPUT: "gen_ai.tool.input",
  TOOL_OUTPUT: "gen_ai.tool.output",
} as const;

// ---------------------------------------------------------------------------
// Token usage
// ---------------------------------------------------------------------------

export interface AnthropicUsage {
  /** Anthropic's usage.input_tokens — the UNCACHED remainder only. */
  inputTokens: number;
  /** usage.cache_read_input_tokens */
  cacheReadTokens: number;
  /** usage.cache_creation_input_tokens */
  cacheWriteTokens: number;
  outputTokens: number;
}

/** Sentry's cost math requires gen_ai.usage.input_tokens to INCLUDE the
 *  cached/cache-write counts, with .cached and .cache_write as subsets it
 *  subtracts back out. Anthropic reports them as disjoint counts, so the
 *  total must be summed here — reporting the raw input_tokens would make the
 *  subsets exceed the total and produce negative costs in the dashboard. */
export function mapUsageAttributes(u: AnthropicUsage): Record<string, number> {
  const totalInput = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  return {
    [ATTR.USAGE_INPUT]: totalInput,
    [ATTR.USAGE_INPUT_CACHED]: u.cacheReadTokens,
    [ATTR.USAGE_INPUT_CACHE_WRITE]: u.cacheWriteTokens,
    [ATTR.USAGE_OUTPUT]: u.outputTokens,
    [ATTR.USAGE_TOTAL]: totalInput + u.outputTokens,
  };
}

// ---------------------------------------------------------------------------
// Message serialization (gen_ai.input.messages / gen_ai.output.messages)
// ---------------------------------------------------------------------------

/** Caps keep span attributes well under envelope limits even on long
 *  conversations: any single part is truncated, and whole oldest messages are
 *  elided once the serialized total exceeds the budget. */
const MAX_PART_CHARS = 20_000;
const MAX_TOTAL_CHARS = 200_000;

interface GenAiPart {
  type: "text" | "tool_call" | "tool_result";
  content?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

interface GenAiMessage {
  role: string;
  parts: GenAiPart[];
  finish_reason?: string;
}

function capText(text: string): string {
  if (text.length <= MAX_PART_CHARS) return text;
  return `${text.slice(0, MAX_PART_CHARS)}… [truncated ${text.length - MAX_PART_CHARS} chars]`;
}

/** render_chart tool_results carry base64 PNGs — megabytes that must never
 *  land in a span attribute. Replace with a small placeholder. */
function imagePlaceholder(mediaType: string, base64Data: string): string {
  // base64 → bytes: 3/4 of the encoded length.
  const bytes = Math.floor((base64Data.length * 3) / 4);
  return `[image ${mediaType}, ${bytes} bytes elided]`;
}

/** Flatten a ToolResult to display text: strings pass through, array results
 *  join their text parts with images elided. Used for both the tool_result
 *  parts inside input messages and the gen_ai.tool.output attribute. */
export function serializeToolResult(result: ToolResult): string {
  if (typeof result === "string") return capText(result);
  const parts = result.map((p) =>
    p.type === "text" ? p.text : imagePlaceholder(p.source.media_type, p.source.data)
  );
  return capText(parts.join("\n"));
}

function contentBlockToPart(block: ContentBlock): GenAiPart {
  if (block.type === "tool_use") {
    return { type: "tool_call", id: block.id, name: block.name, arguments: block.input };
  }
  return { type: "text", content: capText(block.text ?? "") };
}

function messageToGenAi(msg: MessageParam): GenAiMessage {
  if (typeof msg.content === "string") {
    return { role: msg.role, parts: [{ type: "text", content: capText(msg.content) }] };
  }
  const parts: GenAiPart[] = msg.content.map((block) => {
    if (block.type === "tool_result") {
      return {
        type: "tool_result" as const,
        id: block.tool_use_id,
        content: serializeToolResult(block.content),
      };
    }
    return contentBlockToPart(block as ContentBlock);
  });
  // A user message carrying only tool_results is a tool turn in gen_ai terms.
  const role = parts.length > 0 && parts.every((p) => p.type === "tool_result") ? "tool" : msg.role;
  return { role, parts };
}

/** Serialize the request messages, eliding oldest messages once the total
 *  exceeds the budget (the recent tail is what matters for debugging). */
export function serializeInputMessages(messages: MessageParam[]): string {
  const mapped = messages.map(messageToGenAi);
  let serialized = JSON.stringify(mapped);
  let elided = 0;
  while (serialized.length > MAX_TOTAL_CHARS && mapped.length - elided > 1) {
    elided++;
    serialized = JSON.stringify([
      { role: "system", parts: [{ type: "text", content: `[${elided} earlier messages elided]` }] },
      ...mapped.slice(elided),
    ]);
  }
  return serialized;
}

/** Serialize one assistant response (content blocks + stop reason). */
export function serializeOutputMessages(content: ContentBlock[], stopReason: string): string {
  const message: GenAiMessage = {
    role: "assistant",
    parts: content.map(contentBlockToPart),
    finish_reason: stopReason,
  };
  return JSON.stringify([message]);
}

export function serializeToolDefinitions(tools: Tool[]): string {
  return JSON.stringify(
    tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    }))
  );
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** User cancellations arrive as AbortError DOMExceptions (runAgentTurn,
 *  withAbort tool wrappers) or as fetchWithRetry's `Error("Cancelled.")`.
 *  Neither should mark a span as an internal error. */
export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; message?: string };
  return e.name === "AbortError" || e.message === "Cancelled.";
}

/** Fresh read of the opt-out switch (Settings → "Share AI conversation
 *  analytics"). Defaults to enabled; reads localStorage directly so non-React
 *  callers (ai-agent.ts, shell-ai-mode.ts) see mid-session changes. */
export function isAiTelemetryEnabled(): boolean {
  if (typeof localStorage === "undefined") return true;
  try {
    const raw = localStorage.getItem("vgi-frontend-settings");
    if (!raw) return true;
    return (JSON.parse(raw) as { aiTelemetry?: boolean }).aiTelemetry !== false;
  } catch {
    return true;
  }
}
