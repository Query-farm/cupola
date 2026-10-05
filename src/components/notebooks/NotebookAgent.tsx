import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Button } from '../ui/button';
import { useSettings, DEFAULT_AI_MODEL } from '../../lib/settings';
import { runAgentTurn, type MessageParam } from '../../lib/ai-agent';
import { normalizeEffort } from '../../lib/ai/model-features';
import { aiQueryModePrompt, normalizeAIQueryMode, toolsForAIQueryMode } from '../../lib/ai/query-mode';
import { executeReportDataTool } from '../../lib/evidence/agent-data-tools';
import { EvidenceQueryRun } from '../../lib/evidence/query-run';
import { isReadOnlySql } from '../../lib/evidence/setup-test';
import { waitForEngineReady } from '../../lib/shell-bridge';
import { QueryResultCache } from '../../lib/query-results';
import {
  NOTEBOOK_PROMPT,
  NOTEBOOK_TOOLS,
  notebookProposal,
  applyNotebookProposal,
  type NotebookProposal,
} from '../../lib/notebooks/agent';
import { fingerprint, type Notebook } from '../../lib/notebooks/model';
import { validateSelectQuery, type CellResult } from '../../lib/notebooks/execution';
import type { CatalogData } from '../../lib/service';

export function NotebookAgent({
  disabled,
  document,
  results,
  selectedCell,
  catalogs,
  onApply,
  onBusy,
}: {
  disabled: boolean;
  document: Notebook;
  results: Record<string, CellResult>;
  selectedCell: string | null;
  catalogs: readonly CatalogData[];
  onApply: (doc: Notebook) => void;
  onBusy: (busy: boolean) => void;
}) {
  const { settings } = useSettings();
  const [request, setRequest] = useState('');
  const [messages, setMessages] = useState<{ role: 'user' | 'assistant'; text: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState('');
  const [error, setError] = useState('');
  const [proposal, setProposal] = useState<NotebookProposal | null>(null);
  const latest = useRef({ document, results, selectedCell });
  latest.current = { document, results, selectedCell };
  const abort = useRef<AbortController | null>(null);
  const history = useRef<MessageParam[]>([]);
  const cache = useRef(new QueryResultCache());
  useEffect(
    () => () => {
      abort.current?.abort();
    },
    [],
  );
  async function send() {
    if (disabled || !request.trim() || abort.current) return;
    if (!settings.anthropicApiKey) {
      setError('Add your Anthropic API key in Settings to use the notebook assistant.');
      return;
    }
    const text = request.trim();
    // A proposal must be based on what the model actually read, not newer edits
    // which arrived while its response was streaming.
    let readContext = latest.current;
    const controller = new AbortController();
    abort.current = controller;
    const run = new EvidenceQueryRun();
    const stop = () => run.stop();
    controller.signal.addEventListener('abort', stop, { once: true });
    const mode = normalizeAIQueryMode(settings.aiQueryMode);
    const query = async (sql: string, params: unknown[] = []) => {
      if (!isReadOnlySql(sql)) throw new Error('Notebook exploration accepts read queries only.');
      await run.wait(waitForEngineReady());
      return run.query(sql, params);
    };
    setBusy(true);
    onBusy(true);
    setError('');
    setProposal(null);
    setRequest('');
    setActivity('Connecting…');
    setMessages((previous) => [...previous, { role: 'user', text }, { role: 'assistant', text: '' }]);
    history.current.push({ role: 'user', content: text });
    try {
      await runAgentTurn(
        { apiKey: settings.anthropicApiKey, workspaceId: settings.anthropicWorkspaceId || '' },
        settings.aiModel || DEFAULT_AI_MODEL,
        history.current,
        NOTEBOOK_PROMPT + '\n' + aiQueryModePrompt(mode),
        async (name, input) => {
          controller.signal.throwIfAborted();
          try {
            if (name === 'get_notebook') {
              readContext = latest.current;
              return JSON.stringify({
                ...readContext,
                results: Object.fromEntries(
                  Object.entries(readContext.results).map(([id, result]) => [
                    id,
                    {
                      source: result.source,
                      completedAt: result.completedAt,
                      error: result.error,
                      cancelled: result.cancelled,
                      rows: result.table?.numRows,
                      columns: result.table?.schema.fields.map((field) => ({
                        name: field.name,
                        type: field.type.toString(),
                      })),
                    },
                  ]),
                ),
              });
            }
            if (name === 'propose_notebook_edit') {
              const next = notebookProposal(readContext.document, JSON.parse(input.edit_json), mode);
              controller.signal.throwIfAborted();
              setProposal(next);
              return 'Proposed for review. Not applied or executed.';
            }
            if (name === 'run_sql' && mode !== 'semantic-only') {
              if (typeof input?.sql !== 'string') throw new Error('SQL is required.');
              await run.wait(waitForEngineReady());
              await validateSelectQuery(input.sql, (text, values) => run.query(text, values));
            }
            const result = await executeReportDataTool(
              name,
              input,
              catalogs,
              { query, queryPrepared: query, resultCache: cache.current },
              mode,
            );
            return result ?? 'Error: Unknown notebook tool';
          } catch (e) {
            if (controller.signal.aborted) throw e;
            return `Error: ${e instanceof Error ? e.message : String(e)}`;
          }
        },
        {
          onText: (chunk) => {
            if (!controller.signal.aborted)
              setMessages((previous) =>
                previous.map((message, index) =>
                  index === previous.length - 1 ? { ...message, text: message.text + chunk } : message,
                ),
              );
          },
          onToolCall: (name) => setActivity(`Working: ${name.replaceAll('_', ' ')}…`),
          onToolResult: () => setActivity('Preparing response…'),
          onDone: () => {},
          onError: (message) => {
            if (!controller.signal.aborted) setError(message);
          },
          onRetry: (message) => setActivity(message || 'Reconnecting…'),
        },
        controller.signal,
        settings.aiMaxToolRounds || 20,
        toolsForAIQueryMode(NOTEBOOK_TOOLS, mode),
        settings.aiMaxTokens || undefined,
        true,
        normalizeEffort(settings.aiEffort),
      );
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      controller.signal.removeEventListener('abort', stop);
      run.stop();
      if (controller.signal.aborted) {
        setProposal(null);
        setError('Stopped. No proposed changes were applied.');
      }
      abort.current = null;
      setBusy(false);
      onBusy(false);
      setActivity('');
    }
  }
  return (
    <aside
      className="border-l bg-card flex flex-col w-full lg:w-96 shrink-0 min-h-0"
      aria-label="Notebook assistant"
    >
      <div className="p-3 border-b font-medium">Notebook assistant</div>
      <div className="flex-1 overflow-auto p-3 space-y-4">
        {!messages.length && (
          <p className="text-sm text-muted-foreground">
            Ask for a new analysis, a chart, or an explanation. Proposed edits can be reviewed before
            applying. The assistant may run read queries to inspect your data.
          </p>
        )}
        {messages.map((message, index) => (
          <div key={index} className="text-sm">
            <strong>{message.role === 'user' ? 'You' : 'Assistant'}</strong>
            <div className="prose prose-sm dark:prose-invert max-w-none">
              <ReactMarkdown skipHtml>{message.text}</ReactMarkdown>
            </div>
          </div>
        ))}
        {activity && (
          <p role="status" className="text-xs text-muted-foreground">
            {activity}
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {proposal && (
          <div className="rounded border p-3 space-y-2 text-sm">
            <strong>{proposal.summary}</strong>
            <p>
              {proposal.document.title} · {proposal.document.cells.length} cells
            </p>
            <details>
              <summary className="cursor-pointer">Review proposed notebook</summary>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-xs">
                {JSON.stringify({ title: proposal.document.title, cells: proposal.document.cells }, null, 2)}
              </pre>
            </details>
            {fingerprint(document) !== proposal.base && (
              <p>The notebook has changed. Ask for an updated proposal.</p>
            )}
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={disabled || busy || fingerprint(document) !== proposal.base}
                onClick={() => {
                  try {
                    onApply(applyNotebookProposal(latest.current.document, proposal));
                    setProposal(null);
                  } catch (e) {
                    setError(String(e));
                  }
                }}
              >
                Apply changes
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setProposal(null)}>
                Discard
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Applying does not execute SQL. Use Undo to reverse the edit.
            </p>
          </div>
        )}
      </div>
      <form
        className="border-t p-3 space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          className="w-full rounded border bg-background p-2 text-sm min-h-24"
          aria-label="Notebook AI request"
          value={request}
          onChange={(event) => setRequest(event.target.value)}
          placeholder="Add a chart and explain the results…"
          disabled={busy}
        />
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={disabled || busy || !request.trim()}>
            Send
          </Button>
          {busy && (
            <Button type="button" size="sm" variant="destructive" onClick={() => abort.current?.abort()}>
              Stop generation
            </Button>
          )}
        </div>
      </form>
    </aside>
  );
}
