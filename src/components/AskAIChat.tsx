import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { Sparkles, RotateCcw, Settings, FileText, Copy } from "lucide-react";
import * as Sentry from "@sentry/astro";
import { useSettings } from "@/lib/settings";
import { bridge } from "@/lib/shell-bridge";
import type { CatalogData } from "@/lib/service";
import {
  runAgentTurn,
  buildSystemPrompt,
  executeListTables,
  executeReadQueryResults,
  TOOLS,
  CHART_TOOL,
  type MessageParam,
} from "@/lib/ai-agent";
import { executeRunSql, describeTableWithFallback, validateChartSpec } from "@/lib/ai-tool-executor";
import { readRows } from "@/lib/duckdb-query";
import { cacheChartRows } from "@/lib/chart-rows-store";
const uid = () => crypto.randomUUID();

import { ChatInput } from "./chat/ChatInput";
import { ChatMessageUser } from "./chat/ChatMessageUser";
import {
  ChatMessageAssistant,
  type ContentBlock,
  type ToolCallEntry,
  type AskUserState,
} from "./chat/ChatMessageAssistant";
interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content?: string; // user messages only
  blocks?: ContentBlock[]; // assistant messages only
  isStreaming?: boolean;
  usage?: { inputTokens: number; outputTokens: number };
}

interface Props {
  catalogData?: CatalogData;
  serviceUrl: string;
  catalogName: string;
  isActive?: boolean;
}

