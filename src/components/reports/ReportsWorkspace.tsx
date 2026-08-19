import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ResponsiveGridLayout, useContainerWidth, type Layout, type ResponsiveLayouts } from "react-grid-layout";
import { noCompactor } from "react-grid-layout/core";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import { ArrowLeft, BarChart3, BookOpen, Bot, Check, Download, FileJson, FilePlus2, GripVertical, Loader2, Play, Plus, Printer, Save, Share2, Sparkles, Trash2, X } from "lucide-react";
import type { Table as ArrowTable } from "@query-farm/apache-arrow";
import type { CatalogData } from "@/lib/service";
import { engine, ui } from "@/lib/shell-bridge";
import { decodeArrowBuffer, tableToRows } from "@/lib/duckdb-query";
import { ChatMarkdown } from "@/components/chat/ChatMarkdown";
import { ChatMessageAssistant, type ContentBlock, type ToolCallEntry } from "@/components/chat/ChatMessageAssistant";
import { ChatMessageUser } from "@/components/chat/ChatMessageUser";
import { QueryResultTable } from "@/components/chat/QueryResultTable";
import { ReportMap } from "@/components/reports/ReportMap";
import { ReportSparkline } from "@/components/reports/ReportSparkline";
import { compileChartSpec, embedChart, downloadPNG, downloadSVG, renderChartToPng, type VegaView } from "@/components/chat/chart-embed";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useSettings } from "@/lib/settings";
import { runAgentTurn, executeListTables, executeDescribeTable, type MessageParam, type ToolResult, type ToolResultContent } from "@/lib/ai-agent";
import { executeRunSql, validateChartSpec } from "@/lib/ai-tool-executor";
import { QueryResultCache } from "@/lib/query-results";
import { DEFAULT_AI_MAX_TOKENS } from "@/lib/ai/model-limits";
import { toolInputLabel } from "@/lib/ai/tool-labels";
import { exportResult, safeFileStem, triggerDownload } from "@/lib/editor/result-export";
import { consumeReportPromotion, type ReportPromotion } from "@/lib/reports/events";
import { reportDisplayRows, reportMapRows } from "@/lib/reports/display";
import { isBlockingVegaWarning, validateReportResultColumns } from "@/lib/reports/execution";
import { resolveReportAppearance } from "@/lib/reports/appearance";
import { REPORT_TOOLS, upsertAgentBlock, upsertAgentDataset, upsertAgentGroup, type SemanticBlockHeight, type SemanticBlockWidth } from "@/lib/reports/agent-tools";
import { compileReportQuery, interpolateReportText, materializeReportQuery } from "@/lib/reports/parameters";
import { generateReportNarrative, prepareNarrativeInput } from "@/lib/reports/narrative";
import { isReportTufteBlock, tufteBlockToVegaSpec } from "@/lib/reports/tufte";
import { buildShareReportUrl, clearSharedReport, consumeSharedReport } from "@/lib/reports/share";
import { deleteReport, exportReportJson, getStoredReport, importReportJson, listReports, restoreReportRevision, saveReport } from "@/lib/reports/store";
import { cloneReport, createEmptyReport, newReportId, type ReportAiNarrativeBlock, type ReportBlock, type ReportDataset, type ReportDocumentV1, type ReportGroup, type ReportParameter, type ReportParameterValue } from "@/lib/reports/types";
import { parameterTokens, validateParameterValue, validateReadOnlySql, validateReport } from "@/lib/reports/validation";

interface Props {
  catalogData: CatalogData;
  serviceUrl: string;
  attachedCatalogNames?: string[];
  onBusyChange?: (busy: boolean) => void;
}

interface DatasetResult {
  table: ArrowTable | null;
  rows: Record<string, any>[];
  status: "idle" | "queued" | "running" | "success" | "error";
  error?: string;
  fetchedAt?: number;
}

interface ReportRunProgress {
  generation: number;
  mode: "load" | "refresh";
  total: number;
  completed: number;
  currentDatasetName?: string;
}

interface NarrativeGenerationState {
  status: "idle" | "running" | "success" | "error";
  error?: string;
}

function isDatasetPending(result?: DatasetResult): boolean {
  return result?.status === "queued" || result?.status === "running";
}

function visibleMarkdownTitle(title?: string): string | null {
  const trimmed = title?.trim();
  if (!trimmed || /^(?:text|markdown)$/i.test(trimmed)) return null;
  return trimmed;
}

interface DatasetRunSummary {
  datasetId: string;
  name: string;
  ok: boolean;
  rowCount?: number;
  columns?: string[];
  sample?: Record<string, any>[];
  error?: string;
}

interface ReportAgentMessage {
  id: string;
  role: "user" | "assistant";
  content?: string;
  blocks?: ContentBlock[];
  isStreaming?: boolean;
  usage?: { inputTokens: number; outputTokens: number };
}

function defaultValues(report: ReportDocumentV1): Record<string, ReportParameterValue> {
  return Object.fromEntries(report.parameters.map((p) => [p.key, structuredClone(p.defaultValue)]));
}

function withNarrativeSnapshots(base: ReportDocumentV1, generated: ReportDocumentV1): ReportDocumentV1 {
  const snapshots = new Map(generated.blocks.filter((block): block is ReportAiNarrativeBlock => block.type === "ai_narrative").map((block) => [block.id, block.snapshot]));
  return {
    ...base,
    blocks: base.blocks.map((block) => block.type === "ai_narrative" && snapshots.has(block.id)
      ? { ...block, snapshot: snapshots.get(block.id) }
      : block),
  };
}

function sanitizeReportChartSpecs(report: ReportDocumentV1): { report: ReportDocumentV1; errors: string[] } {
  const next = cloneReport(report);
  const errors: string[] = [];
  next.blocks = next.blocks.map((block) => {
    if (block.type !== "chart") return block;
    const validation = validateChartSpec(block.spec);
    errors.push(...validation.errors.map((error) => `${block.title ?? block.id}: ${error}`));
    return { ...block, spec: validation.sanitized };
  });
  return { report: next, errors };
}

interface ChartPreflightResult {
  errors: string[];
  warnings: string[];
  feedback: ToolResultContent[];
}

async function preflightReportCharts(
  report: ReportDocumentV1,
  rowsByDataset: Map<string, Record<string, any>[]>,
  includeImages: boolean,
  maxImages = 3,
): Promise<ChartPreflightResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const feedback: ToolResultContent[] = [];
  let imageCount = 0;
  for (const block of report.blocks) {
    const spec = block.type === "chart"
      ? block.spec
      : isReportTufteBlock(block)
        ? tufteBlockToVegaSpec(block)
        : null;
    if (!spec) continue;
    const label = block.title ?? block.id;
    const compile = await compileChartSpec(spec);
    warnings.push(...compile.warnings.map((warning) => `${label}: ${warning}`));
    errors.push(...compile.warnings
      .filter(isBlockingVegaWarning)
      .map((warning) => `${label}: Vega-Lite warning requires correction: ${warning}`));
    if (compile.error) {
      errors.push(`${label}: Vega-Lite compile failed: ${compile.error}`);
      continue;
    }
    const datasetId = block.type === "chart" || isReportTufteBlock(block) ? block.datasetId : null;
    const rows = datasetId ? rowsByDataset.get(datasetId) : undefined;
    if (!rows) continue;
    // Rendering is both a smoke test for Vega runtime failures and optional
    // visual feedback for the multimodal model.
    const rendered = await renderChartToPng(spec, rows);
    if ("error" in rendered) {
      errors.push(`${label}: chart render failed: ${rendered.error}`);
      continue;
    }
    if (includeImages && imageCount < maxImages) {
      feedback.push({ type: "text", text: `Rendered chart preview for ${label}:` });
      feedback.push({ type: "image", source: { type: "base64", media_type: rendered.mediaType, data: rendered.data } });
      imageCount++;
    }
  }
  return { errors, warnings, feedback };
}

function toolResult(payload: Record<string, unknown>, feedback: ToolResultContent[] = []): ToolResult {
  const text = JSON.stringify(payload);
  return feedback.length ? [{ type: "text", text }, ...feedback] : text;
}

function nextY(report: ReportDocumentV1): number {
  return report.blocks.reduce((max, b) => Math.max(max, b.layout.y + b.layout.h), 0);
}

function formatKpi(value: unknown, format?: "number" | "currency" | "percent" | "text"): string {
  if (value == null) return "—";
  if (format === "text") return String(value);
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  if (format === "currency") return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(number);
  if (format === "percent") return new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 }).format(number);
  return new Intl.NumberFormat().format(number);
}

function reportBlockLabel(type: string): string {
  return type.split("_").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
}

const REPORT_GRID_ROW_HEIGHT = 56;
const REPORT_GRID_MARGIN = 12;
const REPORT_GRID_CONTAINER_PADDING = 12;
const REPORT_GRID_TOP_PADDING = 48;
const REPORT_GROUP_HEADER_GUTTER = 32;

const REPORT_GROUP_TONES = {
  neutral: {
    container: "border-border bg-muted/20",
    label: "border-border bg-background text-foreground",
  },
  blue: {
    container: "border-blue-300/70 bg-blue-50/30 dark:border-blue-700/70 dark:bg-blue-950/20",
    label: "border-blue-300 bg-blue-50 text-blue-900 dark:border-blue-700 dark:bg-blue-950 dark:text-blue-100",
  },
  green: {
    container: "border-emerald-300/70 bg-emerald-50/30 dark:border-emerald-700/70 dark:bg-emerald-950/20",
    label: "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-100",
  },
  amber: {
    container: "border-amber-300/70 bg-amber-50/30 dark:border-amber-700/70 dark:bg-amber-950/20",
    label: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100",
  },
  violet: {
    container: "border-violet-300/70 bg-violet-50/30 dark:border-violet-700/70 dark:bg-violet-950/20",
    label: "border-violet-300 bg-violet-50 text-violet-900 dark:border-violet-700 dark:bg-violet-950 dark:text-violet-100",
  },
  rose: {
    container: "border-rose-300/70 bg-rose-50/30 dark:border-rose-700/70 dark:bg-rose-950/20",
    label: "border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-100",
  },
} as const;

const REPORT_GROUP_TITLE_SIZES = {
  small: "text-xs",
  medium: "text-sm",
  large: "text-base",
} as const;

