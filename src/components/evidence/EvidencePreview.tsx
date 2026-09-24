import { useEffect, useRef, useState } from 'react';
import { writable, type Readable } from 'svelte/store';
import type { ThemeConfig } from '@evidence/core/types/theme';
import type { SemanticDatasetState } from '../../lib/evidence/semantic-datasets';
import type { ReportTheme } from '../../lib/evidence/report-theme';
import type { Component as SvelteComponent } from 'svelte';
import type { EvidenceReport, ParameterValues } from '../../lib/evidence/reports';
import type { HaybarnQueryService, QueryLogEntry } from '../../lib/evidence/haybarn-query-service';
import type { EvidenceDataContext } from '../../lib/evidence/data-browser';
import styles from '../../styles/evidence.css?inline';
import type { EvidenceIssue } from '../../lib/evidence/editor-support';

export interface ReportRun { report: EvidenceReport; values: ParameterValues; semanticQueries: Record<string, string>; semanticStates: SemanticDatasetState[]; revision: number }
export function EvidencePreview({ run, onQuery, onError, onIssues, onData, reportTheme }: { reportTheme: ReportTheme; run: ReportRun; onQuery: (entry: QueryLogEntry) => void; onError: (message: string) => void; onIssues: (issues: EvidenceIssue[]) => void; onData: (context: EvidenceDataContext) => void }) {
  const [themeConfig] = useState(() => writable(reportTheme.config));
  const themeStyle = useRef<HTMLStyleElement | null>(null);
  const themeTarget = useRef<HTMLDivElement | null>(null);
  const latestTheme = useRef(reportTheme); latestTheme.current = reportTheme;
  const host = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onQuery, onError, onIssues, onData });
  callbacks.current = { onQuery, onError, onIssues, onData };
  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    const root = host.current!.shadowRoot ?? host.current!.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    // Core defines its own light tokens at :root; inherit Cupola's tokens instead.
    style.textContent = styles.replaceAll(':root', ':host');
    const target = document.createElement('div');
    target.classList.add('evidence-theme');
    const appearanceStyle = document.createElement('style');
    appearanceStyle.textContent = latestTheme.current.css;
    target.classList.toggle('dark', latestTheme.current.mode === 'dark');
    themeStyle.current = appearanceStyle; themeTarget.current = target;
    root.replaceChildren(style, appearanceStyle, target);
    void (async () => {
      try {
        const [{ mount, unmount }, { default: Component }, { HaybarnQueryService }] = await Promise.all([
          import('svelte'), import('./EvidenceDocument.svelte'), import('../../lib/evidence/haybarn-query-service'),
        ]);
        if (disposed) return;
        const service = new HaybarnQueryService(entry => { if (!disposed) callbacks.current.onQuery(entry); }, run.report.parameters, run.values);
        const renderer = Component as unknown as SvelteComponent<{ semanticQueries: Record<string, string>; semanticStates: SemanticDatasetState[]; themeConfig: Readable<ThemeConfig>; markdown: string; service: HaybarnQueryService; onIssues: (issues: EvidenceIssue[]) => void; onData: (context: EvidenceDataContext) => void; onError: (message: string) => void }>;
        const instance = mount(renderer, { target, props: { semanticQueries: run.semanticQueries, semanticStates: run.semanticStates, themeConfig, markdown: run.report.source, service,
          onData: context => { if (!disposed) callbacks.current.onData(context); },
          onIssues: issues => { if (!disposed) callbacks.current.onIssues(issues); },
          onError: error => { if (!disposed) callbacks.current.onError(error); },
        } });
        cleanup = () => { void unmount(instance); };
      } catch (error) { if (!disposed) callbacks.current.onError(error instanceof Error ? error.message : String(error)); }
    })();
    return () => { disposed = true; cleanup?.(); };
  }, [run]);
  useEffect(() => {
    themeConfig.set(reportTheme.config);
    if (themeStyle.current) themeStyle.current.textContent = reportTheme.css;
    themeTarget.current?.classList.toggle('dark', reportTheme.mode === 'dark');
  }, [reportTheme, themeConfig]);
  return <div ref={host} data-testid="evidence-preview" />;
}
