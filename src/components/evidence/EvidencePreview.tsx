import { manageReportChartTooltips } from '../../lib/evidence/chart-tooltips';
import { getInstanceByDom } from 'echarts';
import { attachDrill, type DrillChart } from '../../lib/evidence/drill';
import { preserveReportCharts } from './useReportPrint';
import type { EvidenceQueryRun } from '../../lib/evidence/query-run';
import { useEffect, useRef, useState } from 'react';
import { writable, type Readable } from 'svelte/store';
import type { ThemeConfig } from '@evidence/core/types/theme';
import type { SemanticDatasetState } from '../../lib/evidence/semantic-datasets';
import type { ReportTheme } from '../../lib/evidence/report-theme';
import type { Component as SvelteComponent } from 'svelte';
import { toReportParameters, type EvidenceReport, type ParameterValues } from '../../lib/evidence/reports';
import type { HaybarnQueryService, QueryLogEntry } from '../../lib/evidence/haybarn-query-service';
import type { EvidenceDataContext } from '../../lib/evidence/data-browser';
import styles from '../../styles/evidence.css?inline';
import type { EvidenceIssue } from '../../lib/evidence/editor-support';

export interface ReportRun { execution: EvidenceQueryRun; report: EvidenceReport; values: ParameterValues; semanticQueries: Record<string, string>; semanticStates: SemanticDatasetState[]; revision: number }
/** An Evidence input's current value (see EvidenceDocument.svelte). */
export interface EvidenceInputState { id: string; component: string; value: unknown; title?: string }
/** Click-to-drill: `match` says whether a clicked category or cell names the next level; `version`
 *  changes when that answer may have (choices loaded), so marked cells are rescanned. */
export interface PreviewDrill { match: (text: string) => boolean; onDrill: (text: string) => void; version: string }
export function EvidencePreview({ run, onQuery, onError, onIssues, onData, onInputs, drill, reportTheme }: { reportTheme: ReportTheme; run: ReportRun; onInputs?: (read: () => EvidenceInputState[]) => void; drill?: PreviewDrill; onQuery: (entry: QueryLogEntry) => void; onError: (message: string) => void; onIssues: (issues: EvidenceIssue[]) => void; onData: (context: EvidenceDataContext) => void }) {
  const [themeConfig] = useState(() => writable(reportTheme.config));
  const themeStyle = useRef<HTMLStyleElement | null>(null);
  const themeTarget = useRef<HTMLDivElement | null>(null);
  const latestTheme = useRef(reportTheme); latestTheme.current = reportTheme;
  const host = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onQuery, onError, onIssues, onData, onInputs, drill });
  callbacks.current = { onQuery, onError, onIssues, onData, onInputs, drill };
  const drillScan = useRef<(() => void) | null>(null);
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
    const cleanupTooltips = manageReportChartTooltips(host.current!, root);
    const drilling = attachDrill(root, {
      match: text => callbacks.current.drill?.match(text) ?? false,
      onDrill: text => callbacks.current.drill?.onDrill(text),
      getInstance: element => getInstanceByDom(element) as unknown as DrillChart | undefined,
    });
    drillScan.current = drilling.rescan;
    const cleanupPrint = preserveReportCharts(host.current!, root);
    void (async () => {
      try {
        const [{ mount, unmount }, { default: Component }, { HaybarnQueryService }] = await Promise.all([
          import('svelte'), import('./EvidenceDocument.svelte'), import('../../lib/evidence/haybarn-query-service'),
        ]);
        if (disposed) return;
        const service = new HaybarnQueryService(entry => { if (!disposed) callbacks.current.onQuery(entry); }, toReportParameters(run.report.parameters, run.values), run.values, run.execution);
        const renderer = Component as unknown as SvelteComponent<{ parameterFilters: { id: string; value: unknown; column?: string }[]; onInputs: (read: () => EvidenceInputState[]) => void; semanticQueries: Record<string, string>; semanticStates: SemanticDatasetState[]; themeConfig: Readable<ThemeConfig>; markdown: string; service: HaybarnQueryService; onIssues: (issues: EvidenceIssue[]) => void; onData: (context: EvidenceDataContext) => void; onError: (message: string) => void }>;
        // Date ranges have no single-column predicate; they stay `$key_start` / `$key_end` only.
        const parameterFilters = run.report.parameters.filter(parameter => parameter.type !== 'date_range')
          .map(parameter => ({ id: parameter.key, value: run.values[parameter.key], column: parameter.filterColumn || parameter.key }));
        const instance = mount(renderer, { target, props: { semanticQueries: run.semanticQueries, semanticStates: run.semanticStates, themeConfig, markdown: run.report.source, service, parameterFilters,
          onInputs: read => { if (!disposed) callbacks.current.onInputs?.(read); },
          onData: context => { if (!disposed) callbacks.current.onData(context); },
          onIssues: issues => { if (!disposed) callbacks.current.onIssues(issues); },
          onError: error => { if (!disposed) callbacks.current.onError(error); },
        } });
        cleanup = () => { void unmount(instance); };
      } catch (error) { if (!disposed) callbacks.current.onError(error instanceof Error ? error.message : String(error)); }
    })();
    return () => { disposed = true; drillScan.current = null; drilling.dispose(); cleanupTooltips(); cleanupPrint(); run.execution.stop(); cleanup?.(); };
  }, [run]);
  useEffect(() => { drillScan.current?.(); }, [drill?.version]);
  useEffect(() => {
    themeConfig.set(reportTheme.config);
    if (themeStyle.current) themeStyle.current.textContent = reportTheme.css;
    themeTarget.current?.classList.toggle('dark', reportTheme.mode === 'dark');
  }, [reportTheme, themeConfig]);
  return <div ref={host} data-testid="evidence-preview" />;
}
