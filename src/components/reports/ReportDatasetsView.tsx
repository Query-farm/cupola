import { useEffect, useMemo, useState } from "react";
import type { Table as ArrowTable } from "@query-farm/apache-arrow";
import { AlertCircle, CheckCircle2, Clock3, Database, ExternalLink, Loader2, Play, RefreshCw } from "lucide-react";
import { QueryResultTable } from "@/components/chat/QueryResultTable";
import { Button } from "@/components/ui/button";
import { reportDisplayRows } from "@/lib/reports/display";
import { compileReportQuery } from "@/lib/reports/parameters";
import type { ReportDocumentV1, ReportParameterValue } from "@/lib/reports/types";

interface DatasetResult {
  table: ArrowTable | null;
  rows: Record<string, any>[];
  status: "idle" | "queued" | "running" | "success" | "error" | "blocked";
  error?: string;
  errorDetails?: string;
  fetchedAt?: number;
  durationMs?: number;
}

interface Props {
  report: ReportDocumentV1;
  results: Record<string, DatasetResult>;
  appliedValues: Record<string, ReportParameterValue>;
  running: boolean;
  engineReady: boolean;
  onRunDataset: (datasetId: string) => void;
  onOpenSql: (datasetId: string) => void;
}

const PREVIEW_ROWS = 100;

function statusLabel(result?: DatasetResult): string {
  if (!result || result.status === "idle") return "Not run";
  if (result.status === "success") return "Ready";
  if (result.status === "queued") return result.table ? "Refresh queued" : "Queued";
  if (result.status === "running") return result.table ? "Refreshing" : "Running";
  if (result.status === "blocked") return result.table ? "Blocked · stale data" : "Blocked";
  return result.table ? "Failed · stale data" : "Failed";
}

function statusClasses(result?: DatasetResult): string {
  if (result?.status === "success") return "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200";
  if (result?.status === "error") return "border-destructive/30 bg-destructive/5 text-destructive";
  if (result?.status === "blocked") return "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200";
  if (result?.status === "queued" || result?.status === "running") return "border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-200";
  return "border-border bg-muted/40 text-muted-foreground";
}

function roleLabel(role?: string): string {
  if (role === "parameter_options") return "Parameter options";
  if (role === "parameter_validation") return "Parameter validation";
  return "Report data";
}

