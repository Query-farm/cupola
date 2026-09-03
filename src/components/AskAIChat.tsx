import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { Sparkles, RotateCcw, Settings, FileText, Copy } from "lucide-react";
import * as Sentry from "@sentry/astro";
import { useSettings, DEFAULT_AI_MODEL } from "@/lib/settings";
import { engine, ui } from "@/lib/shell-bridge";
import { useEngineLifecycle } from "@/lib/use-engine-lifecycle";
import { getEngineInfo } from "@/lib/duckdb-engine";
import { DEFAULT_AI_MAX_TOKENS } from "@/lib/ai/model-limits";
import { toolInputLabel } from "@/lib/ai/tool-labels";
import type { CatalogData } from "@/lib/service";
import {
  runAgentTurn,
  buildSystemPrompt,
  executeListTables,
  executeListCatalogs,
  executeListCategories,
  executeDescribeFunction,
  TOOLS,
  CHART_TOOL,
  type MessageParam,
} from "@/lib/ai-agent";
import { executeRunSql, describeTableWithFallback, validateChartSpec, validateExtraData } from "@/lib/ai-tool-executor";
import { readRows } from "@/lib/duckdb-query";
import { sampleRowsForAI, QueryResultCache, executeReadQueryResults } from "@/lib/query-results";
import { cacheChartRows, cacheChartExtra, evictChartRows } from "@/lib/chart-rows-store";
import { compileChartSpec, renderChartToPng } from "./chat/chart-embed";
import type { ToolResult } from "@/lib/ai-agent";
import type { AgentUsage } from "@/lib/ai-usage";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
const uid = () => crypto.randomUUID();

import { ChatInput } from "./chat/ChatInput";
import { ChatMessageUser } from "./chat/ChatMessageUser";
import {
  ChatMessageAssistant,
  type ContentBlock,
  type ToolCallEntry,
} from "./chat/ChatMessageAssistant";
interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content?: string; // user messages only
  blocks?: ContentBlock[]; // assistant messages only
  isStreaming?: boolean;
  usage?: AgentUsage;
}

interface Props {
  catalogData?: CatalogData;
  attachedCatalogs?: CatalogData[];
  serviceUrl: string;
  catalogName: string;
  isActive?: boolean;
  /** Fired when a turn starts/ends so the tab bar can flag the running agent
   *  while the user is looking at another tab. */
  onBusyChange?: (busy: boolean) => void;
}