const REPORT_BLOCK_APPEARANCE = {
  neutral: {
    subtle: "bg-card",
    prominent: "border-muted-foreground/35 bg-muted/80",
    dot: "bg-muted-foreground",
  },
  info: {
    subtle: "border-sky-200 bg-sky-50/55 dark:border-sky-800 dark:bg-sky-950/35",
    prominent: "border-sky-300 bg-sky-100/90 dark:border-sky-700 dark:bg-sky-900/60",
    dot: "bg-sky-500",
  },
  success: {
    subtle: "border-emerald-200 bg-emerald-50/55 dark:border-emerald-800 dark:bg-emerald-950/35",
    prominent: "border-emerald-300 bg-emerald-100/90 dark:border-emerald-700 dark:bg-emerald-900/60",
    dot: "bg-emerald-500",
  },
  warning: {
    subtle: "border-amber-200 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/35",
    prominent: "border-amber-300 bg-amber-100/95 dark:border-amber-700 dark:bg-amber-900/60",
    dot: "bg-amber-500",
  },
  danger: {
    subtle: "border-rose-200 bg-rose-50/60 dark:border-rose-800 dark:bg-rose-950/35",
    prominent: "border-rose-300 bg-rose-100/95 dark:border-rose-700 dark:bg-rose-900/60",
    dot: "bg-rose-500",
  },
} as const;

interface ReportGroupBox {
  group: ReportGroup;
  left: number;
  top: number;
  width: number;
  height: number;
}

function reportGroupBoxes(
  groups: ReportGroup[],
  blocks: ReportBlock[],
  layout: Layout,
  containerWidth: number,
  columns: number,
): ReportGroupBox[] {
  const byId = new Map(layout.map((item) => [item.i, item]));
  const columnWidth = (containerWidth - REPORT_GRID_MARGIN * (columns - 1) - REPORT_GRID_CONTAINER_PADDING * 2) / columns;
  const xPosition = (column: number) => REPORT_GRID_CONTAINER_PADDING + column * (columnWidth + REPORT_GRID_MARGIN);
  const yPosition = (row: number) => REPORT_GRID_TOP_PADDING + REPORT_GRID_CONTAINER_PADDING + row * (REPORT_GRID_ROW_HEIGHT + REPORT_GRID_MARGIN);
  return groups.flatMap((group) => {
    const members = blocks.map((block) => block.groupId === group.id ? byId.get(block.id) : undefined).filter((item): item is NonNullable<typeof item> => Boolean(item));
    if (!members.length) return [];
    const minX = Math.min(...members.map((item) => item.x));
    const minY = Math.min(...members.map((item) => item.y));
    const maxX = Math.max(...members.map((item) => item.x + item.w));
    const maxY = Math.max(...members.map((item) => item.y + item.h));
    const left = xPosition(minX);
    const memberTop = yPosition(minY);
    const right = xPosition(maxX - 1) + columnWidth;
    const bottom = yPosition(maxY - 1) + REPORT_GRID_ROW_HEIGHT;
    const boxTop = Math.max(8, memberTop - REPORT_GROUP_HEADER_GUTTER);
    return [{ group, left: Math.max(0, left - 6), top: boxTop, width: Math.min(containerWidth, right + 6) - Math.max(0, left - 6), height: bottom + 6 - boxTop }];
  });
}

function applyPromotion(base: ReportDocumentV1, promotion: ReportPromotion): ReportDocumentV1 {
  const report = cloneReport(base);
  const dataset: ReportDataset = { id: newReportId("dataset"), name: promotion.title || `Dataset ${report.datasets.length + 1}`, sql: promotion.sql };
  report.datasets.push(dataset);
  let y = nextY(report);
  if (promotion.markdown) {
    report.blocks.push({ id: newReportId("block"), type: "markdown", markdown: promotion.markdown, layout: { x: 0, y, w: 12, h: 2 } });
    y += 2;
  }
  report.blocks.push(promotion.chartSpec
    ? { id: newReportId("block"), type: "chart", datasetId: dataset.id, title: promotion.title, spec: promotion.chartSpec, layout: { x: 0, y, w: 12, h: 6 } }
    : { id: newReportId("block"), type: "table", datasetId: dataset.id, title: promotion.title, pageSize: 50, layout: { x: 0, y, w: 12, h: 5 } });
  report.updatedAt = Date.now();
  return report;
}

function ReportChart({ block, rows, onViewChange }: {
  block: { id: string; spec: Record<string, any> };
  rows: Record<string, any>[];
  onViewChange: (blockId: string, view: VegaView | null) => void;
}) {
  const elRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<VegaView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    let frame = 0;
    let renderVersion = 0;
    let lastSize = "";
    const el = elRef.current;
    if (!el || !rows.length) return;
    const render = async () => {
      const width = el.clientWidth;
      const height = el.clientHeight;
      if (disposed || width < 50 || height < 50) return;
      const size = `${width}x${height}`;
      if (size === lastSize) return;
      lastSize = size;
      const version = ++renderVersion;
      viewRef.current?.finalize();
      viewRef.current = null;
      setError(null);
      try {
        const view = await embedChart(el, block.spec, rows, undefined, { forceHeight: Math.max(80, height) });
        if (disposed || version !== renderVersion) view.finalize();
        else {
          viewRef.current = view;
          onViewChange(block.id, view);
        }
      } catch (e) {
        if (!disposed && version === renderVersion) setError(e instanceof Error ? e.message : String(e));
      }
    };
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { void render(); });
    });
    observer.observe(el);
    frame = requestAnimationFrame(() => { void render(); });
    return () => { disposed = true; renderVersion++; cancelAnimationFrame(frame); observer.disconnect(); onViewChange(block.id, null); viewRef.current?.finalize(); viewRef.current = null; };
  }, [block.id, block.spec, rows, onViewChange]);
  return <div className="relative h-full min-h-0">
    {error ? <div className="text-xs text-destructive">{error}</div> : <div ref={elRef} data-testid="report-chart-container" className="h-full min-h-0 w-full overflow-hidden" />}
  </div>;
}

function ReportPerspective({ table, config, onConfig }: { table: ArrowTable; config?: Record<string, any>; onConfig: (config: Record<string, any>) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let disposed = false;
    let viewer: any = null;
    let listener: (() => void) | null = null;
    (async () => {
      const [{ tableToIPC }, { loadPerspective }] = await Promise.all([
        import("@query-farm/apache-arrow"), import("@/components/DuckDBShell"),
      ]);
      if (disposed || !containerRef.current) return;
      const bytes = tableToIPC(table, "file");
      await loadPerspective(containerRef.current, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
      viewer = containerRef.current.querySelector("perspective-viewer") as any;
      if (config && viewer?.restore) await viewer.restore(config);
      listener = async () => {
        try { if (viewer?.save) onConfig(await viewer.save()); } catch {}
      };
      viewer?.addEventListener("perspective-config-update", listener);
    })();
    return () => { disposed = true; if (viewer && listener) viewer.removeEventListener("perspective-config-update", listener); };
  }, [table]);
  return <div ref={containerRef} className="h-full min-h-[220px] bg-white" />;
}

function ReportAiNarrative({ block, state, onGenerate }: {
  block: ReportAiNarrativeBlock;
  state?: NarrativeGenerationState;
  onGenerate: () => void;
}) {
  const snapshot = block.snapshot;
  if (!snapshot && state?.status === "running") return <div className="flex h-full flex-col items-center justify-center gap-2 text-center" data-testid={`report-narrative-loading-${block.id}`}><Loader2 className="h-5 w-5 animate-spin text-primary" /><p className="text-xs text-muted-foreground">Generating narrative from report data…</p></div>;
  if (!snapshot) return <div className="flex h-full flex-col items-center justify-center gap-3 text-center" data-testid={`report-narrative-empty-${block.id}`}>
    <Sparkles className="h-6 w-6 text-muted-foreground/50" />
    <div><p className="text-sm font-medium">AI narrative has not been generated</p><p className="mt-1 max-w-md text-xs text-muted-foreground">It uses this block’s dataset without tools or report-editing access.</p></div>
    {state?.error && <p className="max-w-md text-xs text-destructive">{state.error}</p>}
    <Button size="sm" variant="outline" onClick={onGenerate}><Sparkles className="h-3.5 w-3.5" /> Generate narrative</Button>
  </div>;
  return <div className="flex min-h-full flex-col" data-testid={`report-narrative-${block.id}`}>
    <div className="flex-1"><ChatMarkdown content={snapshot.markdown} /></div>
    {state?.error && <p className="mt-3 text-xs text-destructive">Refresh failed: {state.error}</p>}
    <div className="mt-4 border-t pt-2 text-[10px] text-muted-foreground">AI-generated {new Date(snapshot.generatedAt).toLocaleString()} · {snapshot.rowCount} source row{snapshot.rowCount === 1 ? "" : "s"} · {snapshot.model}{snapshot.truncated ? " · input capped" : ""}</div>
  </div>;
}

function ParameterInput({ parameter, value, options, onChange }: { parameter: ReportParameter; value: ReportParameterValue; options: Array<{ label: string; value: string | number }>; onChange: (value: ReportParameterValue) => void }) {
  if (parameter.type === "boolean") return <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />{parameter.label}</label>;
  if (parameter.type === "select") return <div className="space-y-1"><Label className="text-xs">{parameter.label}</Label><Select value={value == null ? "" : String(value)} onValueChange={onChange}><SelectTrigger className="h-8 min-w-40"><SelectValue placeholder="Select…" /></SelectTrigger><SelectContent>{options.map((o) => <SelectItem key={String(o.value)} value={String(o.value)}>{o.label}</SelectItem>)}</SelectContent></Select></div>;
  if (parameter.type === "multi_select") return <div className="space-y-1"><Label className="text-xs">{parameter.label}</Label><div className="flex flex-wrap gap-2 border rounded-md px-2 py-1.5 min-h-8">{options.map((o) => <label key={String(o.value)} className="text-xs flex gap-1"><input type="checkbox" checked={Array.isArray(value) && value.map(String).includes(String(o.value))} onChange={(e) => { const current = Array.isArray(value) ? value.map(String) : []; onChange(e.target.checked ? [...current, String(o.value)] : current.filter((v) => v !== String(o.value))); }} />{o.label}</label>)}</div></div>;
  if (parameter.type === "date_range") {
    const range = value && typeof value === "object" && !Array.isArray(value) ? value as { start: string | null; end: string | null } : { start: null, end: null };
    return <div className="space-y-1"><Label className="text-xs">{parameter.label}</Label><div className="flex gap-1"><Input className="h-8" type="date" value={range.start ?? ""} onChange={(e) => onChange({ ...range, start: e.target.value || null })} /><Input className="h-8" type="date" value={range.end ?? ""} onChange={(e) => onChange({ ...range, end: e.target.value || null })} /></div></div>;
  }
  return <div className="space-y-1"><Label className="text-xs">{parameter.label}</Label><Input className="h-8 min-w-36" type={parameter.type === "number" ? "number" : parameter.type === "date" ? "date" : "text"} value={value == null ? "" : String(value)} onChange={(e) => onChange(parameter.type === "number" ? (e.target.value === "" ? null : Number(e.target.value)) : e.target.value)} /></div>;
}

