import { compilePdf } from './compiler';
import { emitTypst } from './emit';
import { extractReport } from './extract';
import { contentWidthPx, defaultPaper, dropRepeatedTitle, type PdfFont, type PdfTheme } from './model';
import { loadChartRenderer } from './charts';
import { loadPdfFonts, loadTypstCompiler } from './load-compiler';
import { loadSnapshotRenderer } from './snapshot';
import type { CoverageEntry } from './components';

export interface PdfExportRequest {
  /** The rendered report: Evidence's `[data-markdoc-content]` root. */
  root: Element;
  title: string;
  meta: { label: string; value: string }[];
  fonts: { heading: string; body: string };
  /** The report's accent color, when it suits white paper. */
  accent?: string;
}

export interface PdfExportResult { pdf: Blob; omitted: string[]; coverage: CoverageEntry[] }

const font = (value: string): PdfFont => value === 'serif' || value === 'mono' ? value : 'sans-serif';

export async function exportReportPdf(request: PdfExportRequest): Promise<PdfExportResult> {
  // Start the heavy download while the DOM is read.
  const compiler = loadTypstCompiler();
  const theme: PdfTheme = {
    heading: font(request.fonts.heading), body: font(request.fonts.body),
    // Paper is always light, whatever the on-screen mode.
    accent: request.accent ?? '#685442', foreground: '#1f1d1a', muted: '#6b6b5a', border: '#dcd7ca',
    paper: defaultPaper(navigator.language),
  };
  const [chartRenderer, snapshotRenderer] = await Promise.all([loadChartRenderer(), loadPdfFonts().then(loadSnapshotRenderer)]);
  const extraction = await extractReport(request.root, contentWidthPx(theme.paper), chartRenderer, snapshotRenderer);
  const { main, files } = emitTypst({ title: request.title, meta: request.meta, theme, blocks: dropRepeatedTitle(extraction.blocks, request.title), files: extraction.files });
  // `window.__cupolaPdfDebug = true` keeps the last export's Typst source and files for inspection.
  const debug = window as { __cupolaPdfDebug?: unknown };
  if (debug.__cupolaPdfDebug) debug.__cupolaPdfDebug = { main, files, coverage: extraction.coverage };
  const bytes = await compilePdf(await compiler, main, files);
  return { pdf: new Blob([bytes as BlobPart], { type: 'application/pdf' }), omitted: extraction.omitted, coverage: extraction.coverage };
}

/** A filesystem-safe name derived from the report title. */
export function pdfFileName(title: string): string {
  const stem = title.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase().slice(0, 80);
  return `${stem || 'report'}.pdf`;
}
