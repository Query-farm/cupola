/**
 * Conversational "Ask AI" side panel docked in the Query Editor.
 *
 * Unlike the standalone Ask AI tab (AskAIChat), this is SQL-focused (no
 * charts), keeps ONE conversation per editor sub-tab (keyed by docId in an
 * internal Map so threads survive sub-tab switches and panel open/close), and
 * forks every query it runs into the editor's results grid. SQL the assistant
 * produces can be applied straight into the editor.
 *
 * The agent machine mirrors AskAIChat.handleSend; kept self-contained
 * (reusing the chat rendering components + agent core) rather than refactoring
 * the chart-coupled AskAIChat into a shared hook.
 */
import { useReducer, useRef, useEffect, useCallback } from "react";
import { Sparkles, RotateCcw, X } from "lucide-react";
import * as Sentry from "@sentry/astro";
import { useSettings, DEFAULT_AI_MODEL } from "@/lib/settings";
import { bridge } from "@/lib/shell-bridge";
import type { CatalogData } from "@/lib/service";
import {
  runAgentTurn,
  buildSystemPrompt,
  executeListTables,
  executeReadQueryResults,
  TOOLS,
  type MessageParam,
} from "@/lib/ai-agent";
import { executeRunSql, describeTableWithFallback } from "@/lib/ai-tool-executor";
import { ChatInput } from "@/components/chat/ChatInput";
import { ChatMessageUser } from "@/components/chat/ChatMessageUser";
import {
  ChatMessageAssistant,
  type ContentBlock,
  type ToolCallEntry,
} from "@/components/chat/ChatMessageAssistant";
import { EditorSqlToolCallBlock, SqlApplyBar, type SqlApplyActions } from "./EditorSqlToolCallBlock";
import { extractSql } from "@/lib/ai/extract-sql";
import type { ResultState } from "./EditorResultsPane";

const uid = () => crypto.randomUUID();

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content?: string;
  blocks?: ContentBlock[];
  isStreaming?: boolean;
  usage?: { inputTokens: number; outputTokens: number };
}

interface ConversationState {
  messages: ChatMessage[];
  agentMessages: MessageParam[];
  isLoading: boolean;
  abort: AbortController | null;
  askUserResolve: ((value: string) => void) | null;
  conversationId: string;
  /** Last current-query snapshot sent as context, so we only resend on change. */
  sentContext: string | null;
}

interface Props {
  /** Active editor doc id — the conversation key. */
  docId: string;
  catalogData: CatalogData;
  serviceUrl: string;
  /** Live current query (selection → statement → doc) for per-turn context. */
  getCurrentSql: () => string;
  apply: SqlApplyActions;
  /** Shared with manual runs so the latest run (AI or manual) wins the grid. */
  runIdRef: React.MutableRefObject<number>;
  setActiveResult: (docId: string, patch: Partial<ResultState>) => void;
  onClose: () => void;
}