export function ReportsWorkspace({ catalogData, serviceUrl, attachedCatalogNames = [], onBusyChange }: Props) {
  const { settings } = useSettings();
  const [reports, setReports] = useState<ReportDocumentV1[]>([]);
  const [selected, setSelected] = useState<ReportDocumentV1 | null>(null);
  const [draft, setDraft] = useState<ReportDocumentV1 | null>(null);
  const [results, setResults] = useState<Record<string, DatasetResult>>({});
  const [runProgress, setRunProgress] = useState<ReportRunProgress | null>(null);
  const [values, setValues] = useState<Record<string, ReportParameterValue>>({});
  const [appliedValues, setAppliedValues] = useState<Record<string, ReportParameterValue>>({});
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [sourceText, setSourceText] = useState("");
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentPrompt, setAgentPrompt] = useState("");
  const [agentConversation, setAgentConversation] = useState<ReportAgentMessage[]>([]);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentSummary, setAgentSummary] = useState<string | null>(null);
  const [narrativeStates, setNarrativeStates] = useState<Record<string, NarrativeGenerationState>>({});
  const [pendingPromotion, setPendingPromotion] = useState<ReportPromotion | null>(null);
  const [shareStatus, setShareStatus] = useState<string | null>(null);
  const [revisionOptions, setRevisionOptions] = useState<ReportDocumentV1[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const narrativeAbortRef = useRef<AbortController | null>(null);
  const agentMessagesRef = useRef<MessageParam[]>([]);
  const agentThreadRef = useRef<HTMLDivElement>(null);
  const runGeneration = useRef(0);
  const autoRefreshRunningRef = useRef(false);
  const autoRefreshStateRef = useRef<{
    report: ReportDocumentV1 | null;
    values: Record<string, ReportParameterValue>;
    busy: boolean;
  }>({ report: null, values: {}, busy: false });
  const resultCache = useRef(new QueryResultCache());
  const reportChartViews = useRef(new Map<string, VegaView>());
  const setReportChartView = useCallback((blockId: string, view: VegaView | null) => {
    if (view) reportChartViews.current.set(blockId, view);
    else reportChartViews.current.delete(blockId);
  }, []);
  const { width, containerRef, mounted } = useContainerWidth({ initialWidth: 1000 });

  const reload = useCallback(async () => setReports(await listReports()), []);
  useEffect(() => { reload(); const listener = () => reload(); window.addEventListener("cupola:reports-changed", listener); return () => window.removeEventListener("cupola:reports-changed", listener); }, [reload]);
  useEffect(() => { onBusyChange?.(agentBusy || Object.values(results).some(isDatasetPending) || Object.values(narrativeStates).some((state) => state.status === "running")); }, [agentBusy, results, narrativeStates, onBusyChange]);
  useEffect(() => {
    const thread = agentThreadRef.current;
    if (thread) thread.scrollTop = thread.scrollHeight;
  }, [agentConversation, agentBusy]);

  const generateNarratives = useCallback(async (
    report: ReportDocumentV1,
    runValues: Record<string, ReportParameterValue>,
    rowsByDataset: Map<string, Record<string, any>[]>,
    forceIds?: Set<string>,
    throwOnError = false,
  ): Promise<ReportDocumentV1> => {
    const candidates = report.blocks.filter((block): block is ReportAiNarrativeBlock => {
      if (block.type !== "ai_narrative" || !rowsByDataset.has(block.datasetId)) return false;
      return forceIds?.has(block.id) || block.refreshPolicy === "when_data_changes";
    });
    if (!candidates.length) return report;
    narrativeAbortRef.current?.abort();
    const controller = new AbortController();
    narrativeAbortRef.current = controller;
    const generated = new Map<string, ReportAiNarrativeBlock["snapshot"]>();
    const errors: string[] = [];
    await Promise.all(candidates.map(async (block) => {
      const rows = rowsByDataset.get(block.datasetId) ?? [];
      const prepared = prepareNarrativeInput(block, rows, report, runValues, settings.aiModel);
      if (!forceIds?.has(block.id) && block.snapshot?.dataFingerprint === prepared.fingerprint) return;
      setNarrativeStates((states) => ({ ...states, [block.id]: { status: "running" } }));
      try {
        const snapshot = await generateReportNarrative(settings.anthropicApiKey, settings.aiModel, block, rows, report, runValues, controller.signal);
        if (controller.signal.aborted) return;
        generated.set(block.id, snapshot);
        setNarrativeStates((states) => ({ ...states, [block.id]: { status: "success" } }));
      } catch (error) {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${block.title ?? block.id}: ${message}`);
        setNarrativeStates((states) => ({ ...states, [block.id]: { status: "error", error: message } }));
      }
    }));
    if (narrativeAbortRef.current === controller) narrativeAbortRef.current = null;
    if (throwOnError && errors.length) throw new Error(errors.join(" "));
    if (!generated.size) return report;
    return {
      ...report,
      updatedAt: Date.now(),
      blocks: report.blocks.map((block) => block.type === "ai_narrative" && generated.has(block.id)
        ? { ...block, snapshot: generated.get(block.id) }
        : block),
    };
  }, [settings.aiModel, settings.anthropicApiKey]);

  const openReport = useCallback((report: ReportDocumentV1, initialValues?: Record<string, ReportParameterValue>, autoRun = true, persisted = true) => {
    abortRef.current?.abort();
    abortRef.current = null;
    narrativeAbortRef.current?.abort();
    narrativeAbortRef.current = null;
    const generation = ++runGeneration.current;
    agentMessagesRef.current = [];
    resultCache.current = new QueryResultCache();
    reportChartViews.current.clear();
    const copy = cloneReport(report);
    const defaults = { ...defaultValues(copy), ...initialValues };
    setSelected(persisted ? copy : null); setDraft(copy); setValues(defaults); setAppliedValues(defaults); setResults({}); setNarrativeStates({}); setRunProgress(null); setSourceText(exportReportJson(copy)); setSourceError(null); setAgentSummary(null); setAgentConversation([]); setAgentPrompt(""); setAgentBusy(false);
    void getStoredReport(copy.id).then((stored) => setRevisionOptions(stored?.revisions ?? []));
    if (autoRun) setTimeout(() => {
      if (runGeneration.current !== generation) return;
      const rows = new Map<string, Record<string, any>[]>();
      void runDatasets(copy, defaults, undefined, rows).then(async () => {
        if (runGeneration.current !== generation) return;
        const generated = await generateNarratives(copy, defaults, rows);
        if (runGeneration.current === generation) setDraft((current) => current ? withNarrativeSnapshots(current, generated) : current);
      });
    }, 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generateNarratives]);

  useEffect(() => {
    consumeSharedReport().then((shared) => { if (shared) { openReport(shared.report, shared.values, false, false); clearSharedReport(); setShareStatus("Shared report opened for review. Save and run it when ready."); } });
  }, [openReport]);

  useEffect(() => {
    const consume = () => { const promotion = consumeReportPromotion(); if (promotion) setPendingPromotion(promotion); };
    consume(); window.addEventListener("cupola:promote-report", consume); return () => window.removeEventListener("cupola:promote-report", consume);
  }, []);

  const runDatasets = useCallback(async (
    report: ReportDocumentV1,
    runValues: Record<string, ReportParameterValue>,
    onlyIds?: Set<string>,
    captureRows?: Map<string, Record<string, any>[]>,
    mode: "load" | "refresh" = "load",
  ): Promise<DatasetRunSummary[]> => {
    const datasets = report.datasets.filter((d) => !onlyIds || onlyIds.has(d.id));
    const valueErrors = report.parameters.map((p) => validateParameterValue(p, runValues[p.key] ?? p.defaultValue)).filter(Boolean);
    if (valueErrors.length) {
      const error = valueErrors.join(" ");
      setShareStatus(error);
      return datasets.map((dataset) => ({ datasetId: dataset.id, name: dataset.name, ok: false, error }));
    }
    if (engine.attached) await engine.attached;
    if (!engine.queryPrepared) {
      const error = "DuckDB is still starting up.";
      setShareStatus(error);
      return datasets.map((dataset) => ({ datasetId: dataset.id, name: dataset.name, ok: false, error }));
    }
    if (datasets.length === 0) return [];
    const generation = ++runGeneration.current;
    const summaries: DatasetRunSummary[] = [];
    setRunProgress({ generation, mode, total: datasets.length, completed: 0 });
    setResults((prev) => {
      const next: Record<string, DatasetResult> = { ...prev };
      for (const [id, result] of Object.entries(next)) {
        if (isDatasetPending(result)) next[id] = { ...result, status: result.table ? "success" : "idle" };
      }
      for (const dataset of datasets) {
        next[dataset.id] = { ...(next[dataset.id] ?? { table: null, rows: [] }), status: "queued", error: undefined };
      }
      return next;
    });
    for (const dataset of datasets) {
      if (generation !== runGeneration.current) return summaries;
      setResults((prev) => ({
        ...prev,
        [dataset.id]: { ...(prev[dataset.id] ?? { table: null, rows: [] }), status: "running", error: undefined },
      }));
      setRunProgress((progress) => progress?.generation === generation
        ? { ...progress, currentDatasetName: dataset.name }
        : progress);
      try {
        const readErrors = validateReadOnlySql(dataset.sql);
        if (readErrors.length) throw new Error(readErrors.join(" "));
        const compiled = compileReportQuery(dataset.sql, report, runValues);
        const response = await engine.queryPrepared(compiled.sql, compiled.params);
        if (generation !== runGeneration.current) return summaries;
        if (!response.ok || !response.arrowBuffers?.[0]) throw new Error(response.error || "Query returned no result.");
        const table = decodeArrowBuffer(response.arrowBuffers[0]);
        const rows = tableToRows(table);
        captureRows?.set(dataset.id, rows);
        setResults((prev) => ({ ...prev, [dataset.id]: { table, rows, status: "success", fetchedAt: Date.now() } }));
        summaries.push({ datasetId: dataset.id, name: dataset.name, ok: true, rowCount: table.numRows, columns: table.schema.fields.map((field) => field.name), sample: rows.slice(0, 3) });
      } catch (e) {
        if (generation !== runGeneration.current) return summaries;
        const message = e instanceof Error ? e.message : String(e);
        setResults((prev) => ({ ...prev, [dataset.id]: { ...(prev[dataset.id] ?? { table: null, rows: [] }), status: "error", error: message } }));
        summaries.push({ datasetId: dataset.id, name: dataset.name, ok: false, error: message });
      }
      setRunProgress((progress) => progress?.generation === generation
        ? { ...progress, completed: progress.completed + 1, currentDatasetName: undefined }
        : progress);
    }
    setRunProgress((progress) => progress?.generation === generation ? null : progress);
    return summaries;
  }, []);

  const runDatasetsAndNarratives = useCallback(async (
    report: ReportDocumentV1,
    runValues: Record<string, ReportParameterValue>,
    onlyIds?: Set<string>,
    mode: "load" | "refresh" = "load",
    seedRows?: Map<string, Record<string, any>[]>,
  ): Promise<DatasetRunSummary[]> => {
    const rows = seedRows ?? new Map<string, Record<string, any>[]>();
    const summaries = await runDatasets(report, runValues, onlyIds, rows, mode);
    const generated = await generateNarratives(report, runValues, rows);
    if (generated !== report) setDraft((current) => current?.id === report.id ? withNarrativeSnapshots(current, generated) : current);
    return summaries;
  }, [generateNarratives, runDatasets]);

  const regenerateNarrative = useCallback(async (block: ReportAiNarrativeBlock) => {
    if (!draft) return;
    const rows = results[block.datasetId]?.rows;
    if (!rows) {
      setNarrativeStates((states) => ({ ...states, [block.id]: { status: "error", error: "Run the report data before generating this narrative." } }));
      return;
    }
    const generated = await generateNarratives(draft, appliedValues, new Map([[block.datasetId, rows]]), new Set([block.id]));
    if (generated !== draft) setDraft((current) => current?.id === draft.id ? withNarrativeSnapshots(current, generated) : current);
  }, [appliedValues, draft, generateNarratives, results]);

  const runFullReport = useCallback(() => {
    if (!draft) return;
    const nextValues = structuredClone(values);
    setAppliedValues(nextValues);
    const mode = draft.datasets.some((dataset) => Boolean(results[dataset.id]?.table)) ? "refresh" : "load";
    void runDatasetsAndNarratives(draft, nextValues, undefined, mode);
  }, [draft, values, results, runDatasetsAndNarratives]);

  const handleApply = useCallback(() => {
    if (!draft) return;
    const changed = new Set(Object.keys(values).filter((k) => JSON.stringify(values[k]) !== JSON.stringify(appliedValues[k])));
    const ids = changed.size ? new Set(draft.datasets.filter((d) => parameterTokens(d.sql).some((t) => changed.has(t) || changed.has(t.replace(/_(?:start|end)$/, "")))).map((d) => d.id)) : undefined;
    setAppliedValues(structuredClone(values));
    const mode = draft.datasets.some((dataset) => (!ids || ids.has(dataset.id)) && Boolean(results[dataset.id]?.table)) ? "refresh" : "load";
    const seedRows = new Map(Object.entries(results).filter(([, result]) => Boolean(result.table)).map(([datasetId, result]) => [datasetId, result.rows]));
    void runDatasetsAndNarratives(draft, values, ids, mode, seedRows);
  }, [draft, values, appliedValues, results, runDatasetsAndNarratives]);

  useEffect(() => {
    autoRefreshStateRef.current = {
      report: draft,
      values: appliedValues,
      busy: agentBusy || Object.values(results).some(isDatasetPending) || Object.values(narrativeStates).some((state) => state.status === "running"),
    };
  }, [draft, appliedValues, agentBusy, results, narrativeStates]);

  useEffect(() => {
    const seconds = draft?.refreshIntervalSeconds;
    if (!seconds) return;
    const interval = window.setInterval(() => {
      const current = autoRefreshStateRef.current;
      if (!current.report || current.busy || autoRefreshRunningRef.current || document.visibilityState !== "visible") return;
      autoRefreshRunningRef.current = true;
      void runDatasetsAndNarratives(current.report, structuredClone(current.values), undefined, "refresh")
        .finally(() => { autoRefreshRunningRef.current = false; });
    }, seconds * 1_000);
    return () => window.clearInterval(interval);
  }, [draft?.id, draft?.refreshIntervalSeconds, runDatasetsAndNarratives]);

  const updateAutoRefresh = useCallback((seconds?: number) => {
    if (!draft) return;
    const { refreshIntervalSeconds: _previous, ...rest } = draft;
    const next: ReportDocumentV1 = seconds
      ? { ...rest, refreshIntervalSeconds: seconds, updatedAt: Date.now() }
      : { ...rest, updatedAt: Date.now() };
    setDraft(next);
    setSourceText(exportReportJson(next));
  }, [draft]);

  const openDatasetInEditor = useCallback((dataset: ReportDataset) => {
    if (!draft) return;
    if (!ui.openInEditor) { setShareStatus("The SQL editor is not ready yet."); return; }
    try {
      ui.openInEditor(materializeReportQuery(dataset.sql, draft, appliedValues), { autoRun: false });
    } catch (error) {
      setShareStatus(error instanceof Error ? error.message : String(error));
    }
  }, [draft, appliedValues]);

  const createNew = useCallback(() => openReport(createEmptyReport("New report", catalogData.catalogName, serviceUrl), undefined, false, false), [catalogData.catalogName, serviceUrl, openReport]);

  const acceptDraft = useCallback(async () => {
    if (!draft) return;
    const saved = await saveReport(draft);
    setSelected(saved); setDraft(cloneReport(saved)); setSourceText(exportReportJson(saved)); setAgentSummary(null); await reload();
  }, [draft, reload]);

  const updateLayout = useCallback((layout: Layout) => {
    setDraft((current) => current ? { ...current, blocks: current.blocks.map((b) => { const item = layout.find((l) => l.i === b.id); return item ? { ...b, layout: { x: item.x, y: item.y, w: item.w, h: item.h } } : b; }) } : current);
  }, []);

  const resetAgentConversation = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    agentMessagesRef.current = [];
    resultCache.current = new QueryResultCache();
    setAgentConversation([]);
    setAgentPrompt("");
    setAgentBusy(false);
  }, []);

  const runAgent = useCallback(async () => {
    const prompt = agentPrompt.trim();
    if (!draft || !prompt || agentBusy) return;
    if (!settings.anthropicApiKey) {
      setAgentConversation((messages) => [...messages, {
        id: crypto.randomUUID(),
        role: "assistant",
        blocks: [{ type: "text", id: crypto.randomUUID(), content: "Add an Anthropic API key in **Settings** first." }],
      }]);
      return;
    }
    const controller = new AbortController();
    const assistantId = crypto.randomUUID();
    const seedThinking: ContentBlock = { type: "thinking", id: crypto.randomUUID(), label: "Thinking" };
    abortRef.current = controller;
    agentMessagesRef.current.push({ role: "user", content: prompt });
    setAgentConversation((messages) => [...messages,
      { id: crypto.randomUUID(), role: "user", content: prompt },
      { id: assistantId, role: "assistant", blocks: [seedThinking], isStreaming: true },
    ]);
    setAgentPrompt("");
    setAgentBusy(true);
    setAgentSummary(null);

    let blocks: ContentBlock[] = [seedThinking];
    let errorShown = false;
    const updateBlocks = (next: ContentBlock[]) => {
      blocks = next;
      setAgentConversation((messages) => messages.map((message) => message.id === assistantId
        ? { ...message, blocks: [...blocks] }
        : message));
    };
    const updateAssistant = (patch: Partial<ReportAgentMessage>) => {
      setAgentConversation((messages) => messages.map((message) => message.id === assistantId
        ? { ...message, ...patch }
        : message));
    };
    const ensureTextBlock = (): number => {
      if (blocks[blocks.length - 1]?.type === "text") return blocks.length - 1;
      blocks = [...blocks, { type: "text", id: crypto.randomUUID(), content: "" }];
      return blocks.length - 1;
    };
    const removeThinking = () => { blocks = blocks.filter((block) => block.type !== "thinking"); };
    const showThinking = (label: string) => {
      removeThinking();
      updateBlocks([...blocks, { type: "thinking", id: crypto.randomUUID(), label }]);
    };
    const appendText = (chunk: string) => {
      removeThinking();
      const index = ensureTextBlock();
      const textBlock = blocks[index] as Extract<ContentBlock, { type: "text" }>;
      updateBlocks(blocks.map((block, blockIndex) => blockIndex === index
        ? { ...textBlock, content: textBlock.content + chunk }
        : block));
    };
    const showError = (error: string) => {
      errorShown = true;
      removeThinking();
      const index = ensureTextBlock();
      const textBlock = blocks[index] as Extract<ContentBlock, { type: "text" }>;
      updateBlocks(blocks.map((block, blockIndex) => blockIndex === index
        ? { ...textBlock, content: textBlock.content + (textBlock.content ? "\n\n" : "") + `**Error:** ${error}` }
        : block));
    };
    let workingReport = cloneReport(draft);
    const workingRows = new Map<string, Record<string, any>[]>();
    const applyWorkingReport = (report: ReportDocumentV1, clearResults = false) => {
      workingReport = cloneReport(report);
      const nextValues = defaultValues(workingReport);
      setDraft(cloneReport(workingReport));
      setSourceText(exportReportJson(workingReport));
      setValues(nextValues);
      setAppliedValues(nextValues);
      if (clearResults) setResults({});
    };
    const finalizeWorkingReport = async (candidate: ReportDocumentV1, summary: string, clearResults = false): Promise<ToolResult> => {
      const structureErrors = validateReport(candidate);
      if (structureErrors.length) return toolResult({ ok: false, errors: structureErrors, message: "Correct the report structure before finalizing." });
      const sanitized = sanitizeReportChartSpecs(candidate);
      if (sanitized.errors.length) return toolResult({ ok: false, errors: sanitized.errors, message: "Correct the chart specifications before finalizing." });
      applyWorkingReport(sanitized.report, clearResults);
      workingRows.clear();
      const execution = await runDatasets(workingReport, defaultValues(workingReport), undefined, workingRows);
      const failures = execution.filter((result) => !result.ok);
      const blockErrors = validateReportResultColumns(workingReport, execution);
      const charts = await preflightReportCharts(workingReport, workingRows, settings.aiChartFeedback !== false);
      const narrativeErrors: string[] = [];
      if (!failures.length && !blockErrors.length && !charts.errors.length) {
        const staleNarrativeIds = new Set(workingReport.blocks
          .filter((block): block is ReportAiNarrativeBlock => block.type === "ai_narrative")
          .filter((block) => {
            const rows = workingRows.get(block.datasetId);
            if (!rows) return false;
            const prepared = prepareNarrativeInput(block, rows, workingReport, defaultValues(workingReport), settings.aiModel);
            return block.snapshot?.dataFingerprint !== prepared.fingerprint;
          })
          .map((block) => block.id));
        if (staleNarrativeIds.size) {
          try {
            const generated = await generateNarratives(workingReport, defaultValues(workingReport), workingRows, staleNarrativeIds, true);
            if (generated !== workingReport) applyWorkingReport(generated);
          } catch (error) {
            narrativeErrors.push(error instanceof Error ? error.message : String(error));
          }
        }
      }
      const needsCorrection = failures.length > 0 || blockErrors.length > 0 || charts.errors.length > 0 || narrativeErrors.length > 0;
      setAgentSummary(needsCorrection ? `${summary} The draft needs correction.` : `${summary} Data, visualizations, and AI narratives loaded.`);
      return toolResult({
        ok: !needsCorrection,
        message: needsCorrection
          ? "The report ran, but has dataset, column, visualization, or AI narrative errors. Correct the affected item and finalize again."
          : "Every dataset executed, every chart rendered, and every AI narrative was snapshotted. The populated report is ready for user review.",
        datasets: execution,
        blockErrors,
        chartErrors: charts.errors,
        chartWarnings: charts.warnings,
        narrativeErrors,
      }, charts.feedback);
    };
    const system = `You are Cupola's report-authoring agent. Build and revise a declarative, rerunnable report. Never add JavaScript.

Use a compositional workflow: (1) inspect tables, (2) call configure_report, (3) create any meaningful visual sections with upsert_report_group, (4) call upsert_report_dataset for one dataset and fix its SQL before continuing, (5) call upsert_report_block for one block and fix any compile/render error before continuing, and (6) call finalize_report. Do not finish until finalize_report returns ok=true. Prefer these tools over replace_report_draft.

Cupola owns grid placement for compositional blocks. upsert_report_block may request only the semantic width values quarter/third/half/full and height values compact/medium/tall; never send numeric col/x/y/w/h fields. The strict bulk fallback is different: every full-document block must contain layout nested exactly as {"layout":{"x":0,"y":0,"w":12,"h":6}}; layout fields are never top-level.

Use report groups when two or more blocks belong to the same subject and the grouping helps the reader scan the page—for example one rounded section for each city in a weather comparison. Create each group first, then set groupId on every related block. Give groups specific titles, optional short descriptions, and restrained tones; titleSize may be small, medium (the default), or large. Use large when the group name is a major report section and small only in dense layouts. Do not create a group around a single block unless the user asks for it.

Blocks may set appearance for semantic backgrounds. Use tone neutral/info/success/warning/danger and emphasis subtle/prominent. For value-driven alerts, add up to five ordered rules with column, operator, value, tone, label, and optional value2/emphasis/rowMatch; the first matching rule wins. Put severe rules first. Always provide a concise label such as "Above preferred range" so color is not the only signal. Only use thresholds supplied by the user or clearly defined by the data/domain—never invent alert boundaries. Prefer this for KPIs and compact status boxes; use it sparingly on large charts and tables.

Inspect every table before using it. SQL datasets must be one read-only SELECT/VALUES/WITH query. Parameter references use $key, date ranges use $key_start/$key_end, and multi-select values appear in IN ($key). Do not add a WHERE clause unless the user's request actually requires filtering.

Supported blocks are markdown, ai_narrative, kpi, sparkline, small_multiples, bullet, slopegraph, range_dot, table, chart, perspective, and map. Every block may include a concise caption and source note. Reader-facing block and group titles may contain parameter tokens such as $city; Cupola replaces them with the currently applied value at render time. A markdown block may have a meaningful visible title or omit title for a clean content-only card; never title one "Text" or "Markdown", and omit the block title when the markdown already begins with its own heading. Markdown supports safe HTTPS and relative image URLs with ![alt text](url), but Cupola does not upload or persist image files.

Use ai_narrative only when data-dependent prose adds real value, such as an executive summary, comparison, anomaly explanation, or changing forecast commentary. Provide one datasetId and a focused instruction, optionally columns, maxRows from 1 to 100, and refreshPolicy manual or when_data_changes. Prefer a compact, aggregated dataset rather than sending raw detail. Manual is the default and avoids surprise cost; choose when_data_changes only when the user wants fresh prose during report refresh. The narrative call has no tools and cannot edit the report. Cupola generates and snapshots it during authoring, so do not also write a static markdown version of the same summary.

Use these semantic Tufte-style blocks before writing a free-form chart when they fit:
- small_multiples: facetColumn, xColumn, yColumn; optionally xType, mark, colorColumn, facetColumns, sharedY, referenceValue, and referenceLabel. Prefer sharedY=true for honest comparison unless units or magnitudes genuinely differ.
- bullet: categoryColumn, valueColumn, targetColumn; optionally up to three broad-to-narrow rangeColumns, format, and color. Use for actual versus goal, not as a decorative gauge.
- slopegraph: categoryColumn, startColumn, endColumn; optionally startLabel, endLabel, colorColumn, and format. Use only for two endpoints.
- range_dot: categoryColumn, lowColumn, highColumn; optionally valueColumn, format, and color. Use for intervals, uncertainty, min/max, or benchmarks.

Use sparkline for a compact single-metric trend box: provide datasetId and valueColumn, optionally labelColumn, format, showValue, and color. Sparkline points follow query result order, so order the dataset in SQL. It needs no Vega spec and defaults to a compact quarter-width box with almost no chart margin. Use a full chart when axes, legends, multiple series, or richer encodings matter. Charts are minimal Vega-Lite v5 specs without data, datasets, url, href, or src. Vega-Lite y2 is valid only as an encoding definition such as {"y2":{"field":"high"}}; use layers only when the visual itself needs layers, not as a generic error workaround. The block tool compiles and renders all visualization blocks with real rows and may return an image. Treat its exact compiler/render error as authoritative; do not guess at causes.

Maps are declarative Leaflet blocks: set type="map", datasetId, and either geometryColumn for WKB/GeoJSON or both latitudeColumn and longitudeColumn. Maps may also set labelColumn, colorColumn, tooltipColumns, basemap ("openstreetmap" or "none"), palette, and style.

Reports may set refreshIntervalSeconds from 5 through 86400 when the user wants live automatic refresh; omit it (or configure it as null) otherwise.

Current report:\n${JSON.stringify(draft)}`;
    try {
      await runAgentTurn(settings.anthropicApiKey, settings.aiModel, agentMessagesRef.current, system, async (name, input) => {
        if (name === "list_tables") return executeListTables(catalogData);
        if (name === "describe_table") return executeDescribeTable(catalogData, input.schema, input.table);
        if (name === "preview_sql") {
          const errors = validateReadOnlySql(String(input.sql ?? "")); if (errors.length) throw new Error(errors.join(" "));
          if (!engine.query) throw new Error("DuckDB is not ready.");
          return executeRunSql(input.sql, { query: engine.query, resultCache: resultCache.current });
        }
        if (name === "configure_report") {
          const next = cloneReport(workingReport);
          next.title = String(input.title ?? "").trim();
          if ("description" in input) next.description = String(input.description ?? "");
          if ("refreshIntervalSeconds" in input) {
            if (input.refreshIntervalSeconds == null) delete next.refreshIntervalSeconds;
            else next.refreshIntervalSeconds = Number(input.refreshIntervalSeconds);
          }
          if (Array.isArray(input.requiredSources)) next.requiredSources = structuredClone(input.requiredSources);
          if (Array.isArray(input.parameters)) next.parameters = structuredClone(input.parameters);
          next.updatedAt = Date.now();
          const errors = validateReport(next);
          if (errors.length) return toolResult({ ok: false, errors });
          applyWorkingReport(next);
          return toolResult({ ok: true, reportId: next.id, title: next.title, refreshIntervalSeconds: next.refreshIntervalSeconds ?? null, parameterKeys: next.parameters.map((parameter) => parameter.key) });
        }
        if (name === "upsert_report_group") {
          const updated = upsertAgentGroup(workingReport, input.group ?? {});
          const errors = validateReport(updated.report);
          if (errors.length) return toolResult({ ok: false, groupId: updated.group.id, errors });
          applyWorkingReport(updated.report);
          setAgentSummary(`${updated.group.title} group added.`);
          return toolResult({ ok: true, groupId: updated.group.id, message: "Group created. Set this groupId on every related report block." });
        }
        if (name === "upsert_report_dataset") {
          const updated = upsertAgentDataset(workingReport, input.dataset ?? {});
          const errors = validateReport(updated.report);
          if (errors.length) return toolResult({ ok: false, datasetId: updated.dataset.id, errors });
          applyWorkingReport(updated.report);
          const execution = await runDatasets(workingReport, defaultValues(workingReport), new Set([updated.dataset.id]), workingRows);
          const result = execution[0];
          setAgentSummary(result?.ok ? `${updated.dataset.name} loaded.` : `${updated.dataset.name} needs correction.`);
          return toolResult({
            ok: Boolean(result?.ok),
            datasetId: updated.dataset.id,
            message: result?.ok ? "Dataset executed. Reuse datasetId when adding blocks or revising this query." : "Fix this dataset and call upsert_report_dataset again with the same datasetId.",
            result,
          });
        }
        if (name === "upsert_report_block") {
          const updated = upsertAgentBlock(workingReport, input.block ?? {}, input.width as SemanticBlockWidth | undefined, input.height as SemanticBlockHeight | undefined);
          const sanitized = sanitizeReportChartSpecs(updated.report);
          const errors = [...sanitized.errors, ...validateReport(sanitized.report)];
          if (errors.length) return toolResult({ ok: false, blockId: updated.block.id, errors, message: "Correct the block and call upsert_report_block again with this blockId." });
          const block = sanitized.report.blocks.find((candidate) => candidate.id === updated.block.id)!;
          applyWorkingReport(sanitized.report);
          if (block.type === "markdown") {
            setAgentSummary(`${visibleMarkdownTitle(block.title) ?? "Text block"} added.`);
            return toolResult({ ok: true, blockId: block.id, layout: block.layout, message: "Text block rendered without requiring a dataset." });
          }
          const execution = await runDatasets(workingReport, defaultValues(workingReport), new Set([block.datasetId]), workingRows);
          const blockErrors = validateReportResultColumns({ ...workingReport, blocks: [block] }, execution);
          const charts = await preflightReportCharts({ ...workingReport, blocks: [block] }, workingRows, settings.aiChartFeedback !== false, 1);
          const narrativeErrors: string[] = [];
          if (block.type === "ai_narrative" && execution.every((result) => result.ok) && !blockErrors.length) {
            try {
              const generated = await generateNarratives(workingReport, defaultValues(workingReport), workingRows, new Set([block.id]), true);
              if (generated !== workingReport) applyWorkingReport(generated);
            } catch (error) {
              narrativeErrors.push(error instanceof Error ? error.message : String(error));
            }
          }
          const needsCorrection = execution.some((result) => !result.ok) || blockErrors.length > 0 || charts.errors.length > 0 || narrativeErrors.length > 0;
          setAgentSummary(needsCorrection ? `${block.title ?? block.type} needs correction.` : `${block.title ?? block.type} loaded.`);
          return toolResult({
            ok: !needsCorrection,
            blockId: block.id,
            layout: block.layout,
            message: needsCorrection
              ? "Correct this block and call upsert_report_block again with the same blockId."
              : block.type === "ai_narrative"
                ? "Block validated against live data, generated, and snapshotted successfully."
                : "Block validated against live data and rendered successfully.",
            dataset: execution[0],
            blockErrors,
            chartErrors: charts.errors,
            chartWarnings: charts.warnings,
            narrativeErrors,
          }, charts.feedback);
        }
        if (name === "finalize_report") {
          return finalizeWorkingReport(workingReport, String(input.summary ?? "Report updated"));
        }
        if (name === "replace_report_draft") {
          return finalizeWorkingReport(input.report as ReportDocumentV1, String(input.summary ?? "Draft updated"), true);
        }
        throw new Error(`Unknown tool ${name}`);
      }, {
        onText: appendText,
        onToolInputStart: (name) => showThinking(toolInputLabel(name)),
        onToolCall: (name, input) => {
          removeThinking();
          const toolCall: ToolCallEntry = { name, input, isExecuting: true };
          updateBlocks([...blocks, { type: "tool_call", id: crypto.randomUUID(), toolCall }]);
        },
        onToolResult: (_name, summary) => {
          const reverseIndex = [...blocks].reverse().findIndex((block) => block.type === "tool_call" && block.toolCall.isExecuting);
          if (reverseIndex >= 0) {
            const index = blocks.length - 1 - reverseIndex;
            const block = blocks[index] as Extract<ContentBlock, { type: "tool_call" }>;
            const isError = summary.startsWith("Error:");
            blocks = blocks.map((item, blockIndex) => blockIndex === index
              ? { ...block, toolCall: { ...block.toolCall, isExecuting: false, error: isError ? summary.slice(7) : undefined, result: isError ? undefined : summary } }
              : item);
          }
          showThinking("Thinking");
        },
        onDone: (usage) => {
          removeThinking();
          updateBlocks(blocks);
          updateAssistant({ isStreaming: false, usage });
          setAgentBusy(false);
        },
        onRetry: (message) => showThinking(message ? message.replace("...", "") : "Thinking"),
        onError: showError,
      }, controller.signal, settings.aiMaxToolRounds ?? 20, REPORT_TOOLS, settings.aiMaxTokens ?? DEFAULT_AI_MAX_TOKENS, false);
    } catch (e) {
      if ((e as any)?.name !== "AbortError" && !errorShown) showError(e instanceof Error ? e.message : String(e));
      removeThinking();
      blocks = blocks.map((block) => block.type === "tool_call" && block.toolCall.isExecuting
        ? { ...block, toolCall: { ...block.toolCall, isExecuting: false, error: "Cancelled" } }
        : block);
      if (blocks.length === 0 && (e as any)?.name === "AbortError") blocks = [{ type: "text", id: crypto.randomUUID(), content: "Stopped." }];
      updateBlocks(blocks);
      updateAssistant({ isStreaming: false });
      setAgentBusy(false);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [draft, agentPrompt, agentBusy, settings, catalogData, runDatasets]);

  const compatibleCatalogs = useMemo(() => new Set([catalogData.catalogName, ...attachedCatalogNames, "memory"]), [catalogData.catalogName, attachedCatalogNames]);
  const isCompatible = (r: ReportDocumentV1) => r.requiredSources.every((s) => compatibleCatalogs.has(s.catalog));

  const promotionDialog = pendingPromotion ? <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4 report-authoring-control"><div className="bg-card border rounded-lg shadow-xl p-5 w-full max-w-md"><h2 className="font-semibold">Add query to a report</h2><p className="text-sm text-muted-foreground mt-1 mb-4">Create a new report or append this dataset to an existing report draft.</p><div className="flex flex-col gap-2 max-h-[60vh] overflow-y-auto"><Button onClick={() => { const report = applyPromotion(createEmptyReport(pendingPromotion.title || "Report from query", catalogData.catalogName, serviceUrl), pendingPromotion); setPendingPromotion(null); openReport(report, undefined, false, false); }}>Create new report</Button>{draft && <Button variant="outline" onClick={() => { const report = applyPromotion(draft, pendingPromotion); setPendingPromotion(null); setDraft(report); setSourceText(exportReportJson(report)); }}>Add to open report: {draft.title}</Button>}{reports.filter((r) => r.id !== draft?.id).map((report) => <Button key={report.id} variant="outline" onClick={() => { const updated = applyPromotion(report, pendingPromotion); setPendingPromotion(null); openReport(updated, undefined, false, false); }}>Add to {report.title}</Button>)}<Button variant="ghost" onClick={() => setPendingPromotion(null)}>Cancel</Button></div></div></div> : null;

  if (!draft) return <div className="h-full overflow-y-auto bg-background p-4 sm:p-6" data-testid="reports-workspace">
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center justify-between gap-4 mb-5"><div><h1 className="text-xl font-semibold">Reports</h1><p className="text-sm text-muted-foreground">Reusable, agent-authored analysis against your attached data.</p></div><div className="flex flex-wrap justify-end gap-2"><a href={`${import.meta.env.BASE_URL}report-guide/`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm hover:bg-muted"><BookOpen className="h-4 w-4" /> Visualization guide</a><label className="inline-flex"><input type="file" accept="application/json,.json" className="sr-only" onChange={async (e) => { const file = e.target.files?.[0]; if (!file) return; try { openReport(importReportJson(await file.text()), undefined, false, false); setShareStatus("Imported report opened for review."); } catch (err) { setShareStatus(err instanceof Error ? err.message : String(err)); } }} /><span className="inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm cursor-pointer hover:bg-muted"><FileJson className="h-4 w-4" /> Import</span></label><Button onClick={createNew}><Plus className="h-4 w-4" /> New report</Button></div></div>
      {shareStatus && <div className="mb-4 rounded-md border bg-muted/40 p-3 text-sm">{shareStatus}</div>}
      {reports.length === 0 ? <div className="border border-dashed rounded-xl p-12 text-center"><BarChart3 className="h-10 w-10 mx-auto text-muted-foreground/40 mb-3" /><p className="font-medium">No saved reports yet</p><p className="text-sm text-muted-foreground mb-4">Ask the report agent to build one, or add a query from the editor.</p><Button onClick={createNew}><Sparkles className="h-4 w-4" /> Create with AI</Button></div> : <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">{reports.map((report) => <div key={report.id} className="relative border rounded-lg bg-card hover:border-primary/50 transition-colors"><button onClick={() => openReport(report, undefined, isCompatible(report))} className="w-full text-left p-4 pr-10"><div className="flex justify-between gap-2"><span className="font-medium truncate">{report.title}</span><span className={`text-[10px] rounded-full px-2 py-0.5 ${isCompatible(report) ? "bg-emerald-500/10 text-emerald-700" : "bg-amber-500/10 text-amber-700"}`}>{isCompatible(report) ? "Ready" : "Missing source"}</span></div><p className="text-xs text-muted-foreground mt-2 line-clamp-2">{report.description || `${report.blocks.length} blocks · ${report.datasets.length} datasets`}</p><p className="text-[10px] text-muted-foreground mt-3">Revision {report.revision}</p></button><button className="absolute right-2 bottom-2 p-1 text-muted-foreground hover:text-destructive" aria-label={`Delete ${report.title}`} onClick={async () => { if (confirm(`Delete “${report.title}”?`)) await deleteReport(report.id); }}><Trash2 className="h-3.5 w-3.5" /></button></div>)}</div>}
    </div>
    {promotionDialog}
  </div>;

  const reportErrors = validateReport(draft);
  const dirty = !selected || JSON.stringify(draft) !== JSON.stringify(selected);
  const optionValues = (p: ReportParameter) => {
    const options = p.options;
    if (!options) return [];
    if (options.kind === "static") return options.values;
    return (results[options.datasetId]?.rows ?? []).map((row) => ({
      value: row[options.valueColumn] as string | number,
      label: String(row[options.labelColumn || options.valueColumn] ?? ""),
    }));
  };
  const desktopLayout = draft.blocks.map((block) => ({ i: block.id, ...block.layout }));
  let mobileY = 0;
  let previousMobileGroup: string | undefined;
  const mobileLayout = [...draft.blocks]
    .sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x)
    .map((block) => {
      if (mobileY > 0 && block.groupId && block.groupId !== previousMobileGroup) mobileY += 1;
      const item = { i: block.id, x: 0, y: mobileY, w: 1, h: block.layout.h };
      mobileY += block.layout.h;
      previousMobileGroup = block.groupId;
      return item;
    });
  const layouts: ResponsiveLayouts<"lg" | "sm"> = { lg: desktopLayout, sm: mobileLayout };
  const activeLayout = width >= 768 ? desktopLayout : mobileLayout;
  const groupBoxes = reportGroupBoxes(draft.groups ?? [], draft.blocks, activeLayout, width, width >= 768 ? 12 : 1);
  const reportRunning = Object.values(results).some(isDatasetPending) || Object.values(narrativeStates).some((state) => state.status === "running");
  const reportFetchedAt = reportRunning ? 0 : Math.max(0, ...draft.datasets.map((dataset) => results[dataset.id]?.fetchedAt ?? 0));
  const progressLabel = runProgress
    ? `${runProgress.mode === "refresh" ? "Refreshing" : "Loading"} ${runProgress.completed} of ${runProgress.total} datasets`
    : null;

  return <div className="h-full flex flex-col bg-background" data-testid="reports-workspace" aria-busy={reportRunning}>
    <div className="report-authoring-control flex items-center gap-2 px-3 py-2 border-b bg-card overflow-x-auto">
      <Button size="sm" variant="ghost" onClick={() => { runGeneration.current += 1; setRunProgress(null); setDraft(null); setSelected(null); setResults({}); }}><ArrowLeft className="h-4 w-4" /> Library</Button>
      <Input className="h-8 min-w-48 max-w-sm font-medium" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
      <div className="flex-1" />
      <Button size="sm" variant="outline" onClick={() => setAgentOpen((v) => !v)}><Bot className="h-4 w-4" /> Agent</Button>
      {revisionOptions.length > 0 && <select className="h-8 rounded-md border bg-background px-2 text-xs" defaultValue="" aria-label="Restore report revision" onChange={async (e) => { const revision = Number(e.target.value); if (!revision) return; const restored = await restoreReportRevision(draft.id, revision); openReport(restored, undefined, false); }}><option value="">History</option>{revisionOptions.slice().reverse().map((r) => <option key={r.revision} value={r.revision}>Restore revision {r.revision}</option>)}</select>}
      <Button size="sm" variant="outline" onClick={() => { setInspectorOpen((v) => !v); setSourceText(exportReportJson(draft)); }}><FileJson className="h-4 w-4" /> Source</Button>
      {reportFetchedAt > 0 && <span data-testid="report-as-of" className="shrink-0 text-[10px] text-muted-foreground">as of {new Date(reportFetchedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" })}</span>}
      <Button size="sm" data-testid="reports-run" disabled={reportErrors.length > 0 || reportRunning} onClick={runFullReport}>{reportRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} {progressLabel ?? "Run report"}</Button>
      <select
        className="h-8 rounded-md border bg-background px-2 text-xs"
        aria-label="Auto refresh"
        value={draft.refreshIntervalSeconds ?? 0}
        onChange={(event) => updateAutoRefresh(Number(event.target.value) || undefined)}
      >
        <option value={0}>Auto refresh off</option>
        {draft.refreshIntervalSeconds && ![30, 60, 300, 900].includes(draft.refreshIntervalSeconds)
          ? <option value={draft.refreshIntervalSeconds}>Every {draft.refreshIntervalSeconds} seconds</option>
          : null}
        <option value={30}>Every 30 seconds</option>
        <option value={60}>Every minute</option>
        <option value={300}>Every 5 minutes</option>
        <option value={900}>Every 15 minutes</option>
      </select>
      <Button size="sm" variant="outline" onClick={() => window.print()}><Printer className="h-4 w-4" /> Print</Button>
      <Button size="sm" variant="outline" onClick={() => triggerDownload(new Blob([exportReportJson(draft)], { type: "application/json" }), `${safeFileStem(draft.title)}.cupola-report.json`)}><Download className="h-4 w-4" /> JSON</Button>
      <Button size="sm" variant="outline" onClick={async () => { try { await navigator.clipboard.writeText(await buildShareReportUrl(draft, { serviceUrl, values: appliedValues })); setShareStatus("Share link copied."); } catch (e) { setShareStatus(e instanceof Error ? e.message : String(e)); } }}><Share2 className="h-4 w-4" /> Share</Button>
      <Button size="sm" disabled={!dirty || reportErrors.length > 0} onClick={acceptDraft}><Save className="h-4 w-4" /> Accept & save</Button>
    </div>
    {runProgress && <div data-testid="report-run-progress" className="report-authoring-control border-b bg-muted/30 px-4 py-2" aria-live="polite">
      <div className="flex items-center gap-2 text-xs">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
        <span className="font-medium">{progressLabel}</span>
        {runProgress.currentDatasetName && <span className="truncate text-muted-foreground">Running {runProgress.currentDatasetName}</span>}
      </div>
      <div
        role="progressbar"
        aria-label={runProgress.mode === "refresh" ? "Report refresh progress" : "Report loading progress"}
        aria-valuemin={0}
        aria-valuemax={runProgress.total}
        aria-valuenow={runProgress.completed}
        className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted"
      >
        <div className="h-full bg-primary transition-[width] duration-200" style={{ width: `${(runProgress.completed / runProgress.total) * 100}%` }} />
      </div>
    </div>}
    {(!isCompatible(draft) || reportErrors.length > 0 || shareStatus || agentSummary) && <div className="px-4 py-2 border-b text-xs space-y-1">{!isCompatible(draft) && <div className="text-amber-700">Missing required catalogs: {draft.requiredSources.filter((s) => !compatibleCatalogs.has(s.catalog)).map((s) => s.catalog).join(", ")}</div>}{reportErrors.length > 0 && <div className="text-destructive">{reportErrors.join(" ")}</div>}{shareStatus && <div>{shareStatus}</div>}{agentSummary && <div className="text-primary"><Check className="inline h-3 w-3 mr-1" />Agent draft: {agentSummary}</div>}</div>}
    {draft.parameters.length > 0 && <div className="report-parameters report-authoring-control flex flex-wrap items-end gap-3 px-4 py-3 border-b bg-muted/20">{draft.parameters.map((p) => <ParameterInput key={p.id} parameter={p} value={values[p.key] ?? p.defaultValue} options={optionValues(p)} onChange={(value) => setValues((v) => ({ ...v, [p.key]: value }))} />)}<Button size="sm" onClick={handleApply}><Play className="h-4 w-4" /> Apply</Button></div>}
    <div className="flex-1 min-h-0 flex">
      <div ref={containerRef} className="flex-1 min-w-0 overflow-y-auto report-canvas p-3">
        <div className="print-only hidden mb-4"><h1 className="text-2xl font-bold">{draft.title}</h1><p className="text-sm text-muted-foreground">{draft.description}</p></div>
        {draft.blocks.length === 0 ? <div className="h-full flex items-center justify-center"><div className="text-center"><FilePlus2 className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" /><p className="font-medium">Start with a request</p><p className="text-sm text-muted-foreground mb-4">Open the agent and describe the report you need.</p><Button onClick={() => setAgentOpen(true)}><Sparkles className="h-4 w-4" /> Open report agent</Button></div></div> : mounted && <div className="report-grid-stack relative" style={{ paddingTop: REPORT_GRID_TOP_PADDING }}>
          <div className="report-group-layer report-authoring-group-layer pointer-events-none absolute inset-0 z-0" aria-hidden="true">
            {groupBoxes.map((box) => {
              const tone = REPORT_GROUP_TONES[box.group.tone ?? "neutral"];
              const titleSize = REPORT_GROUP_TITLE_SIZES[box.group.titleSize ?? "medium"];
              return <div key={box.group.id}>
                <div
                  data-testid={`report-group-${box.group.id}`}
                  className={`absolute rounded-xl border ${tone.container}`}
                  style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
                />
                <div
                  data-testid={`report-group-label-${box.group.id}`}
                  className={`absolute z-20 flex max-w-[calc(100%-24px)] items-baseline gap-2 rounded-full border px-3 py-1.5 shadow-sm ${tone.label}`}
                  style={{ left: box.left + 12, top: box.top, transform: "translateY(-50%)" }}
                >
                  <span className={`truncate font-semibold leading-tight ${titleSize}`}>{interpolateReportText(box.group.title, draft, appliedValues)}</span>
                  {box.group.description && <span className="hidden truncate text-xs font-normal opacity-70 sm:inline">{interpolateReportText(box.group.description, draft, appliedValues)}</span>}
                </div>
              </div>;
            })}
          </div>
          <ResponsiveGridLayout className="relative z-10" width={width} breakpoints={{ lg: 768, sm: 0 }} cols={{ lg: 12, sm: 1 }} layouts={layouts} rowHeight={REPORT_GRID_ROW_HEIGHT} margin={[REPORT_GRID_MARGIN, REPORT_GRID_MARGIN]} compactor={(draft.groups?.length ?? 0) > 0 ? noCompactor : undefined} dragConfig={{ handle: ".report-drag-handle" }} resizeConfig={{ enabled: true }} onLayoutChange={(layout) => { if (width >= 768) updateLayout(layout); }}>
          {draft.blocks.map((block) => {
            const result = block.type === "markdown" ? null : results[block.datasetId];
            const dataset = block.type === "markdown" ? null : draft.datasets.find((candidate) => candidate.id === block.datasetId);
            const displayBlockTitle = block.title ? interpolateReportText(block.title, draft, appliedValues) : undefined;
            const markdownTitle = block.type === "markdown" ? visibleMarkdownTitle(displayBlockTitle) : null;
            const showBlockHeader = block.type !== "markdown" || markdownTitle !== null;
            const pending = isDatasetPending(result ?? undefined);
            const narrativeState = block.type === "ai_narrative" ? narrativeStates[block.id] : undefined;
            const narrativePending = narrativeState?.status === "running";
            const hasData = Boolean(result?.table);
            const datasetStatusLabel = narrativePending
              ? (block.type === "ai_narrative" && block.snapshot ? "Updating narrative" : "Generating narrative")
              : narrativeState?.status === "error"
                ? "Narrative failed"
                : result?.status === "queued"
              ? (hasData ? "Refresh queued" : "Queued")
              : result?.status === "running"
                ? (hasData ? "Refreshing" : "Loading")
                : result?.status === "error" && (hasData || (block.type === "ai_narrative" && Boolean(block.snapshot)))
                  ? "Refresh failed"
                  : null;
            const visualBlock = block.type === "chart"
              ? block
              : isReportTufteBlock(block)
                ? { id: block.id, title: block.title, spec: tufteBlockToVegaSpec(block) }
                : null;
            const resolvedAppearance = resolveReportAppearance(block.appearance, result?.rows ?? []);
            const appearanceStyle = REPORT_BLOCK_APPEARANCE[resolvedAppearance.tone];
            const gridStyle = {
              "--report-grid-column": block.layout.x + 1,
              "--report-grid-row": block.layout.y + 1,
              "--report-grid-width": block.layout.w,
              "--report-grid-height": block.layout.h,
            } as CSSProperties;
            const reportGroup = block.groupId ? (draft.groups ?? []).find((group) => group.id === block.groupId) : undefined;
            return <div key={block.id} style={gridStyle} data-testid={`report-block-${block.id}`} data-report-group={block.groupId} data-report-tone={resolvedAppearance.tone} data-report-emphasis={resolvedAppearance.emphasis} aria-busy={pending || narrativePending} className={`group relative rounded-lg border shadow-sm overflow-hidden flex flex-col print:shadow-none ${appearanceStyle[resolvedAppearance.emphasis]}`}>
              {reportGroup && <div className="print-only hidden border-b px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{interpolateReportText(reportGroup.title, draft, appliedValues)}</div>}
              {showBlockHeader && <div data-testid={`report-block-header-${block.id}`} className="report-drag-handle cursor-move px-3 py-2 border-b flex items-center gap-2 text-sm font-medium">
                <span className="truncate">{block.type === "markdown" ? markdownTitle : displayBlockTitle || reportBlockLabel(block.type)}</span>
                {resolvedAppearance.label && <span data-testid={`report-block-status-${block.id}`} title={resolvedAppearance.label} className="inline-flex min-w-0 max-w-[45%] items-center gap-1.5 rounded-full border border-current/15 bg-background/55 px-2 py-0.5 text-[10px] font-medium"><span className={`h-1.5 w-1.5 shrink-0 rounded-full ${appearanceStyle.dot}`} /><span className="truncate">{resolvedAppearance.label}</span></span>}
                <div className="flex-1" />
                <div className="report-authoring-control flex items-center gap-2" onMouseDown={(event) => event.stopPropagation()}>
                  {datasetStatusLabel && <span
                    data-testid={`report-dataset-status-${block.id}`}
                    className={`inline-flex items-center gap-1 text-[10px] font-normal ${result?.status === "error" ? "text-destructive" : "text-muted-foreground"}`}
                    title={narrativeState?.status === "error" ? narrativeState.error : result?.status === "error" ? result.error : undefined}
                  >
                    {(pending || narrativePending) && <Loader2 className={`h-3 w-3 ${result?.status === "running" || narrativePending ? "animate-spin" : "opacity-50"}`} />}
                    {datasetStatusLabel}
                  </span>}
                  {block.type !== "markdown" && <div data-testid={`report-block-actions-${block.id}`} className="report-block-actions flex items-center gap-2">
                    <button
                      type="button"
                      className="text-[10px] font-medium text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                      disabled={!result?.table}
                      data-testid={`report-download-csv-${block.id}`}
                      onClick={() => result?.table && void exportResult(result.table, "csv", block.title || dataset?.name || "report-data")}
                    >CSV</button>
                    {block.type === "table" && <button
                      type="button"
                      className="text-[10px] font-medium text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                      disabled={!result?.table}
                      onClick={() => result?.table && void exportResult(result.table, "excel", block.title || dataset?.name || "report-table")}
                    >XLSX</button>}
                    <button
                      type="button"
                      className="text-[10px] font-medium text-muted-foreground hover:text-foreground"
                      data-testid={`report-open-sql-${block.id}`}
                      onClick={() => dataset && openDatasetInEditor(dataset)}
                    >SQL</button>
                    {visualBlock && <>
                      <button
                        type="button"
                        className="text-[10px] font-medium text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                        data-testid={`report-download-png-${block.id}`}
                        disabled={!hasData}
                        onClick={() => { const view = reportChartViews.current.get(block.id); if (view) void downloadPNG(view, displayBlockTitle || "chart"); }}
                      >PNG</button>
                      <button
                        type="button"
                        className="text-[10px] font-medium text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                        data-testid={`report-download-svg-${block.id}`}
                        disabled={!hasData}
                        onClick={() => { const view = reportChartViews.current.get(block.id); if (view) void downloadSVG(view, displayBlockTitle || "chart"); }}
                      >SVG</button>
                    </>}
                    {block.type === "ai_narrative" && <button
                      type="button"
                      className="text-[10px] font-medium text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                      data-testid={`report-regenerate-narrative-${block.id}`}
                      disabled={!hasData || narrativePending}
                      onClick={() => void regenerateNarrative(block)}
                    >{block.snapshot ? "Regenerate" : "Generate"}</button>}
                  </div>}
                </div>
              </div>}
              {!showBlockHeader && resolvedAppearance.label && <div data-testid={`report-block-status-${block.id}`} title={resolvedAppearance.label} className="absolute right-2 top-2 z-10 inline-flex max-w-[60%] items-center gap-1.5 rounded-full border border-current/15 bg-background/75 px-2 py-0.5 text-[10px] font-medium"><span className={`h-1.5 w-1.5 shrink-0 rounded-full ${appearanceStyle.dot}`} /><span className="truncate">{resolvedAppearance.label}</span></div>}
              {!showBlockHeader && <div data-testid={`report-block-drag-${block.id}`} title="Drag text block" className="report-authoring-control report-drag-handle absolute right-1 top-1 z-10 cursor-move rounded p-1 text-muted-foreground/50 opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"><GripVertical className="h-3.5 w-3.5" /></div>}
              <div className={`relative flex-1 min-h-0 ${block.type === "sparkline" ? "p-2" : !showBlockHeader && block.type === "markdown" ? "p-3 pr-8" : "p-3"} ${visualBlock || block.type === "sparkline" || block.type === "perspective" || block.type === "map" ? "overflow-hidden" : "overflow-auto"}`}>{block.type === "markdown" ? <ChatMarkdown content={block.markdown} /> : block.type === "ai_narrative" && block.snapshot ? <ReportAiNarrative block={block} state={narrativeState} onGenerate={() => void regenerateNarrative(block)} /> : result?.error && !result.table ? <div className="h-full flex flex-col items-center justify-center gap-3 text-center"><div className="text-xs text-destructive">{result.error}</div><Button size="sm" variant="outline" onClick={runFullReport}><Play className="h-3.5 w-3.5" /> Run report again</Button></div> : !result?.table && pending ? <div data-testid={`report-dataset-loading-${block.id}`} className="h-full flex flex-col items-center justify-center gap-2 text-center"><Loader2 className={`h-5 w-5 text-primary ${result?.status === "running" ? "animate-spin" : "opacity-50"}`} /><p className="text-xs text-muted-foreground">{result?.status === "queued" ? "Waiting to load data…" : "Loading data…"}</p></div> : !result?.table ? <div className="h-full flex flex-col items-center justify-center gap-3 text-center"><p className="text-xs text-muted-foreground">This report has not loaded its data yet.</p><Button size="sm" onClick={runFullReport}><Play className="h-4 w-4" /> Run report</Button></div> : block.type === "ai_narrative" ? <ReportAiNarrative block={block} state={narrativeState} onGenerate={() => void regenerateNarrative(block)} /> : block.type === "table" ? (() => { const columns = block.columns ?? result.table.schema.fields.map((field: any) => field.name); const pageSize = block.pageSize ?? 50; return <QueryResultTable columns={columns} rows={reportDisplayRows(result.table, columns, pageSize)} rowCount={result.rows.length} showing={Math.min(result.rows.length, pageSize)} />; })() : block.type === "kpi" ? <div className="h-full flex flex-col justify-center items-center"><div className="text-3xl font-semibold">{formatKpi(result.rows[0]?.[block.valueColumn], block.format)}</div><div className="text-xs text-muted-foreground">{block.labelColumn ? String(result.rows[0]?.[block.labelColumn] ?? "") : block.title}</div></div> : block.type === "sparkline" ? <ReportSparkline block={block} rows={result.rows} formatValue={formatKpi} /> : visualBlock ? <ReportChart block={visualBlock} rows={result.rows} onViewChange={setReportChartView} /> : block.type === "map" ? <ReportMap block={block} rows={reportMapRows(result.table, block.geometryColumn)} /> : block.type === "perspective" ? <ReportPerspective table={result.table} config={block.config} onConfig={(config) => setDraft((current) => current ? { ...current, blocks: current.blocks.map((b) => b.id === block.id && b.type === "perspective" ? { ...b, config } : b) } : current)} /> : null}</div>
              {(block.caption || block.source) && <div data-testid={`report-note-${block.id}`} className="px-3 pb-2 text-[10px] leading-snug text-muted-foreground">
                {block.caption && <span>{block.caption}</span>}{block.caption && block.source && <span> · </span>}{block.source && <span>Source: {block.source}</span>}
              </div>}
            </div>;
          })}
          </ResponsiveGridLayout>
        </div>}
      </div>
      {(agentOpen || inspectorOpen) && <aside className="report-authoring-control w-[min(42vw,520px)] min-w-[340px] border-l bg-card flex flex-col min-h-0">
        <div className="flex items-center border-b"><button className={`px-4 py-2 text-sm ${agentOpen ? "border-b-2 border-primary" : ""}`} onClick={() => { setAgentOpen(true); setInspectorOpen(false); }}>Agent</button><button className={`px-4 py-2 text-sm ${inspectorOpen ? "border-b-2 border-primary" : ""}`} onClick={() => { setInspectorOpen(true); setAgentOpen(false); setSourceText(exportReportJson(draft)); }}>Source</button><div className="flex-1" />{agentOpen && agentConversation.length > 0 && <Button size="sm" variant="ghost" disabled={agentBusy} onClick={resetAgentConversation}>New conversation</Button>}<button className="p-2" onClick={() => { setAgentOpen(false); setInspectorOpen(false); }}><X className="h-4 w-4" /></button></div>
        {agentOpen ? <><div ref={agentThreadRef} data-testid="report-agent-thread" className="flex-1 overflow-y-auto p-4 text-sm"><p className="text-muted-foreground mb-4">Describe the report or revision. The agent edits a draft; nothing is saved until you accept it.</p><div className="space-y-5">{agentConversation.map((message) => <div key={message.id} data-role={message.role}>{message.role === "user" ? <ChatMessageUser content={message.content ?? ""} /> : <ChatMessageAssistant blocks={message.blocks ?? []} isStreaming={message.isStreaming} usage={message.usage} model={settings.aiModel} onCancel={message.isStreaming ? () => abortRef.current?.abort() : undefined} />}</div>)}</div></div><div className="p-3 border-t"><textarea className="w-full min-h-24 rounded-md border bg-background p-2 text-sm" value={agentPrompt} onChange={(e) => setAgentPrompt(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void runAgent(); } }} placeholder="Build a monthly sales report with a date range and region filter…" /><div className="flex justify-end mt-2">{agentBusy ? <Button variant="destructive" size="sm" onClick={() => abortRef.current?.abort()}>Stop</Button> : <Button size="sm" disabled={!agentPrompt.trim()} onClick={runAgent}><Sparkles className="h-4 w-4" /> Send</Button>}</div></div></> : <><textarea className="flex-1 min-h-0 resize-none bg-background p-3 font-mono text-xs" spellCheck={false} value={sourceText} onChange={(e) => setSourceText(e.target.value)} />{sourceError && <div className="px-3 py-2 text-xs text-destructive border-t">{sourceError}</div>}<div className="p-3 border-t flex justify-end"><Button size="sm" onClick={() => { try { const parsed = importReportJson(sourceText); setDraft(parsed); setSourceError(null); } catch (e) { setSourceError(e instanceof Error ? e.message : String(e)); } }}>Preview source</Button></div></>}
      </aside>}
    </div>
    {promotionDialog}
  </div>;
}