export function AskAIChat({ catalogData, serviceUrl, catalogName, isActive }: Props) {
  const { settings } = useSettings();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const agentMessages = useRef<MessageParam[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const askUserResolve = useRef<((value: string) => void) | null>(null);

  // Auto-scroll only if user is already near the bottom
  const userScrolledUp = useRef(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && !userScrolledUp.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      userScrolledUp.current = !atBottom;
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Global Escape key to stop generation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && abortRef.current) {
        // Resolve any pending ask_user promise to prevent leak
        if (askUserResolve.current) {
          askUserResolve.current("__cancelled__");
          askUserResolve.current = null;
        }
        abortRef.current.abort();
        bridge.cancelQuery?.();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // Test hook: push a chart block into the conversation without going through
  // the agent loop. Used by tests/charts.spec.ts. Always exposed (no DEV gate)
  // for the same reason __bridge is: integration tests need a real handle into
  // the running app. The hook is a no-op outside of e2e test runs.
  useEffect(() => {
    (window as any).__cupolaChartTest = {
      pushChart: async (input: { sql: string; spec: Record<string, any>; title?: string }) => {
        const { errors, sanitized } = validateChartSpec(input.spec);
        if (errors.length) throw new Error(`Invalid chart spec: ${errors.join("; ")}`);
        if (!bridge.query) throw new Error("DuckDB not ready");
        const rows = await readRows(input.sql);
        if (rows === null) throw new Error("Query failed or returned no rows");
        const chartId = uid();
        const columns = rows.length ? Object.keys(rows[0]) : [];
        cacheChartRows(chartId, rows, columns);
        const msgId = crypto.randomUUID();
        const blockId = uid();
        setMessages((prev) => [...prev, {
          id: msgId, role: "assistant", isStreaming: false,
          blocks: [{
            type: "vega_chart" as const,
            id: blockId,
            chart: {
              chartId, sql: input.sql, spec: sanitized, title: input.title,
              rowCount: rows.length, columns, fetchedAt: Date.now(),
            },
          }],
        }]);
        return { messageId: msgId, blockId, chartId };
      },
    };
    return () => {
      delete (window as any).__cupolaChartTest;
    };
  }, []);

  const getSetting = (key: string) => {
    try {
      const stored = localStorage.getItem("vgi-frontend-settings");
      if (stored) return JSON.parse(stored)[key];
    } catch {}
    return (settings as any)[key];
  };

  const handleSend = useCallback(async (text: string) => {
    const apiKey = getSetting("anthropicApiKey") || "";
    if (!apiKey) {
      setMessages(prev => [...prev, {
        id: crypto.randomUUID(), role: "assistant",
        blocks: [{ type: "text", id: uid(), content: "To use Ask AI, please add your Anthropic API key in **Settings** (gear icon in the sidebar)." }],
      }]);
      return;
    }
    if (!catalogData) return;

    // Add user message
    setMessages(prev => [...prev, { id: crypto.randomUUID(), role: "user", content: text }]);
    agentMessages.current.push({ role: "user", content: text });

    // Add placeholder assistant message with thinking indicator
    const assistantId = crypto.randomUUID();
    setMessages(prev => [...prev, {
      id: assistantId, role: "assistant",
      blocks: [{ type: "thinking", id: uid(), label: "Thinking" }],
      isStreaming: true,
    }]);

    setIsLoading(true);
    abortRef.current = new AbortController();

    // hasChartTool = true: include render_chart capability in the prompt
    // guidance (and CHART_TOOL in the tool list below). Terminal `.ai` mode
    // passes a different surface and would set this false.
    const systemPrompt = buildSystemPrompt(catalogData, serviceUrl, bridge.memoryCatalog, true);
    const model = getSetting("aiModel") || "claude-sonnet-4-20250514";
    const maxRounds = getSetting("aiMaxToolRounds") || 20;

    // Mutable blocks array — updated in callbacks, then set into state
    let blocks: ContentBlock[] = [];
    // Store display results for tool calls (set during executeTool, used by onToolResult)
    let pendingDisplayResult: import("./chat/ChatMessageAssistant").ToolCallDisplayResult | undefined;

    const updateBlocks = (newBlocks: ContentBlock[]) => {
      blocks = newBlocks;
      setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, blocks: [...blocks] } : m));
    };

    const updateAssistant = (updates: Partial<ChatMessage>) => {
      setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, ...updates } : m));
    };

    // Ensure there's a text block at the end of blocks to append to
    const ensureTextBlock = (): number => {
      const last = blocks[blocks.length - 1];
      if (last?.type === "text") return blocks.length - 1;
      blocks = [...blocks, { type: "text", id: uid(), content: "" }];
      return blocks.length - 1;
    };

    // Remove the thinking indicator from blocks
    const removeThinking = () => {
      blocks = blocks.filter(b => b.type !== "thinking");
    };

    /**
     * Race a promise against an AbortSignal. When the signal aborts we
     * fire bridge.cancelQuery to interrupt the haybarn worker (best-effort)
     * and reject with AbortError so the agent loop bails out — even if the
     * underlying bridge.query promise hasn't settled yet.
     */
    function withAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
      if (!signal) return p;
      return new Promise<T>((resolve, reject) => {
        if (signal.aborted) {
          bridge.cancelQuery?.();
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        const onAbort = () => {
          bridge.cancelQuery?.();
          reject(new DOMException("Aborted", "AbortError"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        p.then(
          (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
          (e) => { signal.removeEventListener("abort", onAbort); reject(e); },
        );
      });
    }

    // Tool executor. Heavy lifting (error classification, DDL detection,
    // describe_table SQL fallback) lives in ai-tool-executor.ts; this file
    // wires the UI-specific callbacks (progress, history entry, navigation).
    const executeTool = async (name: string, input: any, signal?: AbortSignal): Promise<string> => {
      if (name === "run_sql") {
        const queryFn = bridge.query;
        if (!queryFn) throw new Error("DuckDB shell not initialized — open SQL Shell first");
        const lastUserMsg = agentMessages.current.filter(m => m.role === "user").pop();
        const userQuestion = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : undefined;

        // Subscribe to bridge.progress while the query runs so the tool
        // block can render its progress bar. Restored in onEnd.
        const prevProgress = bridge.progress;
        const updateProgress = (pct: number) => {
          blocks = blocks.map(b =>
            b.type === "tool_call" && b.toolCall.isExecuting
              ? { ...b, toolCall: { ...b.toolCall, progress: pct } }
              : b
          );
          updateBlocks(blocks);
        };
        return executeRunSql(
          input.sql,
          { query: (sql) => withAbort(queryFn(sql), signal) },
          {
            onStart: () => { bridge.progress = updateProgress; },
            onEnd: () => { bridge.progress = prevProgress; },
            onOutcome: async (out) => {
              if (out.kind === "error") {
                bridge.addQueryHistoryEntry?.({
                  id: Date.now(), timestamp: Date.now(), sql: input.sql,
                  executionTimeMs: out.elapsedMs, success: false, error: out.errMsg, userQuestion,
                });
                return;
              }
              if (out.kind === "empty") {
                bridge.addQueryHistoryEntry?.({
                  id: Date.now(), timestamp: Date.now(), sql: input.sql,
                  executionTimeMs: out.elapsedMs, success: true, rowCount: 0, userQuestion,
                });
                pendingDisplayResult = { columns: [], rows: [], rowCount: 0, showing: 0, message: "Query executed successfully" };
                // COMMENT ON returns empty — refresh sidebar so comments appear.
                if (/COMMENT\s+ON/i.test(input.sql)) await bridge.refreshMemoryTables?.();
                return;
              }
              if (out.kind === "ddl") {
                bridge.addQueryHistoryEntry?.({
                  id: Date.now(), timestamp: Date.now(), sql: input.sql,
                  executionTimeMs: out.elapsedMs, success: true, rowCount: 0, userQuestion,
                });
                pendingDisplayResult = { columns: [], rows: [], rowCount: 0, showing: 0, message: "Query executed successfully" };
                await bridge.refreshMemoryTables?.();
                const createMatch = input.sql.match(/CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?(?:TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:memory\.)?(?:(\w+)\.)?(\w+)/i);
                if (createMatch) {
                  const schema = createMatch[1] || "main";
                  const name = createMatch[2];
                  bridge.navigateToSelection?.({ type: "table", name, schema, catalog: "memory" });
                }
                const dropMatch = input.sql.match(/DROP\s+(?:TABLE|VIEW|SCHEMA)\s+(?:IF\s+EXISTS\s+)?(?:memory\.)?(?:(\w+)\.)?(\w+)/i);
                if (dropMatch) {
                  const isSchemaLevel = /DROP\s+SCHEMA/i.test(input.sql);
                  if (isSchemaLevel) {
                    bridge.navigateToSelection?.({ type: "catalog", name: "memory", catalog: "memory" });
                  } else {
                    const schema = dropMatch[1] || "main";
                    bridge.navigateToSelection?.({ type: "schema", name: schema, schema, catalog: "memory" });
                  }
                }
                return;
              }
              // out.kind === "table"
              const parsed = JSON.parse(out.json);
              pendingDisplayResult = {
                columns: parsed.columns,
                rows: parsed.rows,
                rowCount: parsed.row_count,
                showing: parsed.showing,
              };
              bridge.addQueryHistoryEntry?.({
                id: Date.now(), timestamp: Date.now(), sql: input.sql,
                executionTimeMs: out.elapsedMs, success: true, rowCount: out.table.numRows, userQuestion,
              });
            },
          },
        );
      }
      if (name === "read_query_results") {
        return executeReadQueryResults(input.result_id, input.offset, input.limit);
      }
      if (name === "list_tables") {
        return executeListTables(catalogData!);
      }
      if (name === "describe_table") {
        const queryFn = bridge.query;
        if (!queryFn) throw new Error("DuckDB shell not initialized");
        return describeTableWithFallback(catalogData!, { query: queryFn }, input);
      }
      if (name === "ask_user") {
        return new Promise<string>((resolve) => {
          askUserResolve.current = resolve;
          // Remove thinking and add ask_user as an inline block
          removeThinking();
          blocks.push({ type: "ask_user", id: uid(), askUser: { question: input.question, options: input.options || [], resolved: false } });
          updateBlocks(blocks);
        });
      }
      if (name === "render_chart") {
        // Validate first — rejects external resource references anywhere in
        // the spec and strips any `data` field (rows always come from SQL).
        const { errors, sanitized } = validateChartSpec(input.spec);
        if (errors.length) {
          return JSON.stringify({ ok: false, error: `Invalid chart spec: ${errors.join("; ")}` });
        }
        if (!bridge.query) {
          return JSON.stringify({ ok: false, error: "DuckDB not ready — open the SQL Shell first." });
        }
        const rows = await readRows(input.sql);
        if (rows === null) {
          // Surface the DuckDB error to the model so it can fix the SQL.
          // readRows returns null on both query failure AND empty result;
          // for the chart case both are unrenderable, but we can do better
          // by re-running through bridge.query directly to get the actual
          // error message.
          const raw = await bridge.query(input.sql);
          if (!raw.ok) {
            return JSON.stringify({ ok: false, error: raw.error || "Query failed" });
          }
          return JSON.stringify({ ok: false, error: "Query returned no rows — nothing to chart." });
        }
        const chartId = uid();
        const columns = rows.length ? Object.keys(rows[0]) : [];
        cacheChartRows(chartId, rows, columns);
        removeThinking();
        blocks = [...blocks, {
          type: "vega_chart",
          id: uid(),
          chart: {
            chartId,
            sql: input.sql,
            spec: sanitized,
            title: input.title,
            rowCount: rows.length,
            columns,
            fetchedAt: Date.now(),
          },
        }];
        updateBlocks(blocks);
        return JSON.stringify({
          ok: true,
          row_count: rows.length,
          columns,
          // First 3 rows as a sample so the model knows the shape without
          // burning context on the full dataset.
          sample: rows.slice(0, 3),
        });
      }
      return JSON.stringify({ error: `Unknown tool: ${name}` });
    };

    try {
      await runAgentTurn(
        apiKey, model, agentMessages.current, systemPrompt, executeTool,
        {
          onText: (chunk) => {
            removeThinking();
            const idx = ensureTextBlock();
            const textBlock = blocks[idx] as { type: "text"; content: string };
            blocks = blocks.map((b, i) => i === idx ? { ...b, content: textBlock.content + chunk } : b);
            updateBlocks(blocks);
          },
          onToolCall: (name, input) => {
            removeThinking();
            const tc: ToolCallEntry = { name, input, isExecuting: true };
            blocks = [...blocks, { type: "tool_call", id: uid(), toolCall: tc }];
            updateBlocks(blocks);
          },
          onToolResult: (_name, _summary) => {
            const lastTcIdx = [...blocks].reverse().findIndex(b => b.type === "tool_call" && b.toolCall.isExecuting);
            if (lastTcIdx >= 0) {
              const actualIdx = blocks.length - 1 - lastTcIdx;
              const block = blocks[actualIdx] as { type: "tool_call"; toolCall: ToolCallEntry };
              const isErr = _summary.startsWith("Error:");
              blocks = blocks.map((b, i) => i === actualIdx
                ? { ...b, type: "tool_call" as const, toolCall: {
                    ...block.toolCall,
                    displayResult: pendingDisplayResult,
                    error: isErr ? _summary.slice(7) : undefined,
                    isExecuting: false,
                    progress: undefined,
                  } }
                : b
              );
              pendingDisplayResult = undefined;
            }
            // Add thinking indicator back
            blocks = [...blocks, { type: "thinking", id: uid(), label: "Thinking" }];
            updateBlocks(blocks);
          },
          onDone: (usage) => {
            removeThinking();
            updateBlocks(blocks);
            updateAssistant({ isStreaming: false, usage });
          },
          onRetry: (message) => {
            removeThinking();
            if (message) {
              blocks = [...blocks, { type: "thinking", id: uid(), label: message.replace("...", "") }];
            }
            updateBlocks(blocks);
          },
          onError: (error) => {
            removeThinking();
            const idx = ensureTextBlock();
            const textBlock = blocks[idx] as { type: "text"; content: string };
            blocks = blocks.map((b, i) => i === idx
              ? { ...b, content: textBlock.content + (textBlock.content ? "\n\n" : "") + `**Error:** ${error}` }
              : b
            );
            updateBlocks(blocks);
          },
        },
        abortRef.current.signal,
        maxRounds,
        // AskAIChat is the only surface that can render charts. Terminal
        // .ai mode passes the default TOOLS via shell-ai-mode.ts and
        // doesn't see render_chart at all.
        [...TOOLS, CHART_TOOL],
      );
    } catch (err: any) {
      removeThinking();
      // Mark any still-executing tool calls as stopped
      blocks = blocks.map(b =>
        b.type === "tool_call" && b.toolCall.isExecuting
          ? { ...b, toolCall: { ...b.toolCall, isExecuting: false, error: "Cancelled" } }
          : b
      );
      const isCancellation = err.name === "AbortError" || err.message === "Cancelled." || err.message === "Query cancelled";
      if (!isCancellation) {
        const idx = ensureTextBlock();
        const textBlock = blocks[idx] as { type: "text"; content: string };
        blocks = blocks.map((b, i) => i === idx
          ? { ...b, content: textBlock.content + (textBlock.content ? "\n\n" : "") + `**Error:** ${err.message}` }
          : b
        );
        Sentry.captureException(err, {
          tags: { component: "ai-agent", path: "chat" },
          extra: { model, maxRounds },
        });
      } else {
        blocks = [...blocks, { type: "text", id: uid(), content: "*(Stopped)*" }];
      }
      updateBlocks(blocks);
      updateAssistant({ isStreaming: false });
    } finally {
      setIsLoading(false);
      abortRef.current = null;
    }
  }, [catalogData, serviceUrl, settings]);

  const handleAskUserSelect = useCallback((option: string, index: number) => {
    setMessages(prev => prev.map(m => {
      if (!m.blocks) return m;
      const hasUnresolved = m.blocks.some(b => b.type === "ask_user" && !b.askUser.resolved);
      if (!hasUnresolved) return m;
      return {
        ...m,
        blocks: m.blocks.map(b =>
          b.type === "ask_user" && !b.askUser.resolved
            ? { ...b, askUser: { ...b.askUser, selectedIndex: index, resolved: true } }
            : b
        ),
      };
    }));
    askUserResolve.current?.(`User selected: ${option}`);
    askUserResolve.current = null;
  }, []);

  const handleNewConversation = () => {
    setMessages([]);
    agentMessages.current = [];
  };

  const handleStop = () => {
    abortRef.current?.abort();
    // Also cancel any running DuckDB query
    bridge.cancelQuery?.();
  };

  // Starter questions
  const starters = catalogData ? (() => {
    const firstSchema = catalogData.schemas[0];
    const firstTable = firstSchema?.tables[0];
    const questions: string[] = [];
    if (firstTable) {
      questions.push(`How many rows are in ${firstTable.name}?`);
      questions.push(`What columns does ${firstTable.name} have?`);
    }
    questions.push("What tables are available?");
    if (catalogData.schemas.length > 1) {
      questions.push("Summarize the database schemas");
    }
    return questions;
  })() : [];

  const hasApiKey = !!getSetting("anthropicApiKey");
  const hasMessages = messages.length > 0;
  const model = getSetting("aiModel") || "claude-sonnet-4-20250514";
  const [showSystemPrompt, setShowSystemPrompt] = useState(false);
  // Pass hasChartTool=true so the preview shown to the user matches what
  // the agent actually sees at runtime (see line 128).
  const systemPrompt = useMemo(() => catalogData ? buildSystemPrompt(catalogData, serviceUrl, bridge.memoryCatalog, true) : null, [catalogData, serviceUrl]);

  return (
    <div className="flex flex-col h-full bg-background">
      {hasMessages && (
        <div className="flex items-center justify-between px-6 py-1.5 border-b border-border shrink-0">
          <span className="text-xs text-muted-foreground font-medium">
            {messages.filter(m => m.role === "user").length} messages
          </span>
          <button
            onClick={handleNewConversation}
            className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1 transition-colors"
          >
            <RotateCcw className="h-3 w-3" />
            New
          </button>
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-5">
        {!hasMessages ? (
          <div className="flex flex-col justify-end h-full max-w-2xl px-2 pb-2">
            <div className="flex items-center gap-2 mb-2">
              <Sparkles className="h-4 w-4 text-accent shrink-0" />
              <span className="text-sm text-muted-foreground">Ask questions about your data in plain English.</span>
            </div>
            {!hasApiKey && (
              <div className="text-sm text-muted-foreground bg-muted/60 rounded-lg px-4 py-3 mb-2 flex items-center gap-2">
                <Settings className="h-4 w-4 shrink-0" />
                Add your Anthropic API key in Settings to get started.
              </div>
            )}
          </div>
        ) : (
          // max-w-5xl (1024px) instead of 2xl so chart blocks get enough
          // horizontal room. Text still reads fine at this width and the
          // tool_call / chart blocks finally have a real canvas.
          <div className="max-w-5xl space-y-4">
            {messages.map((msg) => (
              msg.role === "user" ? (
                <ChatMessageUser key={msg.id} content={msg.content || ""} />
              ) : (
                <ChatMessageAssistant
                  key={msg.id}
                  blocks={msg.blocks || []}
                  isStreaming={msg.isStreaming}
                  onAskUserSelect={handleAskUserSelect}
                  onCancel={msg.isStreaming ? handleStop : undefined}
                  onUpdateBlock={(blockId, patch) => {
                    // Used by VegaChartBlock for refresh state. Patches the
                    // chart portion of a specific block in place by id.
                    setMessages(prev => prev.map(m => m.id === msg.id ? {
                      ...m,
                      blocks: (m.blocks ?? []).map(b => b.id === blockId && b.type === "vega_chart"
                        ? { ...b, chart: { ...b.chart, ...patch } }
                        : b,
                      ),
                    } : m));
                  }}
                  usage={msg.usage}
                  model={model}
                />
              )
            ))}
          </div>
        )}
      </div>

      {systemPrompt && (
        <div className="flex justify-end px-4 py-1 shrink-0">
          <button
            onClick={() => setShowSystemPrompt(true)}
            className="text-[10px] text-primary/60 hover:text-primary flex items-center gap-1 transition-colors"
          >
            <FileText className="h-3 w-3" />
            Starting prompt
          </button>
        </div>
      )}

      {showSystemPrompt && systemPrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setShowSystemPrompt(false)}>
          <div className="bg-card rounded-lg shadow-xl border border-border w-full max-w-2xl max-h-[80vh] flex flex-col m-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <FileText className="h-4 w-4 text-primary" />
                Starting Prompt
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => navigator.clipboard.writeText(systemPrompt)}
                  className="p-1.5 text-muted-foreground hover:text-primary transition-colors rounded-md hover:bg-muted"
                  title="Copy to clipboard"
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => setShowSystemPrompt(false)}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
            <pre className="flex-1 overflow-auto p-4 text-xs font-mono text-foreground/80 leading-relaxed whitespace-pre-wrap break-words text-left">{systemPrompt}</pre>
          </div>
        </div>
      )}

      <ChatInput
        onSend={handleSend}
        onStop={handleStop}
        isLoading={isLoading}
        disabled={!hasApiKey}
        focused={isActive}
      />
    </div>
  );
}