export function AskAIChat({ catalogData, attachedCatalogs = [], serviceUrl, isActive, onBusyChange }: Props) {
  const engineLifecycle = useEngineLifecycle();
  const { settings } = useSettings();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const agentMessages = useRef<MessageParam[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Installed by the ask_user tool for the life of one question. Takes the
  // chosen option and its index (index < 0 = cancelled) so the resolver can
  // mark its own block answered before handing the answer to the agent.
  const askUserResolve = useRef<((option: string, index: number) => void) | null>(null);
  // Groups this chat session's gen_ai spans in Sentry's Conversations view.
  const conversationIdRef = useRef<string>(crypto.randomUUID());
  // read_query_results backing store, scoped to THIS conversation. Previously a
  // module-level 3-entry LRU shared with the editor panel and terminal .ai
  // mode, so their queries evicted each other's result_ids.
  const resultCacheRef = useRef(new QueryResultCache());

  useEffect(() => {
    if (settings.aiTelemetry) Sentry.setConversationId(conversationIdRef.current);
    return () => Sentry.setConversationId(null);
  }, [settings.aiTelemetry]);

  useEffect(() => { onBusyChange?.(isLoading); }, [isLoading, onBusyChange]);

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
          const pendingAsk = askUserResolve.current;
          askUserResolve.current = null;
          pendingAsk("__cancelled__", -1);
        }
        abortRef.current.abort();
        engine.cancelQuery?.();
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
      pushChart: async (input: {
        sql: string;
        spec: Record<string, any>;
        title?: string;
        withPng?: boolean;
        extraData?: Array<{ name: string; sql: string }>;
      }) => {
        const { errors, sanitized } = validateChartSpec(input.spec);
        if (errors.length) throw new Error(`Invalid chart spec: ${errors.join("; ")}`);
        const extraVal = validateExtraData(input.extraData);
        if (extraVal.errors.length) throw new Error(`Invalid extraData: ${extraVal.errors.join("; ")}`);
        const cleanedExtras = extraVal.cleaned;
        const compileResult = await compileChartSpec(sanitized);
        if (compileResult.error) throw new Error(`Vega-Lite compile failed: ${compileResult.error}`);
        if (!engine.query) throw new Error("DuckDB not ready");
        const rows = await readRows(input.sql);
        if (rows === null) throw new Error("Query failed or returned no rows");
        const chartId = uid();
        const columns = rows.length ? Object.keys(rows[0]) : [];
        cacheChartRows(chartId, rows, columns);

        // Fetch + cache extras (parallel via Promise.all for tidiness;
        // DuckDB serializes on its single connection anyway).
        const extraRowsByName: Record<string, Record<string, any>[]> = {};
        const extraMeta: Array<{ name: string; sql: string; rowCount: number; columns: string[] }> = [];
        for (const ex of cleanedExtras) {
          const exRows = await readRows(ex.sql);
          if (exRows === null) throw new Error(`extraData "${ex.name}" query failed`);
          extraRowsByName[ex.name] = exRows;
          const exCols = exRows.length ? Object.keys(exRows[0]) : [];
          cacheChartExtra(chartId, ex.name, exRows, exCols);
          extraMeta.push({ name: ex.name, sql: ex.sql, rowCount: exRows.length, columns: exCols });
        }

        const msgId = crypto.randomUUID();
        const blockId = uid();
        setMessages((prev) => [...prev, {
          id: msgId, role: "assistant", isStreaming: false,
          blocks: [{
            type: "vega_chart" as const,
            id: blockId,
            chart: {
              chartId, sql: input.sql, spec: sanitized, title: input.title,
              rowCount: rows.length, columns,
              extraSources: extraMeta.length ? extraMeta : undefined,
              fetchedAt: Date.now(),
              warnings: compileResult.warnings.length ? compileResult.warnings : undefined,
            },
          }],
        }]);
        // Optionally exercise the PNG path with extras included.
        let pngBytes: number | undefined;
        let pngMediaType: string | undefined;
        if (input.withPng) {
          const png = await renderChartToPng(
            sanitized,
            rows,
            cleanedExtras.length ? extraRowsByName : undefined,
          );
          if ("data" in png) {
            pngBytes = png.data.length;
            pngMediaType = png.mediaType;
          }
        }
        return {
          messageId: msgId,
          blockId,
          chartId,
          warnings: compileResult.warnings,
          extras: extraMeta.map((e) => ({ name: e.name, rowCount: e.rowCount, columns: e.columns })),
          pngBytes,
          pngMediaType,
        };
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
    const workspaceId = getSetting("anthropicWorkspaceId") || "";
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

    // Add placeholder assistant message with thinking indicator. The SAME
    // block object seeds the local `blocks` array below — they used to
    // disagree, so the first updateBlocks() of the turn silently wiped this
    // indicator (see the onRetry path, which can fire before any content).
    const assistantId = crypto.randomUUID();
    const seedThinking: ContentBlock = { type: "thinking", id: uid(), label: "Thinking" };
    setMessages(prev => [...prev, {
      id: assistantId, role: "assistant",
      blocks: [seedThinking],
      isStreaming: true,
    }]);

    setIsLoading(true);
    abortRef.current = new AbortController();

    // hasChartTool = true: include render_chart capability in the prompt
    // guidance (and CHART_TOOL in the tool list below). Terminal `.ai` mode
    // passes a different surface and would set this false.
    const catalogs = [catalogData, ...attachedCatalogs, ui.memoryCatalog]
      .filter((value): value is CatalogData => Boolean(value));
    const systemPrompt = buildSystemPrompt(catalogData, getEngineInfo(), catalogs.slice(1), true);
    const model = getSetting("aiModel") || DEFAULT_AI_MODEL;
    const maxRounds = getSetting("aiMaxToolRounds") || 20;
    const maxTokens = getSetting("aiMaxTokens") || DEFAULT_AI_MAX_TOKENS;

    // Mutable blocks array — updated in callbacks, then set into state
    let blocks: ContentBlock[] = [seedThinking];
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

    // Replace whatever indicator is showing with a fresh one. Every silent
    // window in the turn ends with a call to this: the panel must never be
    // waiting on the model or a tool without saying so.
    const showThinking = (label: string) => {
      removeThinking();
      blocks = [...blocks, { type: "thinking", id: uid(), label }];
      updateBlocks(blocks);
    };

    /**
     * Race a promise against an AbortSignal. When the signal aborts we
     * fire engine.cancelQuery to interrupt the haybarn worker (best-effort)
     * and reject with AbortError so the agent loop bails out — even if the
     * underlying engine.query promise hasn't settled yet.
     */
    function withAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
      if (!signal) return p;
      return new Promise<T>((resolve, reject) => {
        if (signal.aborted) {
          engine.cancelQuery?.();
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        const onAbort = () => {
          engine.cancelQuery?.();
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
    // Returns ToolResult, not string: render_chart replies with the multi-part
    // [text, image] form so the model can see the chart it just drew.
    const executeTool = async (name: string, input: any, signal?: AbortSignal): Promise<ToolResult> => {
      if (name === "run_sql") {
        const queryFn = engine.query;
        if (!queryFn) throw new Error("DuckDB shell not initialized — open SQL Shell first");
        const lastUserMsg = agentMessages.current.filter(m => m.role === "user").pop();
        const userQuestion = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : undefined;

        // Subscribe to engine.progress while the query runs so the tool
        // block can render its progress bar. Restored in onEnd.
        const prevProgress = engine.progress;
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
          { query: (sql) => withAbort(queryFn(sql), signal), resultCache: resultCacheRef.current },
          {
            onStart: () => { engine.progress = updateProgress; },
            onEnd: () => { engine.progress = prevProgress; },
            onOutcome: async (out) => {
              if (out.kind === "error") {
                ui.addQueryHistoryEntry?.({
                  id: Date.now(), timestamp: Date.now(), sql: input.sql,
                  executionTimeMs: out.elapsedMs, success: false, error: out.errMsg, userQuestion,
                });
                return;
              }
              if (out.kind === "empty") {
                ui.addQueryHistoryEntry?.({
                  id: Date.now(), timestamp: Date.now(), sql: input.sql,
                  executionTimeMs: out.elapsedMs, success: true, rowCount: 0, userQuestion,
                });
                pendingDisplayResult = { columns: [], rows: [], rowCount: 0, showing: 0, message: "Query executed successfully" };
                // COMMENT ON returns empty — refresh sidebar so comments appear.
                if (/COMMENT\s+ON/i.test(input.sql)) await ui.refreshMemoryTables?.();
                return;
              }
              if (out.kind === "ddl") {
                ui.addQueryHistoryEntry?.({
                  id: Date.now(), timestamp: Date.now(), sql: input.sql,
                  executionTimeMs: out.elapsedMs, success: true, rowCount: 0, userQuestion,
                });
                pendingDisplayResult = { columns: [], rows: [], rowCount: 0, showing: 0, message: "Query executed successfully" };
                await ui.refreshMemoryTables?.();
                const createMatch = input.sql.match(/CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?(?:TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:memory\.)?(?:(\w+)\.)?(\w+)/i);
                if (createMatch) {
                  const schema = createMatch[1] || "main";
                  const name = createMatch[2];
                  ui.navigateToSelection?.({ type: "table", name, schema, catalog: "memory" });
                }
                const dropMatch = input.sql.match(/DROP\s+(?:TABLE|VIEW|SCHEMA)\s+(?:IF\s+EXISTS\s+)?(?:memory\.)?(?:(\w+)\.)?(\w+)/i);
                if (dropMatch) {
                  const isSchemaLevel = /DROP\s+SCHEMA/i.test(input.sql);
                  if (isSchemaLevel) {
                    ui.navigateToSelection?.({ type: "catalog", name: "memory", catalog: "memory" });
                  } else {
                    const schema = dropMatch[1] || "main";
                    ui.navigateToSelection?.({ type: "schema", name: schema, schema, catalog: "memory" });
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
              ui.addQueryHistoryEntry?.({
                id: Date.now(), timestamp: Date.now(), sql: input.sql,
                executionTimeMs: out.elapsedMs, success: true, rowCount: out.table.numRows, userQuestion,
              });
            },
          },
        );
      }
      if (name === "read_query_results") {
        return executeReadQueryResults(resultCacheRef.current, input.result_id, input.offset, input.limit);
      }
      if (name === "list_catalogs") {
        return executeListCatalogs(catalogs, input);
      }
      if (name === "list_tables") {
        return executeListTables(catalogs, input);
      }
      if (name === "list_categories") {
        return executeListCategories(catalogs, input);
      }
      if (name === "describe_table") {
        const queryFn = engine.query;
        if (!queryFn) throw new Error("DuckDB shell not initialized");
        return describeTableWithFallback(catalogs, { query: queryFn }, input);
      }
      if (name === "describe_function") {
        return executeDescribeFunction(catalogs, input);
      }
      if (name === "ask_user") {
        const blockId = uid();
        return new Promise<string>((resolve) => {
          // Mark the block answered in the LOCAL array, not just in message
          // state: every later updateBlocks() overwrites state from this
          // array, so a state-only edit was reverted by the next callback and
          // the answered question went back to offering live buttons.
          askUserResolve.current = (option, index) => {
            blocks = blocks.map(b => b.id === blockId && b.type === "ask_user"
              ? { ...b, askUser: { ...b.askUser, selectedIndex: index, resolved: true } }
              : b);
            updateBlocks(blocks);
            resolve(index < 0 ? "__cancelled__" : `User selected: ${option}`);
          };
          // Remove thinking and add ask_user as an inline block
          removeThinking();
          blocks.push({ type: "ask_user", id: blockId, askUser: { question: input.question, options: input.options || [], resolved: false } });
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
        // Validate extraData (multi-source). Each entry must have a unique
        // name matching /^[a-zA-Z_][a-zA-Z0-9_]*$/, not collide with the
        // primary's reserved CUPOLA_DATA_NAME, with non-empty SQL.
        const extraVal = validateExtraData(input.extraData);
        if (extraVal.errors.length) {
          return JSON.stringify({ ok: false, error: `Invalid extraData: ${extraVal.errors.join("; ")}` });
        }
        const cleanedExtras = extraVal.cleaned;
        // Compile the spec to catch warnings (incompatible shape on circle,
        // log scale with zeros, etc.) BEFORE we run the SQL. If compile
        // throws, the spec is broken and the model needs to fix it; return
        // an error so the agent self-corrects.
        const compileResult = await compileChartSpec(sanitized);
        if (compileResult.error) {
          return JSON.stringify({ ok: false, error: `Vega-Lite compile failed: ${compileResult.error}` });
        }
        if (!engine.query) {
          return JSON.stringify({ ok: false, error: "DuckDB not ready — open the SQL Shell first." });
        }
        const rows = await readRows(input.sql);
        if (rows === null) {
          const raw = await engine.query(input.sql);
          if (!raw.ok) {
            return JSON.stringify({ ok: false, error: raw.error || "Query failed" });
          }
          return JSON.stringify({ ok: false, error: "Query returned no rows — nothing to chart." });
        }
        const columns = rows.length ? Object.keys(rows[0]) : [];

        // Fetch each extra dataset. Bail on first error — the agent sees
        // which dataset failed and can fix the SQL. (We don't try to
        // render with a partial set of datasets — Vega-Lite would error
        // on the missing reference anyway.)
        const extraRowsByName: Record<string, Record<string, any>[]> = {};
        const extraMeta: Array<{ name: string; sql: string; rowCount: number; columns: string[] }> = [];
        for (const ex of cleanedExtras) {
          const exRows = await readRows(ex.sql);
          if (exRows === null) {
            const raw = await engine.query(ex.sql);
            const msg = !raw.ok ? raw.error : "Query returned no rows";
            return JSON.stringify({ ok: false, error: `extraData "${ex.name}" failed: ${msg || "Query failed"}` });
          }
          extraRowsByName[ex.name] = exRows;
          extraMeta.push({
            name: ex.name,
            sql: ex.sql,
            rowCount: exRows.length,
            columns: exRows.length ? Object.keys(exRows[0]) : [],
          });
        }

        // Render the PNG FIRST — smoke test + agent feedback. With extras
        // included so the headless render exercises the full multi-source
        // spec the inline view will use.
        const wantFeedback = getSetting("aiChartFeedback") !== false;
        let png: { data: string; mediaType: "image/png" } | null = null;
        if (wantFeedback) {
          const result = await renderChartToPng(
            sanitized,
            rows,
            cleanedExtras.length ? extraRowsByName : undefined,
          );
          if ("error" in result) {
            return JSON.stringify({ ok: false, error: `Chart render failed: ${result.error}. Fix the spec and call render_chart again.` });
          }
          png = result;
        }

        const chartId = uid();
        cacheChartRows(chartId, rows, columns);
        for (const ex of extraMeta) {
          cacheChartExtra(chartId, ex.name, extraRowsByName[ex.name], ex.columns);
        }
        removeThinking();
        const lastBlock = blocks[blocks.length - 1];
        if (lastBlock?.type === "vega_chart" && lastBlock.chart.pending) {
          evictChartRows(lastBlock.chart.chartId);
          blocks = blocks.slice(0, -1);
        }
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
            extraSources: extraMeta.length ? extraMeta : undefined,
            fetchedAt: Date.now(),
            warnings: compileResult.warnings.length ? compileResult.warnings : undefined,
            pending: true,
          },
        }];
        updateBlocks(blocks);

        // Build the text part of the tool_result. Include a sample of each
        // extra so the agent knows what shape it has — same treatment as
        // the primary, just at a lower per-dataset budget.
        const textPart = JSON.stringify({
          ok: true,
          row_count: rows.length,
          columns,
          // Cap each cell — raw GEOMETRY/BLOB values (Uint8Array) would
          // otherwise JSON-serialize as per-byte objects and blow the context.
          sample: sampleRowsForAI(rows, 3),
          ...(extraMeta.length
            ? {
                extras: extraMeta.map((ex) => ({
                  name: ex.name,
                  row_count: ex.rowCount,
                  columns: ex.columns,
                  sample: sampleRowsForAI(extraRowsByName[ex.name], 3),
                })),
              }
            : {}),
          ...(compileResult.warnings.length ? { warnings: compileResult.warnings } : {}),
        });

        if (png) {
          const toolResult: ToolResult = [
            { type: "text", text: textPart },
            { type: "image", source: { type: "base64", media_type: "image/png", data: png.data } },
          ];
          return toolResult;
        }
        return textPart;
      }
      return JSON.stringify({ error: `Unknown tool: ${name}` });
    };

    try {
      await runAgentTurn(
        { apiKey, workspaceId }, model, agentMessages.current, systemPrompt, executeTool,
        {
          onText: (chunk) => {
            removeThinking();
            const idx = ensureTextBlock();
            const textBlock = blocks[idx] as { type: "text"; content: string };
            blocks = blocks.map((b, i) => i === idx ? { ...b, content: textBlock.content + chunk } : b);
            updateBlocks(blocks);
          },
          // The model is streaming this call's arguments. onToolCall is still
          // one whole SSE stream away, so without this the panel would sit
          // blank through a long SQL statement or Vega spec.
          onToolInputStart: (name) => showThinking(toolInputLabel(name)),
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
            // The agent has finished its turn. Reveal every pending chart
            // block — whatever spec the agent settled on is what the user
            // should see. If the agent iterated through several charts in
            // this turn, all of them become visible at this point (they
            // were hidden behind "Evaluating chart…" placeholders).
            blocks = blocks.map((b) =>
              b.type === "vega_chart" && b.chart.pending
                ? { ...b, chart: { ...b.chart, pending: false } }
                : b,
            );
            updateBlocks(blocks);
            updateAssistant({ isStreaming: false, usage });
          },
          // message === null means the countdown ended and the request is
          // being retried NOW — the slowest, least visible part of a bad
          // network day. Fall back to a plain indicator instead of clearing
          // it, which used to leave the panel blank for the whole retry.
          onRetry: (message) => showThinking(message ? message.replace("...", "") : "Thinking"),
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
        maxTokens,
      );
    } catch (err: any) {
      removeThinking();
      // Mark any still-executing tool calls as stopped and reveal any
      // pending chart blocks — the agent isn't going to call render_chart
      // again from this turn, so show whatever the user has so they
      // aren't left looking at "Evaluating chart…" forever.
      blocks = blocks.map(b => {
        if (b.type === "tool_call" && b.toolCall.isExecuting) {
          return { ...b, toolCall: { ...b.toolCall, isExecuting: false, error: "Cancelled" } };
        }
        if (b.type === "vega_chart" && b.chart.pending) {
          return { ...b, chart: { ...b.chart, pending: false } };
        }
        // An unanswered question outlives the turn that asked it. Nothing is
        // listening for the click any more, so retire the buttons instead of
        // leaving them looking live.
        if (b.type === "ask_user" && !b.askUser.resolved) {
          return { ...b, askUser: { ...b.askUser, resolved: true } };
        }
        return b;
      });
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
  }, [catalogData, attachedCatalogs, serviceUrl, settings]);

  // The resolver (installed by the ask_user tool) owns marking the block
  // answered — it can reach the turn's live block array, which this callback
  // cannot.
  const handleAskUserSelect = useCallback((option: string, index: number) => {
    const resolve = askUserResolve.current;
    askUserResolve.current = null;
    resolve?.(option, index);
  }, []);

  const handleNewConversation = () => {
    setMessages([]);
    agentMessages.current = [];
    conversationIdRef.current = crypto.randomUUID();
    // New conversation → the old result_ids are unreachable; free the rows.
    resultCacheRef.current.clear();
    if (settings.aiTelemetry) Sentry.setConversationId(conversationIdRef.current);
  };

  const handleStop = () => {
    // Release a pending ask_user FIRST. That promise is not raced against the
    // abort signal, so an unanswered question left the agent parked on an
    // await that nothing could ever settle: the turn never unwound, the
    // finally never ran, and the panel showed "Stop" forever.
    const pendingAsk = askUserResolve.current;
    askUserResolve.current = null;
    pendingAsk?.("__cancelled__", -1);
    abortRef.current?.abort();
    // Also cancel any running DuckDB query
    engine.cancelQuery?.();
  };

  // Starter questions

  const hasApiKey = !!getSetting("anthropicApiKey");
  const hasMessages = messages.length > 0;
  const model = getSetting("aiModel") || DEFAULT_AI_MODEL;
  const [showSystemPrompt, setShowSystemPrompt] = useState(false);
  // Pass hasChartTool=true so the preview shown to the user matches what
  // the agent actually sees at runtime (see line 128).
  const systemPrompt = useMemo(() => catalogData
    ? buildSystemPrompt(catalogData, getEngineInfo(), [...attachedCatalogs, ...(ui.memoryCatalog ? [ui.memoryCatalog] : [])], true)
    : null, [catalogData, attachedCatalogs, serviceUrl]);

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

      {systemPrompt && (
        <Dialog open={showSystemPrompt} onOpenChange={setShowSystemPrompt}>
          <DialogContent className="!max-w-2xl max-h-[80vh] grid grid-rows-[auto_minmax(0,1fr)] gap-0 p-0 overflow-hidden">
            <DialogHeader className="flex-row items-center gap-2 border-b border-border px-4 py-3 pr-12">
              <FileText className="h-4 w-4 text-primary shrink-0" aria-hidden="true" />
              <div className="min-w-0">
                <DialogTitle>Starting Prompt</DialogTitle>
                <DialogDescription className="sr-only">
                  The instructions and catalog context sent to the AI at the start of this conversation.
                </DialogDescription>
              </div>
              <button
                onClick={() => navigator.clipboard.writeText(systemPrompt)}
                className="ml-auto p-1.5 text-muted-foreground hover:text-primary transition-colors rounded-md hover:bg-muted"
                title="Copy to clipboard"
                aria-label="Copy starting prompt"
              >
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </DialogHeader>
            <pre className="overflow-auto p-4 text-xs font-mono text-foreground/80 leading-relaxed whitespace-pre-wrap break-words text-left">{systemPrompt}</pre>
          </DialogContent>
        </Dialog>
      )}

      <ChatInput
        onSend={handleSend}
        onStop={handleStop}
        isLoading={isLoading}
        disabled={!hasApiKey || engineLifecycle.status !== "ready"}
        focused={isActive}
      />
    </div>
  );
}
