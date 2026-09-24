import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { EvidenceEditorNavigation } from './EvidenceEditorNavigation';
import { EvidenceCodeEditor, type EvidenceCodeHandle } from './EvidenceCodeEditor';
import type { EvidenceIssue } from '../../lib/evidence/editor-support';
import { Input } from '../ui/input';
import { Tabs, TabsContent } from '../ui/tabs';
import { EvidenceSemanticDatasets } from './EvidenceSemanticDatasets';
import type { CatalogData } from '../../lib/service';
import type { SemanticDatasetState } from '../../lib/evidence/semantic-datasets';
import { EvidenceAppearance } from './EvidenceAppearance';
import type { ReportTheme } from '../../lib/evidence/report-theme';
import { EvidenceDataBrowser } from './EvidenceDataBrowser';
import type { EvidenceDataContext } from '../../lib/evidence/data-browser';
import { EvidenceParameters } from './EvidenceParameters';
import type { EvidenceReport } from '../../lib/evidence/reports';

const EvidenceAgent = lazy(() => import('./EvidenceAgent').then(module => ({ default: module.EvidenceAgent })));

const snippets: Record<string, string> = {
  Heading: '\n\n## New section\n\nWrite your introduction here.\n',
  'SQL query': '\n\n```sql example_data\nSELECT 1 AS value\n```\n',
  Table: '\n\n{% table data="example_data" /%}\n',
  'Key metric': '\n\n{% big_value data="example_data" value="sum(value)" title="Total" /%}\n',
  'Line chart': '\n\n{% line_chart data="example_data" x="date" y="sum(value)" title="Trend" /%}\n',
  'Two columns': '\n\n{% row %}\n\nAdd components here.\n\n{% /row %}\n',
};