export function EditorAiPanel({ docId, catalogData, serviceUrl, getCurrentSql, apply, runIdRef, setActiveResult, onClose }: Props) {
  const { settings } = useSettings();
  const convos = useRef<Map<string, ConversationState>>(new Map());
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const getConvo = useCallback((id: string): ConversationState => {
    let c = convos.current.get(id);
    if (!c) {
      c = { messages: [], agentMessages: [], isLoading: false, abort: null, askUserResolve: null, conversationId: uid(), sentContext: null };
      convos.current.set(id, c);
    }
    return c;
  }, []);

  const convo = getConvo(docId);

  // Test hook: push messages into the active conversation without the network.
  // Used by tests/editor-ai-panel.spec.ts (mirrors AskAIChat's __cupolaChartTest).
  const docIdRef = useRef(docId);
  docIdRef.current = docId;
  useEffect(() => {
    (window as any).__cupolaEditorAiTest = {
      pushAssistantSql: (opts: { sql: string; columns?: string[]; rows?: Record<string, any>[] }) => {
        const c = getConvo(docIdRef.current);
        const rows = opts.rows ?? [];
        c.messages = [...c.messages, {
          id: uid(), role: "assistant", isStreaming: false,
          blocks: [{ type: "tool_call", id: uid(), toolCall: {
            name: "run_sql", input: { sql: opts.sql }, isExecuting: false,
            displayResult: { columns: opts.columns ?? [], rows, rowCount: rows.length, showing: rows.length },
          } }],
        }];
        bump();
      },
      pushUser: (text: string) => {
        const c = getConvo(docIdRef.current);
        c.messages = [...c.messages, { id: uid(), role: "user", content: text }];
        bump();
      },
    };
    return () => { delete (window as any).__cupolaEditorAiTest; };
  }, [getConvo]);

  // Abort every in-flight turn on unmount (leaving the Query Editor tab).
  useEffect(() => {
    return () => {
      for (const c of convos.current.values()) {
        c.abort?.abort();
        c.askUserResolve?.("__cancelled__");
      }
      bridge.cancelQuery?.();
    };
  }, []);

  // Auto-scroll to bottom on new content for the active conversation.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  const getSetting = (key: string) => {
    try {
      const stored = localStorage.getItem("vgi-frontend-settings");
      if (stored) return JSON.parse(stored)[key];
    } catch {}
    return (settings as any)[key];
  };

  const send = useCallback(async (text: string) => {
    const apiKey = getSetting("anthropicApiKey") || "";
    const c = getConvo(docId);
    const myDoc = docId; // capture: stays correct even if the user switches sub-tabs mid-turn

    if (!apiKey) {
      c.messages = [...c.messages, { id: uid(), role: "assistant", blocks: [{ type: "text", id: uid(), content: "To use Ask AI, add your Anthropic API key in **Settings**." }] }];
      bump();
      return;
    }

    // Inject the current editor query as context only on the first turn or
    // when it changed since last send (keeps history compact).
    const liveSql = getCurrentSql().trim();
    let userContent = text;
    if (liveSql && liveSql !== c.sentContext) {
      userContent = `Current editor query:\n\`\`\`sql\n${liveSql}\n\`\`\`\n\n${text}`;
      c.sentContext = liveSql;
    }

    c.messages = [...c.messages, { id: uid(), role: "user", content: text }];
    c.agentMessages.push({ role: "user", content: userContent });

    const assistantId = uid();
    c.messages = [...c.messages, { id: assistantId, role: "assistant", blocks: [{ type: "thinking", id: uid(), label: "Thinking" }], isStreaming: true }];
    c.isLoading = true;
    c.abort = new AbortController();
    bump();

    if (settings.aiTelemetry) Sentry.setConversationId(c.conversationId);

    const systemPrompt = buildSystemPrompt(catalogData, serviceUrl, bridge.memoryCatalog, false) +
      "\n\nYou are an AI assistant embedded in a SQL editor. The user is editing SQL in the adjacent pane. Be concise. When you run a query, its results appear in the editor's results grid. When you produce a final query for the user, run it with run_sql so it can be applied to the editor. Do not produce charts.";
    const model = getSetting("aiModel") || DEFAULT_AI_MODEL;
    const maxRounds = getSetting("aiMaxToolRounds") || 20;

    let blocks: ContentBlock[] = [];
    let pendingDisplayResult: import("@/components/chat/ChatMessageAssistant").ToolCallDisplayResult | undefined;

    const updateBlocks = (next: ContentBlock[]) => {
      blocks = next;
      c.messages = c.messages.map((m) => (m.id === assistantId ? { ...m, blocks: [...blocks] } : m));
      bump();
    };
    const updateAssistant = (patch: Partial<ChatMessage>) => {
      c.messages = c.messages.map((m) => (m.id === assistantId ? { ...m, ...patch } : m));
      bump();
    };
    const ensureTextBlock = (): number => {
      const last = blocks[blocks.length - 1];
      if (last?.type === "text") return blocks.length - 1;
      blocks = [...blocks, { type: "text", id: uid(), content: "" }];
      return blocks.length - 1;
    };
    const removeThinking = () => { blocks = blocks.filter((b) => b.type !== "thinking"); };

    function withAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
      if (!signal) return p;
      return new Promise<T>((resolve, reject) => {
        if (signal.aborted) { bridge.cancelQuery?.(); reject(new DOMException("Aborted", "AbortError")); return; }
        const onAbort = () => { bridge.cancelQuery?.(); reject(new DOMException("Aborted", "AbortError")); };
        signal.addEventListener("abort", onAbort, { once: true });
        p.then((v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
               (e) => { signal.removeEventListener("abort", onAbort); reject(e); });
      });
    }

    const executeTool = async (name: string, input: any, signal?: AbortSignal): Promise<any> => {
      if (name === "run_sql") {
        const queryFn = bridge.query;
        if (!queryFn) throw new Error("DuckDB engine is still starting — try again in a moment.");
        const userQuestion = text;
        // Shared run token so the latest run (AI or manual) wins the grid.
        const myRun = ++runIdRef.current;
        const setGrid = (patch: Partial<ResultState>) => { if (myRun === runIdRef.current) setActiveResult(myDoc, patch); };
        setGrid({ running: true, ran: true, error: null });

        const prevProgress = bridge.progress;
        const updateProgress = (pct: number) => {
          blocks = blocks.map((b) => (b.type === "tool_call" && b.toolCall.isExecuting ? { ...b, toolCall: { ...b.toolCall, progress: pct } } : b));
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
                bridge.addQueryHistoryEntry?.({ id: Date.now(), timestamp: Date.now(), sql: input.sql, executionTimeMs: out.elapsedMs, success: false, error: out.errMsg, userQuestion });
                setGrid({ running: false, ok: false, error: out.errMsg, table: null });
                return;
              }
              if (out.kind === "empty" || out.kind === "ddl") {
                bridge.addQueryHistoryEntry?.({ id: Date.now(), timestamp: Date.now(), sql: input.sql, executionTimeMs: out.elapsedMs, success: true, rowCount: 0, userQuestion });
                pendingDisplayResult = { columns: [], rows: [], rowCount: 0, showing: 0, message: "Query executed successfully" };
                setGrid({ running: false, ok: true, error: null, table: null, rowCount: 0, elapsedMs: out.elapsedMs, ran: true });
                if (out.kind === "ddl" || /COMMENT\s+ON/i.test(input.sql)) {
                  await bridge.refreshMemoryTables?.();
                  bridge.onAttachedCatalogsChanged?.();
                }
                return;
              }
              // table
              const parsed = JSON.parse(out.json);
              pendingDisplayResult = { columns: parsed.columns, rows: parsed.rows, rowCount: parsed.row_count, showing: parsed.showing };
              bridge.addQueryHistoryEntry?.({ id: Date.now(), timestamp: Date.now(), sql: input.sql, executionTimeMs: out.elapsedMs, success: true, rowCount: out.table.numRows, userQuestion });
              setGrid({ running: false, ok: true, error: null, table: out.table, rowCount: out.table.numRows, elapsedMs: out.elapsedMs, ran: true });
            },
          },
        );
      }
      if (name === "read_query_results") return executeReadQueryResults(input.result_id, input.offset, input.limit);
      if (name === "list_tables") return executeListTables(catalogData);
      if (name === "describe_table") {
        const queryFn = bridge.query;
        if (!queryFn) throw new Error("DuckDB engine not ready");
        return describeTableWithFallback(catalogData, { query: queryFn }, input);
      }
      if (name === "ask_user") {
        return new Promise<string>((resolve) => {
          c.askUserResolve = resolve;
          removeThinking();
          blocks.push({ type: "ask_user", id: uid(), askUser: { question: input.question, options: input.options || [], resolved: false } });
          updateBlocks(blocks);
        });
      }
      return JSON.stringify({ error: `Unknown tool: ${name}` });
    };

    try {
      await runAgentTurn(
        apiKey, model, c.agentMessages, systemPrompt, executeTool,
        {
          onText: (chunk) => {
            removeThinking();
            const idx = ensureTextBlock();
            const tb = blocks[idx] as { type: "text"; content: string };
            blocks = blocks.map((b, i) => (i === idx ? { ...b, content: tb.content + chunk } : b));
            updateBlocks(blocks);
          },
          onToolCall: (n, inp) => {
            removeThinking();
            const tc: ToolCallEntry = { name: n, input: inp, isExecuting: true };
            blocks = [...blocks, { type: "tool_call", id: uid(), toolCall: tc }];
            updateBlocks(blocks);
          },
          onToolResult: (_n, summary) => {
            const revIdx = [...blocks].reverse().findIndex((b) => b.type === "tool_call" && b.toolCall.isExecuting);
            if (revIdx >= 0) {
              const actualIdx = blocks.length - 1 - revIdx;
              const block = blocks[actualIdx] as { type: "tool_call"; toolCall: ToolCallEntry };
              const isErr = summary.startsWith("Error:");
              blocks = blocks.map((b, i) => (i === actualIdx ? { ...b, toolCall: { ...block.toolCall, displayResult: pendingDisplayResult, error: isErr ? summary.slice(7) : undefined, isExecuting: false, progress: undefined } } : b));
              pendingDisplayResult = undefined;
            }
            blocks = [...blocks, { type: "thinking", id: uid(), label: "Thinking" }];
            updateBlocks(blocks);
          },
          onDone: (usage) => { removeThinking(); updateBlocks(blocks); updateAssistant({ isStreaming: false, usage }); },
          onRetry: (message) => {
            removeThinking();
            if (message) blocks = [...blocks, { type: "thinking", id: uid(), label: message.replace("...", "") }];
            updateBlocks(blocks);
          },
          onError: (error) => {
            removeThinking();
            const idx = ensureTextBlock();
            const tb = blocks[idx] as { type: "text"; content: string };
            blocks = blocks.map((b, i) => (i === idx ? { ...b, content: tb.content + (tb.content ? "\n\n" : "") + `**Error:** ${error}` } : b));
            updateBlocks(blocks);
          },
        },
        c.abort.signal, maxRounds, TOOLS,
      );
    } catch (err: any) {
      removeThinking();
      blocks = blocks.map((b) => (b.type === "tool_call" && b.toolCall.isExecuting ? { ...b, toolCall: { ...b.toolCall, isExecuting: false, error: "Cancelled" } } : b));
      const isCancel = err?.name === "AbortError" || /cancell?ed/i.test(err?.message || "");
      if (!isCancel) {
        const idx = ensureTextBlock();
        const tb = blocks[idx] as { type: "text"; content: string };
        blocks = blocks.map((b, i) => (i === idx ? { ...b, content: tb.content + (tb.content ? "\n\n" : "") + `**Error:** ${err.message}` } : b));
        Sentry.captureException(err, { tags: { component: "ai-agent", path: "editor-panel" } });
      } else {
        blocks = [...blocks, { type: "text", id: uid(), content: "*(Stopped)*" }];
      }
      updateBlocks(blocks);
      updateAssistant({ isStreaming: false });
    } finally {
      c.isLoading = false;
      c.abort = null;
      bump();
    }
  }, [docId, catalogData, serviceUrl, settings, getCurrentSql, getConvo, apply, runIdRef, setActiveResult]);

  const stop = useCallback(() => {
    const c = convos.current.get(docId);
    if (c?.askUserResolve) { c.askUserResolve("__cancelled__"); c.askUserResolve = null; }
    c?.abort?.abort();
    bridge.cancelQuery?.();
  }, [docId]);

  const handleAskUserSelect = useCallback((option: string, _index: number) => {
    const c = convos.current.get(docId);
    if (!c) return;
    c.messages = c.messages.map((m) => {
      if (!m.blocks?.some((b) => b.type === "ask_user" && !b.askUser.resolved)) return m;
      return { ...m, blocks: m.blocks.map((b) => (b.type === "ask_user" && !b.askUser.resolved ? { ...b, askUser: { ...b.askUser, selectedIndex: _index, resolved: true } } : b)) };
    });
    bump();
    c.askUserResolve?.(`User selected: ${option}`);
    c.askUserResolve = null;
  }, [docId]);

  const handleNew = useCallback(() => {
    const c = convos.current.get(docId);
    if (c) { c.abort?.abort(); convos.current.set(docId, { messages: [], agentMessages: [], isLoading: false, abort: null, askUserResolve: null, conversationId: uid(), sentContext: null }); bump(); }
  }, [docId]);

  const hasApiKey = !!getSetting("anthropicApiKey");
  const model = getSetting("aiModel") || DEFAULT_AI_MODEL;

  const renderSqlToolCall = useCallback(
    (tc: ToolCallEntry, onCancel?: () => void) => <EditorSqlToolCallBlock toolCall={tc} onCancel={onCancel} apply={apply} />,
    [apply],
  );

  return (
    <div className="flex flex-col h-full border-l border-border bg-background" data-testid="editor-ai-panel">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border shrink-0">
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Sparkles className="h-3.5 w-3.5 text-accent" /> Ask AI
        </span>
        <div className="flex items-center gap-1">
          <button onClick={handleNew} className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1 transition-colors px-1.5 py-0.5" title="New conversation">
            <RotateCcw className="h-3 w-3" /> New
          </button>
          <button onClick={onClose} className="p-1 text-muted-foreground hover:text-foreground transition-colors" title="Close Ask AI" aria-label="Close Ask AI panel">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
        {convo.messages.length === 0 ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground pt-2">
            <Sparkles className="h-3.5 w-3.5 text-accent shrink-0" />
            {hasApiKey ? "Ask about your data, or to write/explain a query. Queries it runs appear in the results grid." : "Add your Anthropic API key in Settings to use Ask AI."}
          </div>
        ) : (
          convo.messages.map((msg) =>
            msg.role === "user" ? (
              <ChatMessageUser key={msg.id} content={msg.content || ""} />
            ) : (
              <AssistantWithApply key={msg.id} msg={msg} model={model} apply={apply}
                renderSqlToolCall={renderSqlToolCall}
                onAskUserSelect={handleAskUserSelect}
                onCancel={msg.isStreaming ? stop : undefined} />
            )
          )
        )}
      </div>

      <ChatInput onSend={send} onStop={stop} isLoading={convo.isLoading} disabled={!hasApiKey} focused placeholder="Ask AI about your query…" />
    </div>
  );
}

