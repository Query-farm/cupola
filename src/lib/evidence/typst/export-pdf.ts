import { compilePdf } from './compiler';
import { emitTypst } from './emit';
import { extractReport } from './extract';
import { contentWidthPx, defaultPaper, type Block, type PdfFont, type PdfTheme } from './model';
import { loadChartRenderer } from './charts';
import { loadPdfFonts, loadTypstCompiler } from './load-compiler';
import { loadSnapshotRenderer } from './snapshot';
import type { CoverageEntry } from './components';
import type { FilterSummary } from '../filter-summary';

export interface PdfDocumentRequest {
  title: string;
  meta: { label: string; value: string }[];
  /** When the report's data was refreshed, in full (date and time). */
  updated?: string;
  /** Parameters and inputs in effect, listed after the content. */
  filters?: FilterSummary;
  /** A link back to the view, printed under the header metadata. */
  link?: { label: string; url: string };
  fonts: { heading: string; body: string };
  /** The report's accent color, when it suits white paper. */
  accent?: string;
}
export interface PdfExportRequest extends PdfDocumentRequest {
  /** The rendered report: Evidence's `[data-markdoc-content]` root. */
  root: Element;
}

export interface PdfExportResult { pdf: Blob; omitted: string[]; coverage: CoverageEntry[] }

const font = (value: string): PdfFont => value === 'serif' || value === 'mono' ? value : 'sans-serif';

/** A PDF built from one or more rendered reports: each `addSection` reads the report as it is
 *  on screen now, so a caller can re-render between sections (one section per parameter value). */
export function createPdfExport(request: PdfDocumentRequest) {
  // Start the heavy download while the DOM is read.
  const compiler = loadTypstCompiler();
  const theme: PdfTheme = {
    heading: font(request.fonts.heading), body: font(request.fonts.body),
    // Paper is always light, whatever the on-screen mode.
    accent: request.accent ?? '#685442', foreground: '#1f1d1a', muted: '#6b6b5a', border: '#dcd7ca',
    paper: defaultPaper(navigator.language),
  };
  const renderers = Promise.all([loadChartRenderer(), loadPdfFonts().then(loadSnapshotRenderer)]);
  const blocks: Block[] = [];
  const files: Record<string, string | Uint8Array> = {};
  const omitted: string[] = [];
  const coverage: CoverageEntry[] = [];
  let sections = 0;
  return {
    async addSection(root: Element, heading?: string) {
      const [chartRenderer, snapshotRenderer] = await renderers;
      const extraction = await extractReport(root, contentWidthPx(theme.paper), chartRenderer, snapshotRenderer, sections ? `s${sections}-` : '');
      if (heading) {
        if (sections) blocks.push({ kind: 'pagebreak' });
        blocks.push({ kind: 'heading', level: 1, children: [{ kind: 'text', text: heading }] });
      }
      // The report's own content, its first heading included: the PDF prints no title of its own.
      blocks.push(...extraction.blocks);
      Object.assign(files, extraction.files);
      omitted.push(...extraction.omitted);
      coverage.push(...extraction.coverage);
      sections++;
    },
    async finish(): Promise<PdfExportResult> {
      const { main, files: all } = emitTypst({ title: request.title, meta: request.meta, updated: request.updated, filters: request.filters?.filters, appendix: request.filters?.appendix, link: request.link, theme, blocks, files });
      // `window.__cupolaPdfDebug = true` keeps the last export's Typst source and files for inspection.
      const debug = window as { __cupolaPdfDebug?: unknown };
      if (debug.__cupolaPdfDebug) debug.__cupolaPdfDebug = { main, files: all, coverage };
      const bytes = await compilePdf(await compiler, main, all);
      return { pdf: new Blob([bytes as BlobPart], { type: 'application/pdf' }), omitted, coverage };
    },
  };
}

export async function exportReportPdf(request: PdfExportRequest): Promise<PdfExportResult> {
  const pdf = createPdfExport(request);
  await pdf.addSection(request.root);
  return pdf.finish();
}

/** A filesystem-safe name derived from the report title. */
export function pdfFileName(title: string): string {
  const stem = title.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase().slice(0, 80);
  return `${stem || 'report'}.pdf`;
}
