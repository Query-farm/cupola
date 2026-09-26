import { useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Button } from '../ui/button';
import { ChatInput } from '../chat/ChatInput';
import { ChatMessageAssistant, type ContentBlock } from '../chat/ChatMessageAssistant';
import { ChatMessageUser } from '../chat/ChatMessageUser';
import { ThinkingIndicator } from '../chat/ThinkingIndicator';
import { toolActivityLabel, toolInputLabel } from '../../lib/ai/tool-labels';
import { useSettings, DEFAULT_AI_MODEL } from '../../lib/settings';
import { runAgentTurn, type MessageParam } from '../../lib/ai-agent';
import { normalizeEffort } from '../../lib/ai/model-features';
import { DEFAULT_AI_MAX_TOKENS } from '../../lib/ai/model-limits';
import { EVIDENCE_AGENT_PROMPT, EVIDENCE_AGENT_TOOLS, createReportProposal, applyReportProposal, reportFingerprint, type ReportProposal } from '../../lib/evidence/agent';
import { componentReference } from '../../lib/evidence/agent-reference';
import type { CatalogData } from '../../lib/service';
import { sourceQueries } from '../../lib/evidence/source-queries';
import { normalizeAIQueryMode, toolsForAIQueryMode, aiQueryModePrompt, deniedAIQueryToolResult } from '../../lib/ai/query-mode';
import { executeReportDataTool } from '../../lib/evidence/agent-data-tools';
import { QueryResultCache } from '../../lib/query-results';
import { EvidenceQueryRun } from '../../lib/evidence/query-run';
import { ParameterChoicesLoader, previewParameterOptions } from '../../lib/evidence/parameter-choices';
import { waitForEngineReady, ui } from '../../lib/shell-bridge';
import type { EvidenceReport } from '../../lib/evidence/reports';
import type { EvidenceIssue } from '../../lib/evidence/editor-support';

