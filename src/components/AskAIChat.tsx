import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { Sparkles, RotateCcw, Settings, FileText, Copy } from "lucide-react";
import { useSettings } from "@/lib/settings";
import { bridge } from "@/lib/shell-bridge";
import type { CatalogData } from "@/lib/service";
import {
  runAgentTurn,
  buildSystemPrompt,
  executeListTables,
  executeDescribeTable,
  executeReadQueryResults,
  formatArrowTableAsJson,
  type MessageParam,
} from "@/lib/ai-agent";
/** Safely quote a SQL identifier to prevent injection. */
function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}
const uid = () => crypto.randomUUID();

import { ChatInput } from "./chat/ChatInput";
import { ChatMessageUser } from "./chat/ChatMessageUser";
import {
  ChatMessageAssistant,
  type ContentBlock,
  type ToolCallEntry,
  type AskUserState,
} from "./chat/ChatMessageAssistant";
import { tableFromIPC } from "apache-arrow";

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

    const systemPrompt = buildSystemPrompt(catalogData, serviceUrl, bridge.memoryCatalog);
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

    // Tool executor
    const executeTool = async (name: string, input: any): Promise<string> => {
      if (name === "run_sql") {
        // Subscribe to progress
        const prevProgress = bridge.progress;
        const updateProgress = (pct: number) => {
          blocks = blocks.map(b =>
            b.type === "tool_call" && b.toolCall.isExecuting
              ? { ...b, toolCall: { ...b.toolCall, progress: pct } }
              : b
          );
          updateBlocks(blocks);
        };
        bridge.progress = updateProgress;

        const queryFn = bridge.query;
        if (!queryFn) throw new Error("DuckDB shell not initialized — open SQL Shell first");
        const t0 = performance.now();
        const result = await queryFn(input.sql);
        const elapsed = performance.now() - t0;

        bridge.progress = prevProgress;

        const lastUserMsg = agentMessages.current.filter(m => m.role === "user").pop();
        const userQuestion = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : undefined;

        if (!result.ok) {
          const errMsg = result.error || "Query failed";
          bridge.addQueryHistoryEntry?.({
            id: Date.now(), timestamp: Date.now(), sql: input.sql,
            executionTimeMs: elapsed, success: false, error: errMsg, userQuestion,
          });
          if (errMsg.includes("HTTP Error") || errMsg.includes("HTTP 5")) {
            const fatal = new Error(`VGI connection error: ${errMsg}`);
            (fatal as any).fatal = true;
            throw fatal;
          }
          throw new Error(errMsg);
        }

        const firstBuf = result.arrowBuffers?.[0];
        if (!firstBuf || (firstBuf instanceof ArrayBuffer ? firstBuf.byteLength === 0 : firstBuf.length === 0)) {
          bridge.addQueryHistoryEntry?.({
            id: Date.now(), timestamp: Date.now(), sql: input.sql,
            executionTimeMs: elapsed, success: true, rowCount: 0, userQuestion,
          });
          // COMMENT ON returns empty result — refresh so comments appear on detail pages
          if (/COMMENT\s+ON/i.test(input.sql)) {
            await bridge.refreshMemoryTables?.();
          }
          pendingDisplayResult = { columns: [], rows: [], rowCount: 0, showing: 0, message: "Query executed successfully" };
          return JSON.stringify({ ok: true, message: "Query executed successfully" });
        }

        const table = tableFromIPC(firstBuf instanceof ArrayBuffer ? new Uint8Array(firstBuf) : firstBuf);

        // DDL results (CREATE/DROP etc.) return single Count column
        const fields = table.schema.fields;
        if (fields.length === 1 && fields[0].name === "Count" && table.numRows <= 1) {
          bridge.addQueryHistoryEntry?.({
            id: Date.now(), timestamp: Date.now(), sql: input.sql,
            executionTimeMs: elapsed, success: true, rowCount: 0, userQuestion,
          });
          pendingDisplayResult = { columns: [], rows: [], rowCount: 0, showing: 0, message: "Query executed successfully" };
          // DDL — refresh sidebar and handle navigation
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
          return JSON.stringify({ ok: true, message: "Query executed successfully" });
        }

        const { json } = formatArrowTableAsJson(table);
        // Build display result with first 20 rows for the UI
        const parsed = JSON.parse(json);
        pendingDisplayResult = {
          columns: parsed.columns,
          rows: parsed.rows,
          rowCount: parsed.row_count,
          showing: parsed.showing,
        };

        bridge.addQueryHistoryEntry?.({
          id: Date.now(), timestamp: Date.now(), sql: input.sql,
          executionTimeMs: elapsed, success: true, rowCount: table.numRows, userQuestion,
        });
        return json;
      }
      if (name === "read_query_results") {
        return executeReadQueryResults(input.result_id, input.offset, input.limit);
      }
      if (name === "list_tables") {
        return executeListTables(catalogData!);
      }
      if (name === "describe_table") {
        // If catalog specified and not the main catalog, use SQL to describe
        if (input.catalog && input.catalog !== catalogData!.catalogName) {
          const queryFn = bridge.query;
          if (queryFn) {
            // Get columns
            const r = await queryFn(`SELECT column_name, data_type, is_nullable, column_default, comment FROM duckdb_columns() WHERE database_name = ${quoteIdent(input.catalog)} AND schema_name = ${quoteIdent(input.schema)} AND table_name = ${quoteIdent(input.table)} ORDER BY column_index`);
            if (r.ok && r.arrowBuffers?.length) {
              const t = tableFromIPC(r.arrowBuffers[0] instanceof ArrayBuffer ? new Uint8Array(r.arrowBuffers[0]) : r.arrowBuffers[0]);
              const cols: any[] = [];
              for (let i = 0; i < t.numRows; i++) {
                const col: any = {
                  name: String(t.getChildAt(0)?.get(i)),
                  type: String(t.getChildAt(1)?.get(i)),
                  nullable: String(t.getChildAt(2)?.get(i)) === "YES",
                };
                const def = t.getChildAt(3)?.get(i);
                if (def) col.default = String(def);
                const cmt = t.getChildAt(4)?.get(i);
                if (cmt) col.comment = String(cmt);
                cols.push(col);
              }
              // Get table comment
              const commentR = await queryFn(`SELECT comment FROM duckdb_tables() WHERE database_name = ${quoteIdent(input.catalog)} AND schema_name = ${quoteIdent(input.schema)} AND table_name = ${quoteIdent(input.table)}`);
              let tableComment = null;
              if (commentR.ok && commentR.arrowBuffers?.length) {
                const ct = tableFromIPC(commentR.arrowBuffers[0] instanceof ArrayBuffer ? new Uint8Array(commentR.arrowBuffers[0]) : commentR.arrowBuffers[0]);
                if (ct.numRows > 0) tableComment = String(ct.getChildAt(0)?.get(0) ?? "") || null;
              }
              // Get constraints
              const constraintR = await queryFn(`SELECT constraint_type, constraint_column_names FROM duckdb_constraints() WHERE database_name = ${quoteIdent(input.catalog)} AND schema_name = ${quoteIdent(input.schema)} AND table_name = ${quoteIdent(input.table)}`);
              let primaryKey: string[] | null = null;
              const checkConstraints: string[] = [];
              const uniqueConstraints: string[][] = [];
              if (constraintR.ok && constraintR.arrowBuffers?.length) {
                const ct2 = tableFromIPC(constraintR.arrowBuffers[0] instanceof ArrayBuffer ? new Uint8Array(constraintR.arrowBuffers[0]) : constraintR.arrowBuffers[0]);
                for (let i = 0; i < ct2.numRows; i++) {
                  const ctype = String(ct2.getChildAt(0)?.get(i));
                  const ccols = ct2.getChildAt(1)?.get(i);
                  const colNames = ccols ? (Array.isArray(ccols) ? ccols.map(String) : [String(ccols)]) : [];
                  if (ctype === "PRIMARY KEY") primaryKey = colNames;
                  else if (ctype === "UNIQUE") uniqueConstraints.push(colNames);
                  else if (ctype === "CHECK") checkConstraints.push(colNames.join(", "));
                }
              }
              return JSON.stringify({
                catalog: input.catalog, schema: input.schema, name: input.table, type: "table",
                comment: tableComment,
                primary_key: primaryKey,
                unique_constraints: uniqueConstraints.length > 0 ? uniqueConstraints : null,
                check_constraints: checkConstraints.length > 0 ? checkConstraints : null,
                columns: cols,
              });
            }
          }
        }
        return executeDescribeTable(catalogData!, input.schema, input.table);
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
      );
    } catch (err: any) {
      removeThinking();
      // Mark any still-executing tool calls as stopped
      blocks = blocks.map(b =>
        b.type === "tool_call" && b.toolCall.isExecuting
          ? { ...b, toolCall: { ...b.toolCall, isExecuting: false, error: "Cancelled" } }
          : b
      );
      if (err.name !== "AbortError" && err.message !== "Cancelled." && err.message !== "Query cancelled") {
        const idx = ensureTextBlock();
        const textBlock = blocks[idx] as { type: "text"; content: string };
        blocks = blocks.map((b, i) => i === idx
          ? { ...b, content: textBlock.content + (textBlock.content ? "\n\n" : "") + `**Error:** ${err.message}` }
          : b
        );
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
  const systemPrompt = useMemo(() => catalogData ? buildSystemPrompt(catalogData, serviceUrl, bridge.memoryCatalog) : null, [catalogData, serviceUrl]);

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
          <div className="max-w-2xl space-y-4">
            {messages.map((msg) => (
              msg.role === "user" ? (
                <ChatMessageUser key={msg.id} content={msg.content || ""} />
              ) : (
                <ChatMessageAssistant
                  key={msg.id}
                  blocks={msg.blocks || []}
                  isStreaming={msg.isStreaming}
                  onAskUserSelect={handleAskUserSelect}
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
