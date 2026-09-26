import { z } from 'zod';
import type { CatalogData } from '../service';
import type { SemanticPlan } from '../semantic-compiler';
import { prepareSemanticReportDataset } from '../reports/semantic';
import type { EvidenceReport, ParameterValues } from './reports';
import { toReportParameters } from './parameters';
import { quoteIdentifier } from './data-browser';
import { EvidenceQueryRun } from './query-run';

export const semanticDatasetSchema = z.object({
  id: z.string().min(1), name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  kind: z.literal('semantic'), description: z.string().optional(),
  query: z.record(z.string(), z.any()), acceptedModelFingerprint: z.string().optional(),
});
export type SemanticDatasetState = { name: string; plan: SemanticPlan; fingerprint?: string; modelChanged: boolean };
/** One timed step of preparing a dataset (its compile, or the query that materializes it). */
export interface SemanticStep { name: string; sql: string; startedAt: number; durationMs: number; error: string | null }
export async function prepareEvidenceSemanticDatasets(report: EvidenceReport, values: ParameterValues, catalogs: readonly CatalogData[], onTable?: (name: string) => void, run = new EvidenceQueryRun(), observe?: (step: SemanticStep) => void) {
  const queries: Record<string, string> = {};
  const states: SemanticDatasetState[] = [];
  for (const dataset of report.semanticDatasets ?? []) {
    const compileStart = performance.now();
    const prepared = await prepareSemanticReportDataset(dataset, { parameters: toReportParameters(report.parameters, values) }, values, catalogs);
    const compileError = prepared.compilation.ok ? null : prepared.compilation.diagnostics.map(item => item.message).join('\n');
    observe?.({ name: dataset.name, sql: 'Compile the semantic query', startedAt: compileStart, durationMs: performance.now() - compileStart, error: compileError });
    if (!prepared.compilation.ok) throw new Error(`${dataset.name}: ${compileError}`);
    run.signal.throwIfAborted();
    const table = `cupola_evidence_${report.id}_${dataset.id}`;
    onTable?.(table); // Track ownership even if cancellation races with table creation.
    const create = `CREATE OR REPLACE TEMP TABLE ${quoteIdentifier(table)} AS ${prepared.compilation.plan.sql}`;
    const createStart = performance.now();
    const response = await run.query(create, prepared.compilation.plan.parameters);
    observe?.({ name: dataset.name, sql: create, startedAt: createStart, durationMs: performance.now() - createStart, error: response.ok ? null : response.error || 'Semantic dataset failed' });
    if (!response.ok) throw new Error(`${dataset.name}: ${response.error || 'Semantic dataset failed'}`);
    queries[dataset.name] = `SELECT * FROM temp.main.${quoteIdentifier(table)}`;
    states.push({ name: dataset.name, plan: prepared.compilation.plan, fingerprint: prepared.fingerprint, modelChanged: prepared.modelChanged });
  }
  return { queries, states };
}
