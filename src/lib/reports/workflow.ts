import { validateReportStructure } from './validation';
import { createEmptyReport, type ReportDocumentV1, type ReportParameterValue, type ReportBlock, type ReportDataset } from './types';

export interface DraftHistory { present: ReportDocumentV1 | null; past: ReportDocumentV1[]; future: ReportDocumentV1[] }
export type DraftAction = { type: 'set'; value: ReportDocumentV1 | null | ((current: ReportDocumentV1 | null) => ReportDocumentV1 | null) } | { type: 'reset'; value: ReportDocumentV1 | null } | { type: 'undo' } | { type: 'redo' };
export function draftHistory(state: DraftHistory, action: DraftAction): DraftHistory {
  if (action.type === 'reset') return { present: action.value, past: [], future: [] };
  if (action.type === 'undo') {
    if (!state.past.length || !state.present) return state;
    return { present: state.past.at(-1)!, past: state.past.slice(0, -1), future: [state.present, ...state.future] };
  }
  if (action.type === 'redo') {
    if (!state.future.length || !state.present) return state;
    return { present: state.future[0], past: [...state.past, state.present], future: state.future.slice(1) };
  }
  const next = typeof action.value === 'function' ? action.value(state.present) : action.value;
  if (!next || !state.present || next.id !== state.present.id) return { present: next, past: [], future: [] };
  if (JSON.stringify(next) === JSON.stringify(state.present)) return state;
  // Saving only changes metadata and should not consume an undo step.
  const content = (report: ReportDocumentV1) => { const { updatedAt, revision, ...rest } = report; return JSON.stringify(rest); };
  if (content(next) === content(state.present)) return { ...state, present: next };
  return { present: next, past: [...state.past, state.present].slice(-100), future: [] };
}

export interface RecoveredDraft extends ReportDocumentV1 { recoveryEditors?: { block?: { block: ReportBlock; isNew: boolean; initialJson: string }; dataset?: ReportDataset } }

export function recoveryKey(service: string) { return `cupola-report-recovery:${service}`; }
export function readRecoveredDrafts(storage: Pick<Storage, 'getItem'>, service: string): RecoveredDraft[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(recoveryKey(service)) || '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((draft): draft is RecoveredDraft => {
      if (!draft || typeof draft.title !== 'string') return false;
      // A title can be temporarily empty while editing. Validate the remaining
      // shape without changing the exact draft we recover. Save/publish still
      // require a non-empty title through normal report validation.
      return validateReportStructure({ ...draft, title: draft.title.trim() || 'Untitled report' }).length === 0;
    });
  } catch { return []; }
}
export function storeRecoveredDraft(storage: Pick<Storage, 'getItem' | 'setItem'>, service: string, report: RecoveredDraft, clean = false) {
  const others = readRecoveredDrafts(storage, service).filter(r => r.id !== report.id);
  storage.setItem(recoveryKey(service), JSON.stringify(clean ? others : [report, ...others]));
}

export function datePreset(preset: string, today = new Date()): { start: string; end: string } {
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const start = new Date(end);
  if (preset === 'month') start.setDate(1);
  else if (preset === 'previous_month') { start.setDate(1); start.setMonth(start.getMonth() - 1); end.setDate(0); }
  else start.setDate(start.getDate() - (preset === '7' ? 6 : 29));
  const format = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { start: format(start), end: format(end) };
}

interface FreshResult { fetchedAt?: number; runId?: number; status: string; table?: unknown }
export function reportFreshness(report: ReportDocumentV1, results: Record<string, FreshResult>) {
  const datasets = report.datasets.filter(d => !d.role || d.role === 'data');
  const loaded = datasets.filter(d => results[d.id]?.fetchedAt);
  const latestRun = Math.max(0, ...loaded.map(d => results[d.id].runId ?? 0));
  const older = datasets.filter(d => { const r = results[d.id]; return !r?.fetchedAt || r.status !== 'success' || (latestRun > 0 && r.runId !== latestRun); });
  return { oldest: loaded.length ? Math.min(...loaded.map(d => results[d.id].fetchedAt!)) : 0, partial: loaded.length > 0 && older.length > 0, older };
}

export const REPORT_STARTERS = [
  { id: 'executive', title: 'Executive summary', description: 'Headline metrics, a trend, and supporting detail.' },
  { id: 'trends', title: 'Trends and comparisons', description: 'Compare categories and follow changes over time.' },
  { id: 'analysis', title: 'Detailed analysis', description: 'An overview, a chart, and a generous detail table.' },
] as const;
export function createStarter(id: string): ReportDocumentV1 {
  const report = createEmptyReport(REPORT_STARTERS.find(s => s.id === id)?.title ?? 'Report');
  report.description = 'Sample data — replace the example dataset with your own query.';
  report.datasets = [{ id: 'sample', name: 'Sample data · replace with your data', sql: "SELECT * FROM (VALUES ('Jan', 'North', 120, 100), ('Feb', 'North', 145, 120), ('Mar', 'North', 168, 140), ('Jan', 'South', 98, 100), ('Feb', 'South', 110, 120), ('Mar', 'South', 135, 140)) AS sample(month, region, revenue, target)" }];
  report.blocks = [{ id: 'intro', type: 'markdown', markdown: `## ${report.title}\n\n**Sample data.** Edit the dataset to connect your own data, then update this summary.`, layout: { x: 0, y: 0, w: 12, h: 2 } }];
  const chart = (blockId: string, x: number, y: number, w: number, field: string) => ({ id: blockId, type: 'chart' as const, datasetId: 'sample', title: field === 'month' ? 'Revenue by month' : 'Revenue by region', spec: { mark: 'bar', encoding: { x: { field, type: 'nominal', sort: null }, y: { field: 'revenue', aggregate: 'sum', type: 'quantitative' }, color: { field: 'region', type: 'nominal' } } }, layout: { x, y, w, h: 6 } });
  if (id === 'executive') {
    report.datasets.push({ id: 'totals', name: 'Sample totals', sql: 'SELECT SUM(revenue) AS revenue, SUM(target) AS target FROM sample' });
    report.blocks.push({ id: 'revenue', type: 'kpi', datasetId: 'totals', title: 'Total revenue', valueColumn: 'revenue', format: 'currency', layout: { x: 0, y: 2, w: 6, h: 2 } }, { id: 'target', type: 'kpi', datasetId: 'totals', title: 'Revenue target', valueColumn: 'target', format: 'currency', layout: { x: 6, y: 2, w: 6, h: 2 } }, chart('trend', 0, 4, 12, 'month'));
  } else if (id === 'trends') report.blocks.push(chart('trend', 0, 2, 6, 'month'), chart('comparison', 6, 2, 6, 'region'));
  else report.blocks.push(chart('trend', 0, 2, 12, 'month'));
  const bottom = Math.max(...report.blocks.map(b => b.layout.y + b.layout.h));
  report.blocks.push({ id: 'detail', type: 'table', datasetId: 'sample', title: 'Supporting detail', layout: { x: 0, y: bottom, w: 12, h: id === 'analysis' ? 8 : 4 } });
  return report;
}

export function chartFilterValue(value: unknown, type: string): ReportParameterValue | undefined {
  if (value == null || !['string', 'number', 'boolean'].includes(typeof value)) return undefined;
  if (type === 'multi_select') return [String(value)];
  if (type === 'number') return Number.isFinite(Number(value)) ? Number(value) : undefined;
  if (type === 'boolean') return typeof value === 'boolean' ? value : undefined;
  if (type === 'date_range') return undefined;
  return type === 'select' && typeof value === 'number' ? value : String(value);
}
