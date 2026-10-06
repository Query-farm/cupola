import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../ui/dialog';
import { NotebookProposalReview } from './NotebookProposalReview';
import { useEffect, useRef, useState } from 'react';
import { Sparkles, RotateCcw, X } from 'lucide-react';
import { ChatInput } from '../chat/ChatInput';
import { ChatMessageUser } from '../chat/ChatMessageUser';
import { ChatMessageAssistant, type ContentBlock } from '../chat/ChatMessageAssistant';
import { ThinkingIndicator } from '../chat/ThinkingIndicator';
import { toolActivityLabel, toolInputLabel } from '../../lib/ai/tool-labels';
import type { AgentUsage } from '../../lib/ai-usage';
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
import { fingerprint, uid, type Notebook } from '../../lib/notebooks/model';
import { validateSelectQuery, type CellResult } from '../../lib/notebooks/execution';
import type { CatalogData } from '../../lib/service';
import { compileNotebookQuery } from '../../lib/notebooks/parameters';

export function NotebookAgent({
  active,
  disabled,
  document,
  results,
  selectedCell,
  catalogs,
  onApply,
  onBusy,
  onClose,
}: {
  active: boolean;
  disabled: boolean;
  document: Notebook;
  results: Record<string, CellResult>;
  selectedCell: string | null;
  catalogs: readonly CatalogData[];
  onApply: (doc: Notebook) => void;
  onBusy: (busy: boolean) => void;
  onClose: () => void;
}) {
  const { settings } = useSettings();
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      const target =
        panel.current?.querySelector<HTMLElement>('textarea:not(:disabled)') ??
        panel.current?.querySelector<HTMLElement>('[aria-label="Close Ask AI panel"]');
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [active]);
  const [messages, setMessages] = useState<
    {
      id: string;
      role: 'user' | 'assistant';
      text: string;
      blocks?: ContentBlock[];
      usage?: AgentUsage;
    }[]
  >([]);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState('');
  const [error, setError] = useState('');
  const [applied, setApplied] = useState('');
  const [reviewExpanded, setReviewExpanded] = useState(false);
  const [proposal, setProposal] = useState<NotebookProposal | null>(null);
  const latest = useRef({ document, results, selectedCell });
  latest.current = { document, results, selectedCell };
  const abort = useRef<AbortController | null>(null);
  const history = useRef<MessageParam[]>([]);
  const cache = useRef(new QueryResultCache());
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const stopGeneration = () => abort.current?.abort();
  useEffect(() => {
    if (follow.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [messages, proposal, activity, applied, error]);
  useEffect(
    () => () => {
      abort.current?.abort();
    },
    [],
  );
  async function send(request: string) {
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
      if (params.length) return run.query(sql, params);
      const bound = compileNotebookQuery(sql, readContext.document);
      return run.query(bound.sql, bound.params);
    };
    setBusy(true);
    onBusy(true);
    setError('');
    setApplied('');
    setProposal(null);
    setReviewExpanded(false);
    setActivity('Connecting…');
    const assistantId = uid();
    follow.current = true;
    setMessages((previous) => [
      ...previous,
      { id: uid(), role: 'user', text },
      { id: assistantId, role: 'assistant', text: '', blocks: [] },
    ]);
    const updateBlocks = (update: (blocks: ContentBlock[]) => ContentBlock[]) => {
      if (controller.signal.aborted) return;
      setMessages((previous) =>
        previous.map((message) =>
          message.id === assistantId ? { ...message, blocks: update(message.blocks ?? []) } : message,
        ),
      );
    };
    const append = (type: 'text' | 'reasoning', content: string) =>
      updateBlocks((blocks) => {
        const last = blocks.at(-1);
        return last?.type === type
          ? [...blocks.slice(0, -1), { ...last, content: last.content + content }]
          : [...blocks, { type, id: uid(), content }];
      });
    history.current.push({ role: 'user', content: text });
    try {
      await runAgentTurn(
        {
          apiKey: settings.anthropicApiKey,
          workspaceId: settings.anthropicWorkspaceId || '',
        },
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
                      provenance: result.provenance,
                      attempt: result.attempt,
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
            append('text', chunk);
            setActivity('Writing response…');
          },
          onThinking: (chunk) => {
            append('reasoning', chunk);
            setActivity('Thinking…');
          },
          onToolInputStart: (name) => setActivity(toolInputLabel(name) + '…'),
          onToolCall: (name, input) => {
            setActivity(toolActivityLabel(name, input) + '…');
            updateBlocks((blocks) => [
              ...blocks,
              { type: 'tool_call', id: uid(), toolCall: { name, input, isExecuting: true } },
            ]);
          },
          onToolResult: (_name, result) => {
            setActivity('Preparing response…');
            updateBlocks((blocks) =>
              blocks.map((block) =>
                block.type === 'tool_call' && block.toolCall.isExecuting
                  ? {
                      ...block,
                      toolCall: {
                        ...block.toolCall,
                        isExecuting: false,
                        result,
                        error: result.startsWith('Error:') ? result.slice(6).trim() : undefined,
                      },
                    }
                  : block,
              ),
            );
          },
          onDone: (usage) => {
            if (!controller.signal.aborted)
              setMessages((previous) =>
                previous.map((message) => (message.id === assistantId ? { ...message, usage } : message)),
              );
          },
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
      // A cancelled or interrupted tool must not keep showing a live spinner.
      setMessages((previous) =>
        previous.map((message) =>
          message.id === assistantId
            ? {
                ...message,
                blocks: message.blocks?.map((block) =>
                  block.type === 'tool_call' && block.toolCall.isExecuting
                    ? {
                        ...block,
                        toolCall: {
                          ...block.toolCall,
                          isExecuting: false,
                          error: controller.signal.aborted ? 'Cancelled' : 'Interrupted',
                        },
                      }
                    : block,
                ),
              }
            : message,
        ),
      );
      abort.current = null;
      setBusy(false);
      onBusy(false);
      setActivity('');
    }
  }
  return (
    <aside
      ref={panel}
      className="border-l border-border bg-background flex flex-col w-full min-w-0 shrink-0 min-h-0 h-full"
      aria-label="Notebook assistant"
    >
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border shrink-0">
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Sparkles className="h-3.5 w-3.5 text-accent" /> Ask AI
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={busy}
            title="New conversation"
            onClick={() => {
              history.current = [];
              cache.current.clear();
              setMessages([]);
              setProposal(null);
              setApplied('');
              setError('');
            }}
            className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1 px-1.5 py-0.5 disabled:opacity-50"
          >
            <RotateCcw className="h-3 w-3" /> New
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Ask AI panel"
            className="p-1 text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div
        ref={scroller}
        onScroll={() => {
          const el = scroller.current!;
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="flex-1 min-h-0 overflow-auto p-3 space-y-4"
      >
        <div role="log" aria-label="Notebook AI conversation" className="space-y-5">
          {!messages.length && (
            <div className="flex items-start gap-2 text-xs text-muted-foreground pt-2">
              <Sparkles className="h-3.5 w-3.5 text-accent shrink-0" />
              <p>
                {settings.anthropicApiKey
                  ? 'Ask for a new analysis, a chart, or an explanation. Review proposed changes before applying. The assistant may run read queries to inspect your data.'
                  : 'Add your Anthropic API key in Settings to use Ask AI.'}
              </p>
            </div>
          )}
          {messages.map((message, index) =>
            message.role === 'user' ? (
              <ChatMessageUser key={message.id} content={message.text} />
            ) : (
              <ChatMessageAssistant
                key={message.id}
                blocks={message.blocks ?? []}
                isStreaming={busy && index === messages.length - 1}
                onCancel={stopGeneration}
                usage={message.usage}
                model={settings.aiModel || DEFAULT_AI_MODEL}
              />
            ),
          )}
        </div>
        {applied && (
          <p role="status" className="text-sm">
            {applied}
          </p>
        )}
        {proposal && (
          <div className="rounded border p-3 space-y-2 text-sm">
            <strong>{proposal.summary}</strong>
            <p>
              {proposal.document.title} · {proposal.document.cells.length} cells
            </p>
            <Button size="sm" variant="outline" onClick={() => setReviewExpanded(true)}>
              Expand review
            </Button>
            <NotebookProposalReview before={proposal.before} after={proposal.document} />
            <Dialog open={reviewExpanded} onOpenChange={setReviewExpanded}>
              <DialogContent className="sm:max-w-3xl max-h-[90dvh] flex flex-col overflow-hidden">
                <DialogHeader>
                  <DialogTitle>Review notebook changes</DialogTitle>
                  <DialogDescription>{proposal.summary}</DialogDescription>
                </DialogHeader>
                <div className="min-h-0 overflow-y-auto">
                  <NotebookProposalReview before={proposal.before} after={proposal.document} />
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setReviewExpanded(false)}>
                    Back to assistant
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            {fingerprint(document) !== proposal.base && (
              <p>The notebook has changed. Ask for an updated proposal.</p>
            )}
            {busy && <p role="status">Finishing the response before changes can be applied…</p>}
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={disabled || busy || fingerprint(document) !== proposal.base}
                onClick={() => {
                  try {
                    onApply(applyNotebookProposal(latest.current.document, proposal));
                    setApplied(
                      `Changes applied · ${proposal.document.cells.length} cells. Applying did not run SQL. Use Undo to reverse.`,
                    );
                    setError('');
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
      {busy && (
        <div role="status" aria-label="Agent progress" className="shrink-0 border-t bg-muted/40 px-3">
          <ThinkingIndicator label={activity} onCancel={stopGeneration} />
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="shrink-0 border-t border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      )}
      <ChatInput
        onSend={(text) => void send(text)}
        onStop={stopGeneration}
        isLoading={busy}
        disabled={disabled || !settings.anthropicApiKey}
        focused
        placeholder="Ask AI about your notebook…"
      />
    </aside>
  );
}