function rowLabel(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? "row" : "rows"}`;
}

export function ReportDatasetsView({ report, results, appliedValues, running, engineReady, onRunDataset, onOpenSql }: Props) {
  const [selectedId, setSelectedId] = useState(report.datasets[0]?.id ?? "");

  useEffect(() => {
    if (!report.datasets.some((dataset) => dataset.id === selectedId)) setSelectedId(report.datasets[0]?.id ?? "");
  }, [report.datasets, selectedId]);

  const dataset = report.datasets.find((candidate) => candidate.id === selectedId) ?? report.datasets[0];
  const result = dataset ? results[dataset.id] : undefined;
  const consumers = useMemo(() => dataset ? report.blocks.filter((block) => "datasetId" in block && block.datasetId === dataset.id) : [], [dataset, report.blocks]);
  const compiled = useMemo(() => {
    if (!dataset) return null;
    try {
      return { value: compileReportQuery(dataset.sql, report, appliedValues), error: null };
    } catch (error) {
      return { value: null, error: error instanceof Error ? error.message : String(error) };
    }
  }, [appliedValues, dataset, report]);

  if (!dataset) return <div data-testid="report-datasets-view" className="flex h-full items-center justify-center p-8 text-center">
    <div><Database className="mx-auto mb-3 h-9 w-9 text-muted-foreground/40" /><p className="font-medium">No datasets</p><p className="mt-1 text-sm text-muted-foreground">This report only contains static content.</p></div>
  </div>;

  const columns = result?.table?.schema.fields.map((field) => field.name) ?? [];
  const fields = result?.table?.schema.fields ?? [];
  const pending = result?.status === "queued" || result?.status === "running";

  return <div data-testid="report-datasets-view" className="grid h-full min-h-0 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] lg:grid-cols-[280px_minmax(0,1fr)] lg:grid-rows-1">
    <nav aria-label="Report datasets" className="max-h-48 overflow-y-auto border-b bg-muted/10 p-2 lg:max-h-none lg:border-b-0 lg:border-r">
      <div className="px-2 pb-2 pt-1 text-xs text-muted-foreground">Inspect the exact results shared by report blocks. Opening this view does not run any queries.</div>
      <div className="space-y-1">
        {report.datasets.map((candidate) => {
          const candidateResult = results[candidate.id];
          const selected = candidate.id === dataset.id;
          return <button key={candidate.id} type="button" data-testid={`report-dataset-item-${candidate.id}`} aria-current={selected ? "true" : undefined} onClick={() => setSelectedId(candidate.id)} className={`w-full rounded-md border px-3 py-2 text-left transition-colors ${selected ? "border-primary/40 bg-background shadow-sm" : "border-transparent hover:border-border hover:bg-background/60"}`}>
            <div className="flex items-center gap-2"><Database className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate text-sm font-medium">{candidate.name}</span>{candidateResult?.status === "running" || candidateResult?.status === "queued" ? <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" /> : candidateResult?.status === "success" ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> : candidateResult?.status === "error" || candidateResult?.status === "blocked" ? <AlertCircle className="h-3.5 w-3.5 text-amber-600" /> : null}</div>
            <div className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground"><span>{roleLabel(candidate.role)}</span><span>·</span><span>{candidateResult?.table ? rowLabel(candidateResult.table.numRows) : statusLabel(candidateResult)}</span></div>
          </button>;
        })}
      </div>
    </nav>

    <section aria-label={`${dataset.name} dataset details`} className="min-h-0 overflow-y-auto p-4 sm:p-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h2 className="text-lg font-semibold">{dataset.name}</h2><span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${statusClasses(result)}`}>{statusLabel(result)}</span><span className="rounded-full border bg-muted/30 px-2 py-0.5 text-[10px] text-muted-foreground">{roleLabel(dataset.role)}</span></div>{dataset.description && <p className="mt-1 text-sm text-muted-foreground">{dataset.description}</p>}<div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"><span>ID: <code>{dataset.id}</code></span>{result?.table && <span>{rowLabel(result.table.numRows)} · {columns.length.toLocaleString()} columns</span>}{result?.durationMs !== undefined && <span>{result.durationMs.toLocaleString()} ms</span>}{result?.fetchedAt && <span className="inline-flex items-center gap-1"><Clock3 className="h-3 w-3" />{new Date(result.fetchedAt).toLocaleString()}</span>}</div></div>
        <div className="flex items-center gap-2"><Button size="sm" variant="outline" onClick={() => onOpenSql(dataset.id)}><ExternalLink className="h-3.5 w-3.5" /> Open SQL</Button><Button size="sm" disabled={running || !engineReady} onClick={() => onRunDataset(dataset.id)}>{pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : result?.table ? <RefreshCw className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}{result?.table ? "Refresh dataset" : "Run dataset"}</Button></div>
      </div>

      {(result?.error || compiled?.error) && <div role="alert" className="mt-4 rounded-md border border-destructive/25 bg-destructive/5 p-3 text-xs text-destructive"><div className="font-medium">{result?.error ?? compiled?.error}</div>{result?.errorDetails && result.errorDetails !== result.error && <details className="mt-2 text-muted-foreground"><summary className="cursor-pointer">Technical details</summary><pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[10px]">{result.errorDetails}</pre></details>}</div>}

      <div className="mt-5 grid gap-4 xl:grid-cols-2">
        <div className="rounded-lg border p-3"><h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Used by</h3>{consumers.length ? <div className="mt-2 flex flex-wrap gap-2">{consumers.map((block) => <span key={block.id} className="rounded-md border bg-muted/20 px-2 py-1 text-xs"><span className="font-medium">{block.title || block.type.replaceAll("_", " ")}</span><span className="ml-1 text-muted-foreground">({block.type.replaceAll("_", " ")})</span></span>)}</div> : <p className="mt-2 text-xs text-muted-foreground">No report blocks currently reference this dataset.</p>}</div>
        <div className="rounded-lg border p-3"><h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Schema</h3>{fields.length ? <div className="mt-2 flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">{fields.map((field) => <span key={field.name} className="rounded border bg-muted/20 px-2 py-1 font-mono text-[10px]"><span className="font-semibold">{field.name}</span><span className="ml-1 text-muted-foreground">{String(field.type)}</span></span>)}</div> : <p className="mt-2 text-xs text-muted-foreground">Run the dataset to inspect its returned columns and types.</p>}</div>
      </div>

      <div className="mt-5"><div className="mb-2 flex items-baseline justify-between gap-2"><h3 className="text-sm font-semibold">Executed query</h3><span className="text-[10px] text-muted-foreground">Prepared SQL and applied parameter values</span></div>{compiled?.value ? <><pre data-testid="report-dataset-sql" className="max-h-64 overflow-auto rounded-md border bg-muted/20 p-3 whitespace-pre-wrap font-mono text-xs leading-relaxed">{compiled.value.sql}</pre>{compiled.value.params.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{compiled.value.params.map((value, index) => <span key={index} data-testid={`report-dataset-param-${index + 1}`} className="rounded-md border bg-background px-2 py-1 font-mono text-[10px]"><span className="text-muted-foreground">Parameter {index + 1} = </span>{value === null ? "NULL" : Array.isArray(value) ? value.join(", ") : String(value)}</span>)}</div>}{compiled.value.sql !== dataset.sql && <details className="mt-3"><summary className="cursor-pointer text-xs font-medium text-muted-foreground">Query template</summary><pre className="mt-2 max-h-48 overflow-auto rounded-md border bg-muted/10 p-3 whitespace-pre-wrap font-mono text-xs">{dataset.sql}</pre></details>}</> : null}</div>

      <div className="mt-5 pb-4"><div className="mb-2 flex items-baseline justify-between gap-2"><h3 className="text-sm font-semibold">Result preview</h3>{result?.table && <span className="text-[10px] text-muted-foreground">First {Math.min(result.table.numRows, PREVIEW_ROWS).toLocaleString()} rows from the shared in-memory result</span>}</div>{!result?.table ? <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">This dataset has not returned data yet.</div> : result.table.numRows === 0 ? <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">The query succeeded and returned no rows.</div> : <QueryResultTable columns={columns} rows={reportDisplayRows(result.table, columns, PREVIEW_ROWS)} rowCount={result.table.numRows} showing={Math.min(result.table.numRows, PREVIEW_ROWS)} />}</div>
    </section>
  </div>;
}
