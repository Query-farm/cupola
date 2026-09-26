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
export async function prepareEvidenceSemanticDatasets(report: EvidenceReport, values: ParameterValues, catalogs: readonly CatalogData[], onTable?: (name: string) => void, run = new EvidenceQueryRun()) {
  const queries: Record<string, string> = {};
  const states: SemanticDatasetState[] = [];
  for (const dataset of report.semanticDatasets ?? []) {
    const prepared = await prepareSemanticReportDataset(dataset, { parameters: toReportParameters(report.parameters, values) }, values, catalogs);
    if (!prepared.compilation.ok) throw new Error(`${dataset.name}: ${prepared.compilation.diagnostics.map(item => item.message).join('\n')}`);
    run.signal.throwIfAborted();
    const table = `cupola_evidence_${report.id}_${dataset.id}`;
    onTable?.(table); // Track ownership even if cancellation races with table creation.
    const response = await run.query(`CREATE OR REPLACE TEMP TABLE ${quoteIdentifier(table)} AS ${prepared.compilation.plan.sql}`, prepared.compilation.plan.parameters);
    if (!response.ok) throw new Error(`${dataset.name}: ${response.error || 'Semantic dataset failed'}`);
    queries[dataset.name] = `SELECT * FROM temp.main.${quoteIdentifier(table)}`;
    states.push({ name: dataset.name, plan: prepared.compilation.plan, fingerprint: prepared.fingerprint, modelChanged: prepared.modelChanged });
  }
  return { queries, states };
}
