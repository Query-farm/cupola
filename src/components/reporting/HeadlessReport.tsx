import { useEffect, useRef, useState } from 'react';
import { EvidencePreview, type ReportRun } from '../evidence/EvidencePreview';
import { EvidenceQueryRun } from '../../lib/evidence/query-run';
import { validateEvidenceReport, resolveParameters } from '../../lib/evidence/reports';
import { buildReportTheme } from '../../lib/evidence/report-theme';
import { engine } from '../../lib/shell-bridge';
import { extractReport, settleDom } from '../../lib/evidence/typst/extract';
import { loadChartRenderer } from '../../lib/evidence/typst/charts';
import { loadSnapshotRenderer } from '../../lib/evidence/typst/snapshot';
import { loadPdfFonts } from '../../lib/evidence/typst/load-compiler';
import { contentWidthPx, defaultPaper } from '../../lib/evidence/typst/model';
import { reportHtml } from '../../lib/reporting/export-html';

interface Bootstrap { body: string; values: Record<string, unknown>; title: string }
interface RenderBridge {
  protocol: 1;
  start(input: Bootstrap): Promise<void>;
  export(mediaType: string): Promise<string>;
}
declare global {
  interface Window {
    cupolaRenderer?: RenderBridge;
    cupolaRenderQuery?: (sql: string, params: unknown[]) => Promise<{ ok: boolean; arrow?: string; error?: string }>;
  }
}
function bytes64(bytes: Uint8Array): string {
  let text = ''; for (let start = 0; start < bytes.length; start += 8192) text += String.fromCharCode(...bytes.subarray(start, start + 8192));
  return btoa(text);
}

/** Dedicated renderer entry point: no app shell, browser identity, or saved state. */
export function HeadlessReport() {
  const [run, setRun] = useState<ReportRun | null>(null);
  const current = useRef<ReportRun | null>(null);
  const pending = useRef(0), failure = useRef(''), mounted = useRef(false);
  const host = useRef<HTMLDivElement>(null);
  const theme = buildReportTheme(run?.report.appearance, false, {});
  const themeRef = useRef(theme); themeRef.current = theme;
  useEffect(() => {
    const query = async (sql: string, params: unknown[] = []) => {
      if (!window.cupolaRenderQuery) throw new Error('The worker query bridge is unavailable.');
      const response = await window.cupolaRenderQuery(sql, params);
      const bytes = response.arrow ? Uint8Array.from(atob(response.arrow), char => char.charCodeAt(0)) : undefined;
      return { ok: response.ok, error: response.error, arrowBuffers: bytes ? [bytes.buffer] : undefined };
    };
    engine.query = sql => query(sql);
    engine.queryPrepared = (sql, params) => query(sql, params);
    const root = () => host.current?.querySelector('[data-testid="evidence-preview"]')?.shadowRoot?.querySelector('[data-markdoc-content]');
    async function settle() {
      const deadline = Date.now() + 90_000;
      let quiet = 0;
      while (Date.now() < deadline) {
        if (failure.current) throw new Error(failure.current);
        const element = root();
        quiet = mounted.current && element && pending.current === 0 && !element.querySelector('[data-echarts-ready="false"]') ? quiet + 1 : 0;
        if (quiet >= 8 && element) { await document.fonts.ready; return element; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('The report did not finish rendering within 90 seconds.');
    }
    window.cupolaRenderer = {
      protocol: 1,
      async start(input) {
        if (current.current) throw new Error('Each browser context renders one report.');
        const body = JSON.parse(input.body);
        if (body.version !== 1 || !body.document) throw new Error('Unsupported Cupola report body.');
        const report = validateEvidenceReport({ ...body.document, version: 1, id: 'headless', title: input.title,
          serviceUrl: 'headless', createdAt: Date.now(), updatedAt: Date.now(), values: input.values });
        if (report.semanticDatasets?.length || report.pivots?.length) throw new Error('This renderer does not yet support semantic datasets or saved pivots.');
        const values = resolveParameters(report);
        const execution = new EvidenceQueryRun(count => { pending.current = count; });
        const next: ReportRun = { report, values, execution, semanticQueries: {}, semanticStates: [], revision: 1 };
        current.current = next; setRun(next);
        await settle();
      },
      async export(mediaType) {
        const element = await settle(), active = current.current!;
        const appearance = themeRef.current;
        if (mediaType === 'application/pdf') {
          const { exportReportPdf } = await import('../../lib/evidence/typst/export-pdf');
          const result = await exportReportPdf({ root: element, title: active.report.title, meta: [], fonts: appearance.config.fonts,
            updated: new Date().toISOString(), settle: async () => { await settle(); } });
          if (result.omitted.length) throw new Error(`Unsupported export components: ${result.omitted.join(', ')}`);
          if (failure.current) throw new Error(failure.current);
          return bytes64(new Uint8Array(await result.pdf.arrayBuffer()));
        }
        if (mediaType === 'text/html') {
          const charts = await loadChartRenderer(), snapshots = await loadSnapshotRenderer(await loadPdfFonts());
          const extracted = await extractReport(element, contentWidthPx(defaultPaper(navigator.language)), charts, snapshots, '', async () => { await settleDom(element); await settle(); });
          if (failure.current) throw new Error(failure.current);
          return bytes64(new TextEncoder().encode(reportHtml(active.report.title, extracted.blocks, extracted.files)));
        }
        throw new Error('Unsupported output media type.');
      },
    };
    return () => { current.current?.execution.stop(); delete window.cupolaRenderer; engine.query = null; engine.queryPrepared = null; };
  }, []);
  return <main ref={host} style={theme.style} className="mx-auto max-w-6xl p-8">
    {run ? <EvidencePreview run={run} reportTheme={theme} onQuery={entry => { if (entry.error) failure.current ||= entry.error; }} onError={message => { failure.current ||= message; }} onIssues={issues => { const issue = issues.find(item => item.severity === 'error'); if (issue) failure.current ||= issue.message; }} onData={() => { mounted.current = true; }} /> : <p>Waiting for a worker render request.</p>}
  </main>;
}
