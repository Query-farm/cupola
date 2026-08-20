import { useMemo, useState } from "react";
import { Clock3, Database, GitBranch, HardDrive, Timer } from "lucide-react";
import type { ReportDocumentV1 } from "@/lib/reports/types";

export interface ProfiledDatasetResult {
  status: "idle" | "queued" | "running" | "success" | "error" | "blocked";
  durationMs?: number;
  previousDurationMs?: number;
  planningMs?: number;
  waitMs?: number;
  queryMs?: number;
  materializeMs?: number;
  decodeMs?: number;
  transferBytes?: number;
  queuedAt?: number;
  startedAt?: number;
  finishedAt?: number;
  runId?: number;
  dependencies?: string[];
  materialized?: boolean;
  table?: { numRows: number } | null;
}

interface Props {
  report: ReportDocumentV1;
  results: Record<string, ProfiledDatasetResult | undefined>;
  selectedId: string;
  onSelectDataset: (datasetId: string) => void;
}

type SortKey = "duration" | "wait" | "rows" | "bytes";

function formatDuration(ms?: number): string {
  if (ms === undefined) return "—";
  if (ms < 1_000) return `${Math.round(ms).toLocaleString()} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1_000)}s`;
}

function formatBytes(bytes?: number): string {
  if (bytes === undefined) return "—";
  if (bytes < 1_024) return `${bytes.toLocaleString()} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function statusTone(status: ProfiledDatasetResult["status"]): string {
  if (status === "success") return "bg-emerald-500";
  if (status === "error") return "bg-destructive";
  if (status === "blocked") return "bg-amber-500";
  if (status === "running") return "bg-sky-500";
  if (status === "queued") return "bg-sky-300";
  return "bg-muted-foreground/30";
}

function graphTone(status: ProfiledDatasetResult["status"]): string {
  if (status === "success") return "fill-emerald-50 stroke-emerald-500 dark:fill-emerald-950";
  if (status === "error") return "fill-red-50 stroke-red-500 dark:fill-red-950";
  if (status === "blocked") return "fill-amber-50 stroke-amber-500 dark:fill-amber-950";
  if (status === "running" || status === "queued") return "fill-sky-50 stroke-sky-500 dark:fill-sky-950";
  return "fill-muted stroke-border";
}

export function ReportDatasetProfile({ report, results, selectedId, onSelectDataset }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("duration");
  const [descending, setDescending] = useState(true);
  const latestRunId = Math.max(0, ...Object.values(results).map((result) => result?.runId ?? 0));
  const latestResults = Object.values(results).filter((result) => result?.runId === latestRunId);
  const runStart = Math.min(...latestResults.map((result) => result?.queuedAt ?? Number.POSITIVE_INFINITY));
  const runEnd = Math.max(0, ...latestResults.map((result) => result?.finishedAt ?? result?.startedAt ?? result?.queuedAt ?? 0));
  const runDuration = Number.isFinite(runStart) && runEnd >= runStart ? runEnd - runStart : undefined;
  const planningMs = Math.max(0, ...latestResults.map((result) => result?.planningMs ?? 0));
  const totalBytes = latestResults.reduce((sum, result) => sum + (result?.transferBytes ?? 0), 0);
  const rows = useMemo(() => report.datasets.map((dataset) => ({ dataset, result: results[dataset.id] })), [report.datasets, results]);
  const slowest = [...rows].filter((row) => row.result?.runId === latestRunId && row.result.durationMs !== undefined).sort((left, right) => (right.result?.durationMs ?? 0) - (left.result?.durationMs ?? 0))[0];
  const sorted = [...rows].sort((left, right) => {
    const value = (row: typeof left) => sortKey === "duration" ? row.result?.durationMs ?? -1
      : sortKey === "wait" ? row.result?.waitMs ?? -1
        : sortKey === "rows" ? row.result?.table?.numRows ?? -1
          : row.result?.transferBytes ?? -1;
    const difference = value(left) - value(right);
    return descending ? -difference : difference;
  });
  const sort = (next: SortKey) => {
    if (next === sortKey) setDescending((current) => !current);
    else { setSortKey(next); setDescending(true); }
  };

  const graph = useMemo(() => {
    const ids = new Set(report.datasets.map((dataset) => dataset.id));
    const dependencies = new Map(report.datasets.map((dataset) => [dataset.id, (results[dataset.id]?.dependencies ?? []).filter((id) => ids.has(id))]));
    const memo = new Map<string, number>();
    const depth = (id: string, visiting = new Set<string>()): number => {
      if (memo.has(id)) return memo.get(id)!;
      if (visiting.has(id)) return 0;
      const nextVisiting = new Set(visiting).add(id);
      const value = Math.max(0, ...(dependencies.get(id) ?? []).map((dependency) => depth(dependency, nextVisiting) + 1));
      memo.set(id, value);
      return value;
    };
    const layers = new Map<number, string[]>();
    for (const dataset of report.datasets) {
      const layer = depth(dataset.id);
      layers.set(layer, [...(layers.get(layer) ?? []), dataset.id]);
    }
    const positions = new Map<string, { x: number; y: number }>();
    for (const [layer, layerIds] of layers) layerIds.forEach((id, index) => positions.set(id, { x: 20 + layer * 220, y: 20 + index * 76 }));
    const maxLayer = Math.max(0, ...layers.keys());
    const maxRows = Math.max(1, ...[...layers.values()].map((layer) => layer.length));
    const edges = [...dependencies].flatMap(([target, sourceIds]) => sourceIds.map((source) => ({ source, target })));
    return { positions, edges, width: Math.max(640, (maxLayer + 1) * 220), height: maxRows * 76 + 40 };
  }, [report.datasets, results]);

  if (!rows.some((row) => row.result?.durationMs !== undefined || row.result?.queuedAt !== undefined)) {
    return <div data-testid="report-dataset-profile" className="rounded-lg border border-dashed p-8 text-center"><Timer className="mx-auto h-8 w-8 text-muted-foreground/40" /><h2 className="mt-3 font-semibold">No refresh profile yet</h2><p className="mt-1 text-sm text-muted-foreground">Run or refresh the report to capture passive query timings and dependencies.</p></div>;
  }

  return <div data-testid="report-dataset-profile" className="space-y-5">
    <div>
      <h2 className="text-lg font-semibold">Refresh profile</h2>
      <p className="mt-1 text-sm text-muted-foreground">Passive timings from the latest report execution. No query is rerun for profiling.</p>
    </div>

    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <div className="rounded-lg border p-3"><div className="flex items-center gap-2 text-xs text-muted-foreground"><Clock3 className="h-3.5 w-3.5" /> Latest refresh</div><div className="mt-1 text-xl font-semibold tabular-nums">{formatDuration(runDuration)}</div><div className="text-[10px] text-muted-foreground">Planning {formatDuration(planningMs)}</div></div>
      <div className="rounded-lg border p-3"><div className="flex items-center gap-2 text-xs text-muted-foreground"><Timer className="h-3.5 w-3.5" /> Slowest dataset</div><div className="mt-1 truncate text-sm font-semibold">{slowest?.dataset.name ?? "—"}</div><div className="text-[10px] text-muted-foreground">{formatDuration(slowest?.result?.durationMs)}</div></div>
      <div className="rounded-lg border p-3"><div className="flex items-center gap-2 text-xs text-muted-foreground"><HardDrive className="h-3.5 w-3.5" /> Arrow transfer</div><div className="mt-1 text-xl font-semibold tabular-nums">{formatBytes(totalBytes)}</div><div className="text-[10px] text-muted-foreground">Latest refresh results</div></div>
      <div className="rounded-lg border p-3"><div className="flex items-center gap-2 text-xs text-muted-foreground"><GitBranch className="h-3.5 w-3.5" /> Dependency edges</div><div className="mt-1 text-xl font-semibold tabular-nums">{graph.edges.length.toLocaleString()}</div><div className="text-[10px] text-muted-foreground">Across {report.datasets.length.toLocaleString()} datasets</div></div>
    </div>

    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full min-w-[860px] border-collapse text-left text-xs" data-testid="report-dataset-profile-table">
        <thead className="bg-muted/40"><tr><th className="px-3 py-2 font-medium">Dataset</th><th className="px-3 py-2 font-medium">Status</th><th className="px-3 py-2 font-medium"><button type="button" onClick={() => sort("duration")}>Execution {sortKey === "duration" ? descending ? "↓" : "↑" : ""}</button></th><th className="px-3 py-2 font-medium"><button type="button" onClick={() => sort("wait")}>Queued {sortKey === "wait" ? descending ? "↓" : "↑" : ""}</button></th><th className="px-3 py-2 font-medium"><button type="button" onClick={() => sort("rows")}>Rows {sortKey === "rows" ? descending ? "↓" : "↑" : ""}</button></th><th className="px-3 py-2 font-medium"><button type="button" onClick={() => sort("bytes")}>Transfer {sortKey === "bytes" ? descending ? "↓" : "↑" : ""}</button></th><th className="w-64 px-3 py-2 font-medium">Waterfall</th></tr></thead>
        <tbody>{sorted.map(({ dataset, result }) => {
          const currentRun = result?.runId === latestRunId;
          const left = currentRun && runDuration && result?.startedAt ? Math.max(0, ((result.startedAt - runStart) / runDuration) * 100) : 0;
          const width = currentRun && runDuration && result?.durationMs !== undefined ? Math.max(1, (result.durationMs / runDuration) * 100) : 0;
          const delta = result?.durationMs !== undefined && result.previousDurationMs !== undefined ? result.durationMs - result.previousDurationMs : undefined;
          return <tr key={dataset.id} className={`border-t ${dataset.id === selectedId ? "bg-primary/5" : ""}`}>
            <th scope="row" className="px-3 py-2"><button type="button" className="inline-flex items-center gap-1.5 font-medium hover:underline" onClick={() => onSelectDataset(dataset.id)}><Database className="h-3.5 w-3.5 text-muted-foreground" />{dataset.name}</button>{result?.materialized && <span className="ml-2 rounded bg-violet-500/10 px-1.5 py-0.5 text-[9px] text-violet-700 dark:text-violet-300">shared</span>}</th>
            <td className="px-3 py-2 capitalize">{result?.status ?? "not run"}</td>
            <td className="px-3 py-2 tabular-nums">{formatDuration(result?.durationMs)}{delta !== undefined && <span className={`ml-1 text-[9px] ${delta > 0 ? "text-amber-600" : "text-emerald-600"}`}>{delta > 0 ? "+" : ""}{formatDuration(delta)}</span>}</td>
            <td className="px-3 py-2 tabular-nums">{formatDuration(result?.waitMs)}</td>
            <td className="px-3 py-2 tabular-nums">{result?.table?.numRows.toLocaleString() ?? "—"}</td>
            <td className="px-3 py-2 tabular-nums">{formatBytes(result?.transferBytes)}</td>
            <td className="px-3 py-2"><div className="relative h-3 rounded bg-muted" title={`Wait ${formatDuration(result?.waitMs)} · query ${formatDuration(result?.queryMs)} · materialize ${formatDuration(result?.materializeMs)} · decode ${formatDuration(result?.decodeMs)}`}>{currentRun && result?.startedAt && <div className="absolute inset-y-0 left-0 rounded-l bg-muted-foreground/20" style={{ width: `${Math.min(100, left)}%` }} />}{width > 0 && <div className={`absolute inset-y-0 rounded ${statusTone(result?.status ?? "idle")}`} style={{ left: `${Math.min(99, left)}%`, width: `${Math.min(100 - left, width)}%` }} />}</div></td>
          </tr>;
        })}</tbody>
      </table>
    </div>

    <div className="rounded-lg border p-3">
      <div className="mb-3"><h3 className="text-sm font-semibold">Dataset dependencies</h3><p className="text-xs text-muted-foreground">Arrows run from an upstream shared result to the datasets that consume it. Select a node for details.</p></div>
      {graph.edges.length === 0 ? <div className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">No report-local dataset dependencies were detected in the latest run.</div> : <div className="overflow-x-auto"><svg data-testid="report-dataset-dependency-graph" viewBox={`0 0 ${graph.width} ${graph.height}`} style={{ minWidth: graph.width, height: graph.height }} role="img" aria-label="Report dataset dependency graph">
        <defs><marker id="report-profile-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" className="fill-muted-foreground" /></marker></defs>
        {graph.edges.map(({ source, target }) => { const from = graph.positions.get(source)!, to = graph.positions.get(target)!; return <path key={`${source}-${target}`} d={`M ${from.x + 180} ${from.y + 27} C ${from.x + 205} ${from.y + 27}, ${to.x - 25} ${to.y + 27}, ${to.x} ${to.y + 27}`} className="fill-none stroke-muted-foreground/60" strokeWidth="1.5" markerEnd="url(#report-profile-arrow)" />; })}
        {report.datasets.map((dataset) => { const position = graph.positions.get(dataset.id)!; const result = results[dataset.id]; return <g key={dataset.id} data-testid={`report-dataset-node-${dataset.id}`} role="button" tabIndex={0} aria-label={`Open ${dataset.name} dataset details`} onClick={() => onSelectDataset(dataset.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelectDataset(dataset.id); } }} className="cursor-pointer outline-none">
          <rect x={position.x} y={position.y} width="180" height="54" rx="8" className={`${graphTone(result?.status ?? "idle")} ${dataset.id === selectedId ? "stroke-[3]" : "stroke-1"}`} />
          <text x={position.x + 12} y={position.y + 22} className="fill-foreground text-[11px] font-semibold">{dataset.name.length > 23 ? `${dataset.name.slice(0, 22)}…` : dataset.name}</text>
          <text x={position.x + 12} y={position.y + 40} className="fill-muted-foreground text-[9px]">{result?.status ?? "not run"} · {formatDuration(result?.durationMs)}</text>
        </g>; })}
      </svg></div>}
    </div>
  </div>;
}