export function EvidenceEditor({ report, onChange, issues, stale, editorOnly, onTogglePreview, onApplyPreview, previewBusy, dataContext, onRefreshData, reportTheme, catalogs, semanticStates }: { catalogs: readonly CatalogData[]; semanticStates: SemanticDatasetState[]; reportTheme: ReportTheme; dataContext: EvidenceDataContext | null; onRefreshData: () => Promise<void>; report: EvidenceReport; onChange: (report: EvidenceReport) => void; issues: EvidenceIssue[]; stale: boolean; editorOnly: boolean; onTogglePreview: () => void; onApplyPreview: (report: EvidenceReport) => Promise<void>; previewBusy: boolean }) {
  const [tab, setTab] = useState('agent');
  const [agentOpened, setAgentOpened] = useState(true);
  const source = useRef<EvidenceCodeHandle>(null);
  const dataset = useRef<EvidenceCodeHandle>(null);
  const [jump, setJump] = useState<{ line: number; target: string } | null>(null);
  useEffect(() => {
    if (!jump) return;
    const frame = requestAnimationFrame(() => (jump.target === 'document' ? source : dataset).current?.goToLine(jump.line));
    return () => cancelAnimationFrame(frame);
  }, [jump]);
  function insert(name: string) {
    const text = snippets[name];
    if (!text) return;
    source.current?.insert(text);
  }
  const errors = issues.filter(issue => issue.severity === 'error');
  const warnings = issues.filter(issue => issue.severity === 'warning');
  const renderIssue = (issue: EvidenceIssue, index: number) => <div key={index} className="mt-2 rounded border p-2">
    <button type="button" disabled={stale} className={`text-left disabled:opacity-60 ${issue.severity === 'error' ? 'text-destructive' : 'text-muted-foreground'}`} onClick={() => { setTab(issue.target); setJump({ target: issue.target, line: issue.line ?? 1 }); }}>
      {issue.target === 'data' ? 'Data' : 'Document'}{issue.line ? ` · line ${issue.line}` : ''} · {issue.severity}: {issue.message}
    </button>
    {issue.sql && <details className="mt-1"><summary className="cursor-pointer">Failed SQL</summary><pre className="overflow-auto whitespace-pre-wrap p-2">{issue.sql}</pre></details>}
  </div>;
  return <aside aria-label="Report editor" className="flex min-h-0 min-w-0 flex-col border-t bg-card lg:border-l lg:border-t-0">
    <div className="space-y-3 border-b p-4">
      <div className="flex flex-wrap justify-between gap-2 text-xs">
        <div className="flex gap-3"><a href="https://docs.evidence.dev/core-concepts/markdown" target="_blank" rel="noopener noreferrer" className="text-primary underline">Evidence docs ↗</a><a href="https://docs.evidence.dev/core-concepts/components" target="_blank" rel="noopener noreferrer" className="text-primary underline">Component reference ↗</a></div>
        <button type="button" className="text-primary underline" onClick={onTogglePreview}>{editorOnly ? 'Show preview' : 'Hide preview'}</button>
      </div>
      <label className="block space-y-2 text-xs font-medium">Report title<Input aria-label="Report title" value={report.title} onChange={e => onChange({ ...report, title: e.target.value })} /></label>
    </div>
    <Tabs value={tab} onValueChange={value => { setTab(String(value)); if (value === 'agent') setAgentOpened(true); }} className="min-h-0 flex-1 gap-0">
      <EvidenceEditorNavigation selected={tab} />
      <TabsContent value="agent" keepMounted style={{ display: tab === 'agent' ? undefined : 'none' }} className="min-h-0 overflow-hidden"><Suspense fallback={<p className="p-4 text-sm" role="status">Loading report agent…</p>}>{agentOpened && <EvidenceAgent catalogs={catalogs} report={report} onChange={onChange} issues={issues} stale={stale} onApplyPreview={onApplyPreview} previewBusy={previewBusy} />}</Suspense></TabsContent>
      <TabsContent value="document" className="min-h-0 overflow-auto px-4 pb-4">
        <div className="flex h-full min-h-80 flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label  className="text-xs font-medium">Evidence source</label>
            <select aria-label="Insert component" value="" onChange={e => insert(e.target.value)} className="h-8 max-w-44 rounded-lg border border-input bg-background px-2 text-xs">
              <option value="">Insert component…</option>{Object.keys(snippets).map(name => <option key={name}>{name}</option>)}
            </select>
          </div>
          <p className="text-xs text-muted-foreground">Write with Markdown, SQL queries, and Evidence components. Inserted examples use placeholder dataset and column names.</p>
          <EvidenceCodeEditor ref={source} language="document" value={report.source} onChange={value => onChange({ ...report, source: value })} parameters={report.parameters.map(p => p.key)} issues={stale ? [] : issues} />
          <span className="text-xs text-muted-foreground">{report.source.split('\n').length} lines · Ctrl + Space for suggestions · ⌘ / Ctrl + Enter to update</span>
        </div>
      </TabsContent>
      <TabsContent value="data" className="min-h-0 overflow-auto px-4 pb-4">
        <div className="flex h-full min-h-80 flex-col gap-3">
          <label  className="text-sm font-medium">Dataset SQL</label>
          <p className="text-xs leading-relaxed text-muted-foreground">Optional setup query, run before the report on each refresh. Prepare temporary tables here, then reference them from SQL queries in your document. Bind inputs with <code>$name</code>.</p>
          <EvidenceCodeEditor ref={dataset} language="data" value={report.setupSql} onChange={value => onChange({ ...report, setupSql: value })} parameters={report.parameters.map(p => p.key)} issues={stale ? [] : issues} />
        </div>
      </TabsContent>
      <TabsContent value="model" className="min-h-0 overflow-auto px-4 pb-4"><EvidenceSemanticDatasets report={report} catalogs={catalogs} states={semanticStates} onChange={onChange} /></TabsContent>
      <TabsContent value="browser" className="min-h-0 overflow-auto px-4 pb-4"><EvidenceDataBrowser onAddPivot={pivot => onChange({ ...report, pivots: [...(report.pivots ?? []), pivot] })} context={dataContext} stale={stale} busy={previewBusy} onRefresh={onRefreshData} onEdit={target => setTab(target)} /></TabsContent>
      <TabsContent value="appearance" className="min-h-0 overflow-auto px-4 pb-4"><EvidenceAppearance value={report.appearance} theme={reportTheme} onChange={appearance => onChange({ ...report, appearance })} /></TabsContent>
      <TabsContent value="parameters" className="min-h-0 overflow-auto px-4 pb-4"><EvidenceParameters report={report} onChange={onChange} /></TabsContent>
    </Tabs>
    <section aria-label="Report problems" className="max-h-48 shrink-0 overflow-auto border-t bg-background p-3 text-xs">
      <h3 className="font-semibold">Problems · {errors.length} errors{stale ? ' · previous preview' : ''}</h3>
      {!issues.length && <p className="mt-1 text-muted-foreground">{stale ? 'Update preview to check this draft.' : 'No issues reported by the last run. Update preview to check edits.'}</p>}
      {issues.length > 0 && <p className="mt-1 text-muted-foreground">{stale ? 'Source changed. Update preview to refresh locations.' : 'Select a problem to open its source. Query failures include the executed SQL.'}</p>}
      {errors.map(renderIssue)}
      {warnings.length > 0 && <details className="mt-2"><summary className="cursor-pointer text-muted-foreground">{warnings.length} warnings · advisory</summary>{warnings.map(renderIssue)}</details>}
    </section>
  </aside>;
}
