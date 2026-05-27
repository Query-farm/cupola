/**
 * AI conversation mode for the DuckDB WASM shell.
 * Manages the AI read loop, tool execution, spinner, and markdown rendering.
 */
import {
  runAgentTurn,
  buildSystemPrompt,
  executeListTables,
  executeReadQueryResults,
  type MessageParam,
} from "@/lib/ai-agent";
import { executeRunSql, describeTableWithFallback } from "@/lib/ai-tool-executor";
import { createMarkdownRenderer } from "@/lib/markdown-ansi";
import { estimateCost, formatCost } from "@/lib/pricing";
import { bridge, recordQuery } from "@/lib/shell-bridge";
import type { CatalogData } from "@/lib/service";
import * as Sentry from "@sentry/astro";

/** Persistent AI conversation state — survives across .ai mode entries. */
export interface AIConversationState {
  messages: MessageParam[];
  conversationId: string;
  conversationName: string;
}

/** Terminal I/O interface for AI mode. */
export interface AITerminal {
  /** Terminal column width. */
  cols: number;
  /** Low-level write to terminal (no newline). */
  write: (data: string) => void;
  /** Paste text into the terminal input. */
  paste: (text: string) => void;
  /** Print a line with newline. */
  println: (line: string) => void;
  /** Print a colored line. */
  writeln: (msg: string, color?: string) => void;
  /** Read a line from the user with the given prompt. */
  read: (prompt: string) => Promise<string>;
  /** Register a data handler, returns a disposable. */
  onData: (handler: (data: string) => void) => { dispose: () => void };
  /** Access to readline history. */
  history: any;
}

/** Shell operations AI mode can perform. */
export interface AIShellOps {
  catalogData: CatalogData;
  serviceUrl: string;
  runQueryAsync: (sql: string) => Promise<any>;
  tableFromIPC: (buf: any) => any;
  printTable: (table: any, elapsedMs?: number) => Promise<void>;
  clearProgressBar: () => void;
  /** Set/get query running flag. */
  setQueryRunning: (running: boolean) => void;
  /** Reset the cancel flag after a query completes. */
  resetCancelFlag: () => void;
}