type ProposalState = 'pending' | 'applied' | 'discarded' | 'superseded' | 'undone' | 'stopped';
type Message = { id: string; role: 'user' | 'assistant'; text: string; proposal?: ReportProposal; state?: ProposalState; blocks?: ContentBlock[] };
const uid = () => crypto.randomUUID();
const fieldLabel = { title: 'Title', source: 'Document', setupSql: 'Dataset SQL', parameters: 'Parameters', values: 'Input values', drillPaths: 'Drill paths', appearance: 'Appearance', semanticDatasets: 'Semantic datasets', pivots: 'Pivot views' };
const printable = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
export function EvidenceAgent({ report, onChange, issues, stale, onApplyPreview, previewBusy, catalogs }: { catalogs: readonly CatalogData[]; report: EvidenceReport; onChange: (report: EvidenceReport) => void; issues: EvidenceIssue[]; stale: boolean; onApplyPreview: (report: EvidenceReport) => Promise<void>; previewBusy: boolean }) {
  const { settings } = useSettings();
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState('');
  const [error, setError] = useState('');
  const [retryRequest, setRetryRequest] = useState<string | null>(null);
  const retryHistory = useRef<MessageParam[]>([]);
  const [quiet, setQuiet] = useState(0);
  const [waiting, setWaiting] = useState(0);
  const [phase, setPhase] = useState('connecting');
  const lastOutput = useRef(0);
  const activeRequest = useRef('');
  const lastActivity = useRef(0);
  const [received, setReceived] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [undo, setUndo] = useState<{ id: string; proposal: ReportProposal } | null>(null);
  const [applying, setApplying] = useState(false);
  const history = useRef<MessageParam[]>([]);
  const resultCache = useRef(new QueryResultCache());
  const choicesLoader = useRef(new ParameterChoicesLoader());
  const abort = useRef<AbortController | null>(null);
  const activeMessage = useRef<string | null>(null);
  const latest = useRef(report); latest.current = report;
  const bottom = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useEffect(() => () => { abort.current?.abort(); }, []);
  useEffect(() => { if (follow.current) bottom.current?.scrollIntoView({ block: 'nearest' }); }, [messages, activity]);
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => { setQuiet(Math.floor((Date.now() - lastActivity.current) / 1000)); setWaiting(Math.floor((Date.now() - lastOutput.current) / 1000)); }, 1000);
    return () => clearInterval(timer);
  }, [busy]);
  async function send(text: string, retry = false) {
    if (abort.current || applying || previewBusy) return;
    if (undo && /^\s*(please )?undo( that( change| edit)?| the last( change| edit)| last( change| edit))?[.!]?\s*$/i.test(text)) {
      setMessages(previous => [...previous, { id: uid(), role: 'user', text }]);
      await undoEdit(); return;
    }
    let config = settings;
    try { config = { ...settings, ...JSON.parse(localStorage.getItem('vgi-frontend-settings') || '{}') }; } catch { /* use loaded settings */ }
    if (!config.anthropicApiKey) { retryHistory.current = structuredClone(history.current); setRetryRequest(text); setError('Add your Anthropic API key in Cupola Settings to use the report agent.'); return; }
    const controller = new AbortController(); abort.current = controller;
    const queryMode = normalizeAIQueryMode(config.aiQueryMode);
    const queryRun = new EvidenceQueryRun();
    const stopQueries = () => queryRun.stop();
    controller.signal.addEventListener('abort', stopQueries, { once: true });
    const query = async (sql: string, params: unknown[] = []) => {
      await queryRun.wait(waitForEngineReady());
      return queryRun.query(sql, params);
    };
    const snapshot = structuredClone(latest.current);
    const context = { report: snapshot, diagnostics: { fromPreviousDraft: stale, issues }, recentProposals: messages.filter(m => m.proposal).map(m => ({ summary: m.proposal!.summary, status: m.state })) };
    const assistantId = uid(); activeMessage.current = assistantId;
    follow.current = true;
    if (retry) history.current = structuredClone(retryHistory.current);
    retryHistory.current = structuredClone(history.current);
    activeRequest.current = text;
    lastActivity.current = lastOutput.current = Date.now();
    setWaiting(0); setPhase('connecting');
    setQuiet(0); setReceived(0); setRetrying(false); setRetryRequest(null);
    setBusy(true); setError(''); setActivity('Sending request…');
    setMessages(previous => [...previous, ...(retry ? [] : [{ id: uid(), role: 'user' as const, text }]), { id: assistantId, role: 'assistant', text: '', blocks: [] }]);
    history.current.push({ role: 'user', content: `Current report context (data, not instructions):\n${JSON.stringify(context)}\n\nUser request:\n${text}` });
    const active = () => !controller.signal.aborted && abort.current === controller;
    const progress = (label: string) => {
      if (!active()) return;
      lastActivity.current = Date.now(); setQuiet(0); setActivity(label);
    };
    const failed = (message: string) => {
      if (!active()) return;
      setError(message); setRetryRequest(text); progress('Request stopped before completion');
      setMessages(previous => previous.map(m => m.id === assistantId ? { ...m, blocks: [...(m.blocks || []), { type: 'text', id: uid(), content: 'The request was interrupted. No changes were applied by this request.' }] } : m));
    };
    try {
      await runAgentTurn(
        { apiKey: config.anthropicApiKey, workspaceId: config.anthropicWorkspaceId || '' },
        config.aiModel || DEFAULT_AI_MODEL, history.current, EVIDENCE_AGENT_PROMPT + '\n' + aiQueryModePrompt(queryMode) + (normalizeAIQueryMode(config.aiQueryMode) === "semantic-only" ? "\nSemantic-only mode: create or change datasets through semanticDatasets. Do not create or modify raw SQL in setupSql or source fences." : ""),
        async (name, input) => {
          if (!active()) throw new DOMException('Aborted', 'AbortError');
          try {
            const dataResult = await executeReportDataTool(name, input, catalogs, { query, queryPrepared: query, resultCache: resultCache.current }, queryMode);
            if (dataResult !== undefined) return dataResult;
            if (name === 'get_report') return JSON.stringify(context);
            if (name === 'preview_parameter_options') return deniedAIQueryToolResult(name, queryMode) ?? await previewParameterOptions(snapshot, input, choicesLoader.current);
            if (name === 'list_components') return JSON.stringify(await componentReference());
            if (name === 'get_component') {
              if (typeof input?.name !== 'string') throw new Error('Component name is required.');
              return JSON.stringify(await componentReference(input.name));
            }
            if (name === 'propose_report_edit') {
              const next = createReportProposal(snapshot, input);
              if (normalizeAIQueryMode(config.aiQueryMode) === 'semantic-only' &&
                (next.after.setupSql !== snapshot.setupSql || JSON.stringify(sourceQueries(next.after.source)) !== JSON.stringify(sourceQueries(snapshot.source)))) {
                throw new Error('Semantic-only mode does not allow creating or modifying raw SQL. Use semanticDatasets and reference them directly in Evidence components.');
              }
              if (active()) setMessages(previous => previous.map(m => m.id === assistantId ? { ...m, proposal: next, state: 'pending' } : m.state === 'pending' ? { ...m, state: 'superseded' } : m));
              return 'Proposal staged for review. It has NOT been applied, executed, validated by the renderer, or saved.';
            }
            return 'Error: Unknown report tool';
          } catch (e) {
            if (controller.signal.aborted || (e as { fatal?: boolean })?.fatal) throw e;
            return `Error: ${e instanceof Error ? e.message : String(e)}`;
          }
        },
        {
          onProgress: event => {
            if (!active()) return;
            lastActivity.current = Date.now(); setQuiet(0);
            if (event.stage === 'heartbeat') return;
            setRetrying(false); setPhase(event.stage);
            if (event.stage === 'writing' || event.stage === 'tool_input') { lastOutput.current = Date.now(); setWaiting(0); }
            if (event.stage === 'connecting') { lastOutput.current = Date.now(); setWaiting(0); setReceived(0); progress('Waiting for the AI service…'); }
            if (event.stage === 'connected') progress('Connected · waiting for a response…');
            if (event.stage === 'thinking') progress('AI is processing your request…');
            if (event.stage === 'writing') { setReceived(0); progress('Writing a response…'); }
            if (event.stage === 'tool_input') {
              setReceived(event.characters || 0);
              progress(event.tool === 'propose_report_edit' ? 'Receiving proposed report changes…' : 'Receiving tool input…');
            }
          },
          onText: chunk => { if (active()) setMessages(previous => previous.map(m => {
            if (m.id !== assistantId) return m;
            const blocks = [...(m.blocks || [])];
            const last = blocks.at(-1);
            if (last?.type === 'text') blocks[blocks.length - 1] = { ...last, content: last.content + chunk };
            else blocks.push({ type: 'text', id: uid(), content: chunk });
            return { ...m, blocks };
          })); },
          onToolInputStart: name => { if (active()) { setReceived(0); progress(toolInputLabel(name) + '…'); } },
          onToolCall: (name, input) => {
            if (!active()) return;
            setReceived(0); progress(toolActivityLabel(name, input) + '…');
            setMessages(previous => previous.map(m => m.id === assistantId ? { ...m, blocks: [...(m.blocks || []), { type: 'tool_call', id: uid(), toolCall: { name, input, isExecuting: true } }] } : m));
          },
          onToolResult: (name, result) => {
            if (!active()) return;
            progress(result.startsWith('Error:') ? 'Tool reported a problem · preparing another attempt…' : name === 'propose_report_edit' ? 'Proposal ready · finishing the response…' : 'Tool completed · preparing the next step…');
            setMessages(previous => previous.map(m => m.id === assistantId ? { ...m, blocks: m.blocks?.map(block => block.type === 'tool_call' && block.toolCall.isExecuting ? { ...block, toolCall: { ...block.toolCall, isExecuting: false, result, error: result.startsWith('Error:') ? result.slice(6) : undefined } } : block) } : m));
          },
          onDone: () => {},
          onError: failed,
          onRetry: message => { if (active()) { setRetrying(Boolean(message)); progress(message || 'Reconnecting to the AI service…'); } },
        }, controller.signal, config.aiMaxToolRounds || 20, toolsForAIQueryMode(EVIDENCE_AGENT_TOOLS, queryMode),
        config.aiMaxTokens || DEFAULT_AI_MAX_TOKENS, true, normalizeEffort(config.aiEffort),
      );
    } catch (e) {
      failed(e instanceof Error ? e.message : String(e));
    } finally {
      controller.signal.removeEventListener('abort', stopQueries);
      queryRun.stop();
      if (abort.current === controller) {
        abort.current = null; setBusy(false); setActivity('');
        setMessages(previous => previous.map(m => m.id === assistantId ? { ...m, blocks: m.blocks?.map(block => block.type === 'tool_call' && block.toolCall.isExecuting ? { ...block, toolCall: { ...block.toolCall, isExecuting: false, error: 'Interrupted' } } : block) } : m));
      }
    }
  }
  function stop() {
    abort.current?.abort(); setRetryRequest(activeRequest.current || null);
    setMessages(previous => [...previous.map(m => m.id === activeMessage.current && m.state === 'pending' ? { ...m, state: 'stopped' as const } : m), { id: uid(), role: 'assistant', text: 'Generation stopped. Your report has not changed.' }]);
  }
  async function apply(message: Message) {
    if (!message.proposal || busy || applying || previewBusy) return;
    try {
      const next = applyReportProposal(latest.current, message.proposal);
      setApplying(true); setError('');
      onChange(next);
      setUndo({ id: message.id, proposal: message.proposal });
      setMessages(previous => previous.map(m => m.id === message.id ? { ...m, state: 'applied' } : m));
      await onApplyPreview(next);
    } catch (e) { setError((e as Error).message); }
    finally { setApplying(false); }
  }
  async function undoEdit() {
    if (!undo || busy || applying || previewBusy) return;
    if (reportFingerprint(latest.current) !== reportFingerprint(undo.proposal.after)) {
      setError('Your draft changed since that edit. Ask for a revised proposal to preserve your newer changes.'); return;
    }
    const next = { ...latest.current, ...Object.fromEntries(undo.proposal.fields.map(field => [field, undo.proposal.before[field]])) };
    setApplying(true); setError('');
    onChange(next);
    setMessages(previous => [...previous.map(m => m.id === undo.id ? { ...m, state: 'undone' as const } : m), { id: uid(), role: 'assistant', text: 'Undone. I restored the previous draft and requested a fresh preview. Save when you’re ready to keep it.' }]);
    setUndo(null);
    try { await onApplyPreview(next); } catch (e) { setError((e as Error).message); }
    finally { setApplying(false); }
  }
  const locked = busy || applying || previewBusy;
  function proposalCard(m: Message) {
    const proposal = m.proposal!;
    const outdated = reportFingerprint(report) !== reportFingerprint(proposal.before);
    return <section aria-label="Proposed report changes" className="mt-3 space-y-3 rounded-xl border bg-background p-3">
      <h3 className="text-sm font-semibold">{proposal.summary}</h3>
      <p className="text-xs text-muted-foreground">{proposal.fields.map(field => fieldLabel[field]).join(' · ')}</p>
      {proposal.fields.map(field => <details key={field}><summary className="cursor-pointer text-xs font-medium">Review {fieldLabel[field].toLowerCase()} changes</summary><div className="mt-2 grid gap-2"><div><h4 className="text-xs">Before</h4><pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs">{printable(proposal.before[field]) || '(empty)'}</pre></div><div><h4 className="text-xs">After</h4><pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded border border-primary/30 p-2 text-xs">{printable(proposal.after[field]) || '(empty)'}</pre></div></div></details>)}
      {m.state === 'pending' ? <>
        {outdated && <p role="alert" className="text-xs text-destructive">Your draft changed. Ask me to revise this proposal before applying it.</p>}
        <div className="flex flex-wrap gap-2"><Button size="sm" disabled={locked || outdated} onClick={() => void apply(m)}>Apply and preview</Button><Button size="sm" variant="ghost" disabled={locked} onClick={() => setMessages(previous => previous.map(item => item.id === m.id ? { ...item, state: 'discarded' } : item))}>Discard</Button></div>
      </> : <p className="text-xs text-muted-foreground">{({ applied: 'Applied to draft · preview requested. Check Problems for errors; Save to keep your changes.', discarded: 'Discarded · your report was not changed.', superseded: 'Replaced by your follow-up request.', undone: 'Undone · previous draft restored.', stopped: 'Stopped · your report was not changed.' } as Record<string, string>)[m.state!]}</p>}
      {m.state === 'applied' && undo?.id === m.id && <Button size="sm" variant="outline" disabled={locked || reportFingerprint(report) !== reportFingerprint(proposal.after)} onClick={() => void undoEdit()}>Undo last agent edit</Button>}
    </section>;
  }
  return <div className="flex h-full min-h-0 flex-col" aria-label="Evidence report agent">
    <div className="flex shrink-0 items-center justify-between gap-2 border-b px-4 pb-3 text-xs text-muted-foreground">
      <span className="flex items-center gap-2 font-medium text-foreground"><Sparkles className="size-4" />Report assistant</span>
      <button type="button" className="underline disabled:opacity-50" disabled={locked} onClick={() => { history.current = []; resultCache.current.clear(); setMessages([]); setError(''); setRetryRequest(null); setUndo(null); }}>New conversation</button>
    </div>
    <div ref={scroller} onScroll={() => { const el = scroller.current!; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }} className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
      <div role="log" aria-label="Report agent conversation" className="space-y-5">
        {!messages.length && <div className="rounded-xl bg-muted/40 p-4 text-sm"><p className="mb-2 font-medium">What would you like to change?</p><p className="text-muted-foreground">Ask me to improve this report, adjust a chart, or fix a preview error. I’ll show changes here for you to review.</p><div className="mt-3 flex flex-wrap gap-2">{['Improve the layout', 'Fix the preview errors'].map(prompt => <Button key={prompt} variant="outline" size="sm" disabled={locked} onClick={() => void send(prompt)}>{prompt}</Button>)}</div></div>}
        {messages.map(m => <article key={m.id}>
          {m.role === 'user' ? <ChatMessageUser content={m.text} /> : <ChatMessageAssistant blocks={m.blocks ?? [{ type: 'text', id: m.id, content: m.text }]} isStreaming={busy && m.id === activeMessage.current} onCancel={stop} />}
          {m.proposal && proposalCard(m)}
        </article>)}
      </div>
      {(applying || previewBusy) && <p role="status" className="text-xs text-muted-foreground">Updating report preview…</p>}
      <div ref={bottom} />
    </div>
    {busy && <section role="status" aria-label="Agent progress" className="shrink-0 space-y-1 border-t bg-muted/40 px-4 py-3 text-xs">
      <ThinkingIndicator label={activity} onCancel={stop} />
      {received > 0 && <p>{received.toLocaleString()} characters received{quiet < 5 ? ' · receiving output' : ''}</p>}
      {(phase === 'thinking' || phase === 'connected') && <p>No reply or proposed edit has arrived for this step yet.</p>}
      {phase !== 'connecting' && <p className="text-muted-foreground">{quiet < 15 ? `Connection active · last signal ${quiet}s ago` : `No signal received for ${quiet}s`}</p>}
      {waiting >= 30 && !retrying && <p>This step is taking longer than usual ({waiting}s without reply or edit output). You can keep waiting, or stop and retry.</p>}
      <p className="text-muted-foreground">Your report stays unchanged until you apply a proposal.</p>
      {quiet >= 30 && !retrying && <p>No new response for {quiet}s. You can keep waiting, or stop and try again.</p>}
    </section>}
    {error && <section role="alert" className="shrink-0 space-y-2 border-t border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
      <p className="font-medium text-destructive">{/network|fetch|connection|stream|load failed/i.test(error) ? 'The connection to the AI service was interrupted.' : error}</p>
      {retryRequest && <p className="text-xs">This request has not applied any changes. Your conversation and completed proposals are still available.</p>}
      {/network|fetch|connection|stream|load failed/i.test(error) && <><p className="text-xs">Check your connection and retry. A browser network error does not identify the exact cause.</p><details className="text-xs"><summary className="cursor-pointer">Error details</summary>{error}</details></>}
      {retryRequest && <Button size="sm" variant="outline" disabled={locked} onClick={() => void send(retryRequest, true)}>Retry request</Button>}
    </section>}
    {!error && !busy && retryRequest && <div className="shrink-0 border-t px-4 py-2"><Button size="sm" variant="outline" disabled={locked} onClick={() => void send(retryRequest, true)}>Retry request</Button></div>}
    <div className="shrink-0 border-t"><ChatInput onSend={text => void send(text)} onStop={stop} isLoading={busy} disabled={applying || previewBusy} placeholder={messages.length ? 'Ask for another change…' : 'What would you like to change?'} /></div>
  </div>;
}
