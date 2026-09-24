import { semanticOutputLabel } from '../../lib/reports/semantic-presentation';
import { EvidencePivot } from './EvidencePivot';
import type { EvidenceReport } from '../../lib/evidence/reports';
import { useEffect, useRef, useState } from 'react';
import { RefreshCw, Play } from 'lucide-react';
import type { QueryResult } from '@evidence/core/user-components/interfaces/query-service';
import { type EvidenceDataContext, quoteIdentifier, TABLE_BROWSER_SQL } from '../../lib/evidence/data-browser';
import { Button } from '../ui/button';
import { QueryResultTable } from '../chat/QueryResultTable';

type Dataset = { id: string; name: string; kind: 'query' | 'table'; sql: string };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function EvidenceDataBrowser({ context, stale, busy, onRefresh, onEdit, onAddPivot }: {
  context: EvidenceDataContext | null; stale: boolean; busy: boolean;
  onAddPivot: (pivot: NonNullable<EvidenceReport['pivots']>[number]) => void;
  onRefresh: () => Promise<void>; onEdit: (target: 'document' | 'data') => void;
}) {
  const [pivot, setPivot] = useState(false);
  const [pivotConfig, setPivotConfig] = useState<Record<string, any>>({});
  const [tables, setTables] = useState<Dataset[]>([]);
  const [selected, setSelected] = useState('');
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState('');
  const [catalogError, setCatalogError] = useState('');
  const [loading, setLoading] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const request = useRef(0);
  const queries: Dataset[] = context?.queries.map(query => ({ ...query, id: `query:${query.name}`, kind: 'query' })) ?? [];
  const datasets = [...queries, ...tables];
  const dataset = datasets.find(item => item.id === selected);
  const semantic = context?.semanticStates.find(state => dataset?.id === `query:${state.name}`);

  useEffect(() => {
    let disposed = false;
    request.current++;
    setResult(null); setError(''); setCatalogError(''); setTables([]); setLoading(false);
    setDiscovering(Boolean(context));
    if (context) void context.service.query(TABLE_BROWSER_SQL, { noCache: true }).then(response => {
      if (disposed) return;
      if (response.error) setCatalogError(response.error);
      else setTables(response.rows.map(row => {
        const path = [row.database_name, row.schema_name, row.name].map(String);
        return { id: `table:${JSON.stringify(path)}`, name: path.join('.'), kind: 'table', sql: `SELECT * FROM ${path.map(quoteIdentifier).join('.')}` };
      }));
    }).catch(error => { if (!disposed) setCatalogError(message(error)); }).finally(() => { if (!disposed) setDiscovering(false); });
    return () => { disposed = true; request.current++; };
  }, [context]);

  async function preview() {
    if (!context || !dataset || loading) return;
    const id = ++request.current;
    setLoading(true); setResult(null); setError('');
    try {
      const sql = dataset.kind === 'query' ? context.resolve(dataset.name) : dataset.sql;
      // Limit the result on the engine, with one extra row to detect truncation.
      const response = await context.service.query(`SELECT * FROM (${sql.replace(/;+\s*$/, '')}\n) AS cupola_data_preview LIMIT 101`, { noCache: true });
      if (id !== request.current) return;
      if (response.error) setError(response.error); else setResult(response);
    } catch (error) { if (id === request.current) setError(message(error)); }
    finally { if (id === request.current) setLoading(false); }
  }

  return <section aria-label="Data browser" className="space-y-4 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-medium">Data browser</h3>
      <Button variant="outline" size="sm" disabled={busy || loading} onClick={() => void onRefresh()}><RefreshCw className={busy ? 'animate-spin' : ''} />{busy ? 'Updating…' : 'Update data'}</Button>
    </div>
    <p className="text-xs text-muted-foreground">Inspect named report queries and tables available in the current connection, including those created by Dataset SQL. Previews use the last report run’s parameters and current report filters.</p>
    {stale && <p role="status" className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs">Your definition or parameters have changed. Update data to test the latest draft.</p>}
    {!context ? <p role="status" className="text-xs text-muted-foreground">{busy ? 'Preparing report data…' : 'Update data to load the report’s datasets.'}</p> : <>
      <label className="block space-y-1 text-xs font-medium">Dataset
        <select aria-label="Browse dataset" value={dataset ? selected : ''} disabled={loading || busy} onChange={event => { request.current++; setSelected(event.target.value); setPivot(false); setPivotConfig({}); setResult(null); setError(''); }} className="block h-9 w-full rounded-lg border border-input bg-background px-2 text-sm">
          <option value="">Choose a dataset…</option>
          {queries.length > 0 && <optgroup label="Report queries">{queries.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</optgroup>}
          {tables.length > 0 && <optgroup label="Connection tables and views">{tables.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</optgroup>}
        </select>
      </label>
      {discovering && <p role="status" className="text-xs text-muted-foreground">Loading tables…</p>}
      {catalogError && <p role="alert" className="text-xs text-destructive">Could not list connection tables: {catalogError}</p>}
      {!discovering && !datasets.length && <p className="text-xs text-muted-foreground">No datasets yet. Define a named SQL query in Code or create a table in Data, then update data.</p>}
      {dataset && <>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={busy || loading || stale} onClick={() => void preview()}><Play />{loading ? 'Running…' : 'Preview rows'}</Button>
          <Button variant="outline" size="sm" disabled={busy || stale || loading} onClick={() => setPivot(!pivot)}>{pivot ? 'Close pivot' : 'Explore pivot'}</Button>
          <Button variant="ghost" size="sm" onClick={() => onEdit(dataset.kind === 'query' ? 'document' : 'data')}>{dataset.kind === 'query' ? 'Open report SQL' : 'Open Dataset SQL'}</Button>
        </div>
        <details className="text-xs"><summary className="cursor-pointer text-muted-foreground">View SQL</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded border bg-muted/30 p-3">{dataset.sql}</pre></details>
      </>}
      {pivot && dataset && !stale && <div className="space-y-3">
        <p className="text-xs text-muted-foreground">Drag fields into Group by and Split by, choose aggregates, and filter the dataset. Semantic measures may require a fresh model query when changing grain; ratios and distinct counts should not be summed.</p>
        <EvidencePivot context={context} datasetId={dataset.id} config={pivotConfig} onConfig={setPivotConfig} />
        <Button size="sm" variant="outline" onClick={() => onAddPivot({ id: crypto.randomUUID(), title: `${dataset.name} · exploration`, datasetId: dataset.id, config: pivotConfig })}>Add pivot to report</Button>
      </div>}
      {loading && <p role="status" className="text-xs text-muted-foreground">Running dataset preview…</p>}
      {error && <div role="alert" className="whitespace-pre-wrap rounded border border-destructive/30 p-3 text-xs text-destructive">{error}</div>}
      {result && <div className="space-y-3">
        <p role="status" aria-label="Dataset preview result" className="text-xs text-muted-foreground">{result.rows.length > 100 ? 'Showing first 100 rows' : `${result.rows.length} rows`} · {result.columns.length} columns · {Math.round(result.queryDurationMs ?? 0)} ms</p>
        <details className="text-xs"><summary className="cursor-pointer">Columns and types ({result.columns.length})</summary><dl className="mt-2 space-y-1">{result.columns.map(column => <div key={column.name} className="flex flex-wrap justify-between gap-2 border-b py-1"><dt className="font-mono">{column.name}</dt><dd className="text-muted-foreground">{column.clickhouseType}{semantic?.plan.output_units?.[column.name] ? ` · ${semantic.plan.output_units[column.name]}` : ''}{column.nullable ? ' · nullable' : ''}</dd></div>)}</dl></details>
        {result.rows.length ? <QueryResultTable columnLabels={semantic ? Object.fromEntries((semantic.plan.outputs ?? []).map(output => [output.name, semanticOutputLabel(output, output.name)])) : undefined} columns={result.columns.map(column => column.name)} rows={result.rows.slice(0, 100)} rowCount={Math.min(100, result.rows.length)} showing={100} /> : <p className="text-xs text-muted-foreground">This dataset returned no rows. Column metadata is available above.</p>}
      </div>}
    </>}
  </section>;
}
