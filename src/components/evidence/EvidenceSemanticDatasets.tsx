import { useState } from 'react';
import type { CatalogData } from '../../lib/service';
import type { EvidenceReport } from '../../lib/evidence/reports';
import type { SemanticDatasetState } from '../../lib/evidence/semantic-datasets';
import { ReportSemanticDatasetBuilder } from '../reports/ReportSemanticDatasetBuilder';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

export function EvidenceSemanticDatasets({ report, catalogs, states, onChange }: {
  report: EvidenceReport; catalogs: readonly CatalogData[]; states: SemanticDatasetState[];
  onChange: (report: EvidenceReport) => void;
}) {
  const [jsonError, setJsonError] = useState('');
  const [selected, setSelected] = useState('');
  const datasets = report.semanticDatasets ?? [];
  const dataset = datasets.find(item => item.id === selected) ?? datasets[0];
  const state = states.find(item => item.name === dataset?.name);
  return <section aria-label="Semantic datasets" className="space-y-4 text-xs">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium">VGI semantic datasets</h3><Button size="sm" variant="outline" onClick={() => {
      let n = datasets.length + 1; while (datasets.some(item => item.name === `model_${n}`)) n++;
      const next = { id: crypto.randomUUID(), name: `model_${n}`, kind: 'semantic' as const, query: {} };
      onChange({ ...report, semanticDatasets: [...datasets, next] }); setSelected(next.id);
    }}>Add semantic dataset</Button></div>
    <p className="text-muted-foreground">Select governed measures, dimensions, filters and relationships from VGI. Update data to compile and run them. Reference a dataset by name in Evidence components or as {'{{name}}'} in a report query.</p>
    {datasets.length > 0 && <label className="block space-y-1">Dataset<select aria-label="Semantic dataset" className="h-9 w-full rounded border bg-background px-2" value={dataset?.id} onChange={event => setSelected(event.target.value)}>{datasets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
    {dataset && <>
      <label className="block space-y-1">Dataset name<Input aria-label="Semantic dataset name" value={dataset.name} onChange={event => onChange({ ...report, semanticDatasets: datasets.map(item => item.id === dataset.id ? { ...item, name: event.target.value } : item) })} /></label>
      <ReportSemanticDatasetBuilder key={dataset.id} dataset={dataset} report={report} catalogs={catalogs} onChange={next => onChange({ ...report, semanticDatasets: datasets.map(item => item.id === next.id ? next : item) })} />
      <details><summary className="cursor-pointer">Advanced semantic JSON</summary>
        <textarea key={dataset.id + JSON.stringify(dataset.query)} aria-label="Semantic query JSON" className="mt-2 min-h-48 w-full rounded border bg-background p-2 font-mono text-xs" defaultValue={JSON.stringify(dataset.query, null, 2)} onBlur={event => {
          try {
            const query = JSON.parse(event.target.value);
            if (!query || typeof query !== 'object' || Array.isArray(query)) throw new Error('Expected a semantic query object.');
            onChange({ ...report, semanticDatasets: datasets.map(item => item.id === dataset.id ? { ...item, query } : item) }); setJsonError('');
          } catch (error) { setJsonError(error instanceof Error ? error.message : String(error)); }
        }} />{jsonError && <p role="alert" className="text-destructive">{jsonError}</p>}
      </details>
      <Button variant="outline" size="sm" disabled={!/^[A-Za-z_][A-Za-z0-9_]*$/.test(dataset.name)} onClick={() => onChange({ ...report, source: report.source + `\n\n{% table data="${dataset.name}" /%}\n` })}>Insert table in report</Button>
      {state && <div className="space-y-2 rounded border p-3">
        <p className={state.modelChanged ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground'}>{state.modelChanged ? 'The VGI model changed since this definition was accepted. Review the current outputs before accepting.' : 'Last run compiled against the VGI model.'}</p>
        <ul>{state.plan.outputs?.map(output => <li key={output.name}>{output.title || output.name} · {output.kind}{output.unit ? ` · ${output.unit}` : ''}</li>)}</ul>
        {state.plan.warnings.map((warning, i) => <p key={i}>{warning}</p>)}
        {state.fingerprint && dataset.acceptedModelFingerprint !== state.fingerprint && <Button variant="outline" size="sm" onClick={() => onChange({ ...report, semanticDatasets: datasets.map(item => item.id === dataset.id ? { ...item, acceptedModelFingerprint: state.fingerprint } : item) })}>Accept current model</Button>}
      </div>}
      <Button variant="ghost" size="sm" onClick={() => onChange({ ...report, semanticDatasets: datasets.filter(item => item.id !== dataset.id) })}>Remove semantic dataset</Button>
    </>}
  </section>;
}
