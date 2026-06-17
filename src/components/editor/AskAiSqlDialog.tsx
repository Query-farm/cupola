/**
 * "Ask AI" affordance for the SQL editor. A focused dialog that asks the
 * existing agent to write a new query or explain the current one, streams the
 * response, extracts the SQL, and lets the user insert it into the editor.
 *
 * Reuses runAgentTurn + the shared tool executor so the agent can inspect the
 * schema (list_tables / describe_table) and validate SQL (run_sql) exactly as
 * the chat panel does.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Sparkles, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useSettings } from "@/lib/settings";
import { bridge } from "@/lib/shell-bridge";
import type { CatalogData } from "@/lib/service";
import {
  runAgentTurn,
  buildSystemPrompt,
  TOOLS,
  executeListTables,
  executeReadQueryResults,
  type ToolResult,
} from "@/lib/ai-agent";
import { executeRunSql, describeTableWithFallback } from "@/lib/ai-tool-executor";
import { DEFAULT_AI_MODEL } from "@/lib/settings";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  catalogData: CatalogData;
  serviceUrl: string;
  /** Read the LIVE current query (selection → statement-at-cursor → whole doc)
   *  at call time — a value prop would be stale (CodeMirror edits don't
   *  re-render the parent). */
  getCurrentSql: () => string;
  /** Apply the AI's SQL by replacing the statement the cursor is in. */
  onReplaceStatement: (sql: string) => void;
  /** Apply by replacing the entire editor document. */
  onReplaceDocument: (sql: string) => void;
  /** Apply by inserting at the cursor (additive). */
  onInsertAtCursor: (sql: string) => void;
}

/** Pull the last fenced ```sql block (or any fenced block) out of markdown. */
function extractSql(text: string): string | null {
  const fences = [...text.matchAll(/```(?:sql)?\s*\n([\s\S]*?)```/gi)];
  if (fences.length > 0) return fences[fences.length - 1][1].trim();
  return null;
}

export function AskAiSqlDialog({ open, onOpenChange, catalogData, serviceUrl, getCurrentSql, onReplaceStatement, onReplaceDocument, onInsertAtCursor }: Props) {
  const { settings } = useSettings();
  const [prompt, setPrompt] = useState("");
  const [output, setOutput] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const outputRef = useRef<HTMLDivElement | null>(null);
  // Snapshot the current query when the dialog opens (the editor is modal-
  // covered while open, so this stays accurate) — drives the Explain button.
  const [currentSql, setCurrentSql] = useState("");

  useEffect(() => {
    if (open) {
      setOutput("");
      setError(null);
      setCurrentSql(getCurrentSql());
    } else {
      abortRef.current?.abort();
    }
  }, [open, getCurrentSql]);

  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [output]);

  const run = useCallback(async (explainMode: boolean) => {
    const apiKey = settings.anthropicApiKey;
    if (!apiKey) {
      setError("No Anthropic API key configured. Add one in Settings → AI.");
      return;
    }
    // Read the live query fresh at run time (not the open-time snapshot).
    const liveSql = getCurrentSql();
    if (!explainMode && !prompt.trim()) return;
    if (explainMode && !liveSql.trim()) {
      setError("No SQL in the editor to explain.");
      return;
    }

    setRunning(true);
    setError(null);
    setOutput("");
    const controller = new AbortController();
    abortRef.current = controller;

    const instruction = explainMode
      ? `Explain this SQL query in clear prose. Describe what it returns, the tables/joins involved, and any notable filters or aggregations. Do not rewrite it unless asked.\n\n\`\`\`sql\n${liveSql}\n\`\`\``
      : `Write a single DuckDB SQL query for the following request. Use the current editor query as context if relevant. Return ONLY the query inside a \`\`\`sql code block, preceded by at most one short sentence.${liveSql.trim() ? `\n\nCurrent editor query:\n\`\`\`sql\n${liveSql}\n\`\`\`` : ""}\n\nRequest: ${prompt.trim()}`;

    const system =
      buildSystemPrompt(catalogData, serviceUrl, bridge.memoryCatalog, false) +
      "\n\nYou are assisting inside a SQL editor. Prefer concise answers. When asked to write SQL, put the final query in a single ```sql fenced block.";

    const executeTool = async (name: string, input: any, signal?: AbortSignal): Promise<ToolResult> => {
      if (name === "run_sql") {
        const q = bridge.query;
        if (!q) throw new Error("DuckDB not initialized");
        return executeRunSql(input.sql, { query: q });
      }
      if (name === "read_query_results") {
        return executeReadQueryResults(input.result_id, input.offset, input.limit);
      }
      if (name === "list_tables") return executeListTables(catalogData);
      if (name === "describe_table") {
        const q = bridge.query;
        return describeTableWithFallback(catalogData, { query: q ?? (async () => ({ ok: false, error: "no bridge" })) }, input);
      }
      if (name === "ask_user") {
        return "The user is not available to answer in this context. Make a reasonable assumption and proceed.";
      }
      return `Tool ${name} is not available in the editor.`;
    };

    try {
      await runAgentTurn(
        apiKey,
        settings.aiModel || DEFAULT_AI_MODEL,
        [{ role: "user", content: instruction }],
        system,
        executeTool,
        {
          onText: (chunk) => setOutput((p) => p + chunk),
          onToolCall: () => {},
          onToolResult: () => {},
          onDone: () => setRunning(false),
          onError: (e) => { setError(e); setRunning(false); },
        },
        controller.signal,
        settings.aiMaxToolRounds || 20,
        TOOLS,
      );
    } catch (e) {
      if ((e as any)?.name !== "AbortError") {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setRunning(false);
    }
  }, [settings, prompt, getCurrentSql, catalogData, serviceUrl]);

  const extracted = extractSql(output);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-accent" /> Ask AI
          </DialogTitle>
          <DialogDescription>
            Describe the query you want, or explain the current statement. The result can be inserted into the editor.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-2">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run(false); }
            }}
            placeholder="e.g. total sales by month for 2025, ordered by month"
            rows={3}
            className="flex-1 px-3 py-2 rounded-md border border-input bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y"
          />
        </div>

        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => run(false)} disabled={running || !prompt.trim()} className="gap-1.5">
            {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            Write SQL
          </Button>
          <Button size="sm" variant="outline" onClick={() => run(true)} disabled={running || !currentSql.trim()}>
            Explain current
          </Button>
          {running && (
            <Button size="sm" variant="ghost" onClick={() => abortRef.current?.abort()}>
              Stop
            </Button>
          )}
        </div>

        {error && (
          <div className="rounded-md bg-destructive/10 border border-destructive/30 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        {output && (
          <div
            ref={outputRef}
            className="max-h-72 overflow-auto rounded-md border border-border bg-muted/30 p-3 text-xs whitespace-pre-wrap font-mono"
          >
            {output}
          </div>
        )}

        <DialogFooter className="flex-wrap gap-2">
          {extracted && (
            <>
              <Button
                onClick={() => { onReplaceStatement(extracted); onOpenChange(false); }}
                className="gap-1.5"
                data-testid="ai-apply-replace-statement"
              >
                Replace statement
              </Button>
              <Button
                variant="outline"
                onClick={() => { onReplaceDocument(extracted); onOpenChange(false); }}
                data-testid="ai-apply-replace-document"
              >
                Replace document
              </Button>
              <Button
                variant="outline"
                onClick={() => { onInsertAtCursor(extracted); onOpenChange(false); }}
                data-testid="ai-apply-insert"
              >
                Insert at cursor
              </Button>
            </>
          )}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