/** Assistant message + a trailing apply bar when it proposed SQL in prose
 *  (a ```sql fence in its final text) but did not run it as a tool call. */
function AssistantWithApply({ msg, model, apply, renderSqlToolCall, onAskUserSelect, onCancel }: {
  msg: ChatMessage;
  model: string;
  apply: SqlApplyActions;
  renderSqlToolCall: (tc: ToolCallEntry, onCancel?: () => void) => React.ReactNode;
  onAskUserSelect: (option: string, index: number) => void;
  onCancel?: () => void;
}) {
  const blocks = msg.blocks || [];
  const ranSql = blocks.some((b) => b.type === "tool_call" && b.toolCall.name === "run_sql");
  const lastText = [...blocks].reverse().find((b) => b.type === "text") as { content: string } | undefined;
  const proposed = !msg.isStreaming && !ranSql && lastText ? extractSql(lastText.content) : null;
  return (
    <div className="space-y-2">
      <ChatMessageAssistant blocks={blocks} isStreaming={msg.isStreaming} usage={msg.usage} model={model}
        onAskUserSelect={onAskUserSelect} onCancel={onCancel} renderSqlToolCall={renderSqlToolCall} />
      {proposed && <div className="pl-6"><SqlApplyBar sql={proposed} apply={apply} /></div>}
    </div>
  );
}