/** Read fresh AI settings from localStorage (user may change mid-session). */
function readAISettings(defaults: { apiKey: string; model: string }): { apiKey: string; model: string; maxToolRounds: number } {
  let apiKey = defaults.apiKey;
  let model = defaults.model;
  let maxToolRounds = 20;
  try {
    const stored = localStorage.getItem("vgi-frontend-settings");
    if (stored) {
      const s = JSON.parse(stored);
      if (s.anthropicApiKey) apiKey = s.anthropicApiKey;
      if (s.aiModel) model = s.aiModel;
      if (s.aiMaxToolRounds) maxToolRounds = s.aiMaxToolRounds;
    }
  } catch {}
  return { apiKey, model, maxToolRounds };
}

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function createSpinner(term: AITerminal) {
  let interval: ReturnType<typeof setInterval> | null = null;
  let frame = 0;
  let label = "";

  return {
    start(newLabel: string) {
      label = newLabel;
      frame = 0;
      if (interval) return; // already running, just update label
      interval = setInterval(() => {
        if (term.cols < 2) return;
        term.write(`\r\x1b[1;35m${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} ${label}\x1b[0m\x1b[K`);
        frame++;
      }, 100);
    },
    stop() {
      if (interval) {
        clearInterval(interval);
        interval = null;
        term.write("\r\x1b[K");
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tool executor
// ---------------------------------------------------------------------------

function createToolExecutor(
  conv: AIConversationState,
  term: AITerminal,
  ops: AIShellOps,
  spinner: ReturnType<typeof createSpinner>,
) {
  return async (name: string, input: any): Promise<string> => {
    if (name === "run_sql") {
      const lastUserMsg = conv.messages.filter(m => m.role === "user").pop();
      const userQuestion = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : undefined;
      return executeRunSql(input.sql, { query: ops.runQueryAsync }, {
        onStart: () => { spinner.stop(); ops.setQueryRunning(true); },
        onEnd: () => { ops.clearProgressBar(); ops.setQueryRunning(false); ops.resetCancelFlag(); },
        onOutcome: async (out) => {
          if (out.kind === "error") {
            term.println(`\x1b[31m  Error: ${out.errMsg}\x1b[0m`);
            recordQuery({
              sql: input.sql, executionTimeMs: out.elapsedMs, success: false, error: out.errMsg,
              userQuestion, conversationId: conv.conversationId, conversationName: conv.conversationName,
            });
            return;
          }
          if (out.kind === "empty") {
            term.println(`\x1b[2m  OK (no results)\x1b[0m`);
            recordQuery({
              sql: input.sql, executionTimeMs: out.elapsedMs, success: true, rowCount: 0,
              userQuestion, conversationId: conv.conversationId, conversationName: conv.conversationName,
            });
            return;
          }
          if (out.kind === "ddl") {
            // shell .ai mode doesn't refresh sidebar / navigate on DDL — the
            // shell's own readLoop handles that for direct queries, and the
            // model already knows the schema it just changed.
            recordQuery({
              sql: input.sql, executionTimeMs: out.elapsedMs, success: true, rowCount: 0,
              userQuestion, conversationId: conv.conversationId, conversationName: conv.conversationName,
            });
            return;
          }
          // out.kind === "table"
          await ops.printTable(out.table);
          recordQuery({
            sql: input.sql, executionTimeMs: out.elapsedMs, success: true, rowCount: out.table.numRows,
            userQuestion, conversationId: conv.conversationId, conversationName: conv.conversationName,
          });
        },
      });
    }

    if (name === "read_query_results") {
      return executeReadQueryResults(input.result_id, input.offset, input.limit);
    }
    if (name === "list_tables") {
      return executeListTables(ops.catalogData);
    }
    if (name === "describe_table") {
      return describeTableWithFallback(ops.catalogData, { query: ops.runQueryAsync }, input);
    }
    if (name === "ask_user") {
      spinner.stop();
      term.println("");
      term.println(`\x1b[1m${input.question}\x1b[0m`);
      const options: string[] = input.options || [];
      for (let i = 0; i < options.length; i++) {
        term.println(`  \x1b[33m${i + 1}.\x1b[0m ${options[i]}`);
      }
      term.println("");
      const choice = await term.read("Select: ");
      const idx = parseInt(choice.trim(), 10) - 1;
      if (idx >= 0 && idx < options.length) return `User selected: ${options[idx]}`;
      return `User responded: ${choice.trim()}`;
    }

    return JSON.stringify({ error: `Unknown tool: ${name}` });
  };
}

// ---------------------------------------------------------------------------
// Agent turn callbacks
// ---------------------------------------------------------------------------

function createAgentCallbacks(
  term: AITerminal,
  spinner: ReturnType<typeof createSpinner>,
  model: string,
) {
  let textBuffer = "";

  function flushText() {
    if (!textBuffer) return;
    term.println("");
    const md = createMarkdownRenderer(term.cols);
    term.write(md.push(textBuffer + "\n"));
    term.write(md.end());
    textBuffer = "";
  }

  return {
    appendText(chunk: string) { textBuffer += chunk; },
    flushText,
    callbacks: {
      onText: (chunk: string) => { textBuffer += chunk; },
      onToolCall: (name: string, input: any) => {
        spinner.stop();
        flushText();
        term.println("");
        if (name === "run_sql") {
          const sqlLabel = "── SQL ";
          const lineWidth = Math.max(0, term.cols - sqlLabel.length - 1);
          term.println(`\x1b[2m${sqlLabel}${"─".repeat(lineWidth)}\x1b[0m`);
          term.println(`\x1b[33m${input.sql}\x1b[0m`);
          term.println("");
        } else if (name === "describe_table") {
          term.println(`\x1b[2m  📋 Describing ${input.schema}.${input.table}\x1b[0m`);
        } else if (name === "list_tables") {
          term.println(`\x1b[2m  📋 Listing tables\x1b[0m`);
        } else if (name === "ask_user") {
          // Handled in executeTool
        } else {
          term.println(`\x1b[2m  [${name}]\x1b[0m`);
        }
      },
      onToolResult: () => {
        term.println("");
        spinner.start("Thinking...");
      },
      onDone: (usage: any) => {
        spinner.stop();
        flushText();
        term.println("");
        if (usage) {
          const cost = estimateCost(model, usage.inputTokens, usage.outputTokens);
          term.println(`\x1b[2m  tokens: ${usage.inputTokens.toLocaleString()} in, ${usage.outputTokens.toLocaleString()} out (${formatCost(cost)})\x1b[0m`);
        }
        term.println("");
        term.println("");
      },
      onError: (error: string) => {
        spinner.stop();
        term.println("");
        term.writeln(`Error: ${error}`, "31");
        term.println("");
      },
      onRetry: (message?: string) => {
        spinner.start(message || "Thinking...");
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Main AI mode entry point
// ---------------------------------------------------------------------------

/**
 * Run the AI conversation mode. Returns when the user exits (.exit, Ctrl+D, Escape).
 */
export async function runAIMode(
  trimmed: string,
  conv: AIConversationState,
  term: AITerminal,
  ops: AIShellOps,
  defaults: { apiKey: string; model: string },
): Promise<void> {
  // .ai name <text> — set name without entering the loop
  if (trimmed.startsWith(".ai name ")) {
    conv.conversationName = trimmed.slice(9).trim();
    term.writeln(`Conversation named: ${conv.conversationName}`, "33");
    return;
  }

  const { apiKey, model, maxToolRounds } = readAISettings(defaults);
  if (!apiKey) {
    term.writeln("No API key configured. Set your Anthropic API key in Settings.", "31");
    return;
  }
  if (!ops.catalogData) {
    term.writeln("Catalog data not available. Try again after the catalog loads.", "31");
    return;
  }

  // .ai new → fresh conversation
  if (trimmed === ".ai new") {
    conv.messages = [];
    conv.conversationId = `ai-${Date.now()}`;
    conv.conversationName = "";
    term.writeln("Starting new AI conversation. Type .exit to return to SQL.", "35");
  } else if (conv.messages.length > 0) {
    const nameHint = conv.conversationName ? ` (${conv.conversationName})` : "";
    term.writeln(`Resuming AI conversation${nameHint} — ${conv.messages.length} messages. Type .ai new for a fresh start.`, "35");
  } else {
    term.writeln("Entering AI mode. Type .exit to return to SQL.", "35");
  }
  term.writeln("");

  bridge.inAiMode = true;
  const systemPrompt = buildSystemPrompt(ops.catalogData, ops.serviceUrl, bridge.memoryCatalog);
  const spinner = createSpinner(term);

  // Ctrl+D / Escape exits AI mode
  let ctrlDExit = false;
  const ctrlDDisposable = term.onData((data: string) => {
    if (data === "\x04" || data === "\x1b") {
      ctrlDExit = true;
      term.paste("\r");
    }
  });

  try {
    while (true) {
      const userInput = await term.read("\x1b[1;36mAI\x1b[0m > ");

      if (ctrlDExit) {
        ctrlDExit = false;
        term.writeln("Exiting AI mode.", "35");
        term.writeln("");
        break;
      }

      const aiTrimmed = userInput.trim();
      if (!aiTrimmed) { if (term.history?.length) term.history.pop(); continue; }

      // AI sub-commands
      if (aiTrimmed === ".help" || aiTrimmed === "/help") {
        term.writeln("/new               Start a new conversation");
        term.writeln("/name <text>       Name this conversation");
        term.writeln("/clear             Clear conversation history");
        term.writeln("/exit              Return to SQL mode");
        term.writeln("/help              Show this help");
        continue;
      }
      if (aiTrimmed === "/new") {
        conv.messages = []; conv.conversationId = `ai-${Date.now()}`; conv.conversationName = "";
        term.writeln("Started new conversation.", "33");
        continue;
      }
      if (aiTrimmed === ".clear" || aiTrimmed === "/clear") {
        conv.messages = []; conv.conversationId = `ai-${Date.now()}`; conv.conversationName = "";
        term.writeln("Conversation cleared.", "33");
        continue;
      }
      if (aiTrimmed.startsWith(".name ") || aiTrimmed.startsWith("/name ")) {
        conv.conversationName = aiTrimmed.slice(6).trim();
        term.writeln(`Conversation named: ${conv.conversationName}`, "33");
        continue;
      }
      if (aiTrimmed === ".exit" || aiTrimmed === "/exit") {
        term.writeln("Exiting AI mode.", "35");
        term.writeln("");
        break;
      }

      // Send user message to agent
      conv.messages.push({ role: "user", content: aiTrimmed });
      if (!conv.conversationName) {
        conv.conversationName = aiTrimmed.length > 50 ? aiTrimmed.slice(0, 50) + "…" : aiTrimmed;
      }

      const abort = new AbortController();
      const cancelDisposable = term.onData((data: string) => {
        if (data === "\x03" || data === "\x1b") abort.abort();
      });

      spinner.start("Thinking...");
      const executeTool = createToolExecutor(conv, term, ops, spinner);
      const agent = createAgentCallbacks(term, spinner, model);

      try {
        await runAgentTurn(apiKey, model, conv.messages, systemPrompt, executeTool, agent.callbacks, abort.signal, maxToolRounds);
      } catch (err: any) {
        spinner.stop();
        if (err.name === "AbortError" || err.message === "Cancelled.") {
          term.println("");
          term.writeln("Cancelled.", "33");
          term.println("");
        } else {
          term.println("");
          term.writeln(`Error: ${err.message || err}`, "31");
          term.println("");
          Sentry.captureException(err, {
            tags: { component: "ai-agent", path: "shell" },
            extra: { model, maxToolRounds },
          });
        }
      } finally {
        cancelDisposable.dispose();
      }
    }
  } finally {
    ctrlDDisposable.dispose();
    bridge.inAiMode = false;
  }
}
