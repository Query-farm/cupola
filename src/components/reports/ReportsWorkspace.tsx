import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Popover as BaseUIPopover } from "@base-ui/react/popover";
import { ResponsiveGridLayout, useContainerWidth, type Layout, type ResponsiveLayouts } from "react-grid-layout";
import { noCompactor } from "react-grid-layout/core";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import { ArrowLeft, BarChart3, BookOpen, Bot, Check, ChevronDown, ChevronUp, Clock3, Database, Download, FileCode2, FileJson, FilePlus2, GripVertical, History, Link2, Loader2, MoreHorizontal, Pencil, Play, Plus, Printer, RefreshCw, Save, Send, Share2, SlidersHorizontal, Sparkles, Trash2, X } from "lucide-react";
import type { Table as ArrowTable } from "@query-farm/apache-arrow";
import type { CatalogData } from "@/lib/service";
import { engine, getEngineLifecycleSnapshot, ui, waitForEngineReady } from "@/lib/shell-bridge";
import { useEngineLifecycle } from "@/lib/use-engine-lifecycle";
import { decodeArrowBuffer, tableToRows } from "@/lib/duckdb-query";
import { ChatMarkdown } from "@/components/chat/ChatMarkdown";
import { ChatMessageAssistant, type ContentBlock, type ToolCallEntry } from "@/components/chat/ChatMessageAssistant";
import { ChatMessageUser } from "@/components/chat/ChatMessageUser";
import { QueryResultTable } from "@/components/chat/QueryResultTable";
import { ReportMap } from "@/components/reports/ReportMap";
import { ReportSparkline } from "@/components/reports/ReportSparkline";
import { ReportKpi } from "@/components/reports/ReportKpi";
import { ReportDatasetsView } from "@/components/reports/ReportDatasetsView";
import { ReportBlockEditor } from "@/components/reports/ReportBlockEditor";
import { compileChartSpec, embedChart, downloadPNG, downloadSVG, renderChartToPng, type VegaView } from "@/components/chat/chart-embed";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useSettings } from "@/lib/settings";
import { runAgentTurn, executeListTables, executeDescribeTable, type MessageParam, type SystemPrompt, type ToolResult, type ToolResultContent } from "@/lib/ai-agent";
import { executeRunSql, validateChartSpec } from "@/lib/ai-tool-executor";
import { QueryResultCache } from "@/lib/query-results";
import { DEFAULT_AI_MAX_TOKENS } from "@/lib/ai/model-limits";
import { toolInputLabel } from "@/lib/ai/tool-labels";
import { exportResult, safeFileStem, triggerDownload } from "@/lib/editor/result-export";
import { consumeReportPromotion, type ReportPromotion } from "@/lib/reports/events";
import { reportDisplayRows, reportMapRows } from "@/lib/reports/display";
import { buildReportDatasetExecutionPlan, inferReportDatasetDependencies, quoteReportDatasetIdentifier, type ReportDatasetExecutionPlan } from "@/lib/reports/dependencies";
import { buildReportRunFailureNotice, classifyReportQueryError, isBlockingVegaWarning, validateReportResultColumns, type ReportQueryErrorCode, type ReportRunFailureNotice } from "@/lib/reports/execution";
import { resolveReportAppearance } from "@/lib/reports/appearance";
import { REPORT_TOOLS, upsertAgentBlock, upsertAgentDataset, upsertAgentGroup, type SemanticBlockHeight, type SemanticBlockWidth } from "@/lib/reports/agent-tools";
import { checkpointReportAgentPlan, parseReportAgentPlan, reportAgentRepair, validateReportAgentPlan, type ReportAgentPlan } from "@/lib/reports/agent-reliability";
import { compileReportQuery, interpolateReportText, materializeReportQuery } from "@/lib/reports/parameters";
import { generateReportNarrative, prepareNarrativeInput } from "@/lib/reports/narrative";
import { isReportTufteBlock, tufteBlockToVegaSpec } from "@/lib/reports/tufte";
import { buildShareReportUrl, clearSharedReport, consumeSharedReport } from "@/lib/reports/share";
import { deleteReport, exportReportJson, getStoredReport, importReportJson, listStoredReports, publishReport, restoreReportRevision, saveReport } from "@/lib/reports/store";
import { cloneReport, createEmptyReport, newReportId, type ReportAiNarrativeBlock, type ReportBlock, type ReportDataset, type ReportDocumentV1, type ReportGroup, type ReportOption, type ReportParameter, type ReportParameterValue } from "@/lib/reports/types";
import { parameterTokens, validateReadOnlySql, validateReport, validateReportParameterValues, type ReportParameterIssue } from "@/lib/reports/validation";
import { createReportBlock, duplicateReportBlock, REPORT_BLOCK_TYPES } from "@/lib/reports/direct-editor";
import type { AgentUsage } from "@/lib/ai-usage";

interface Props {
  catalogData: CatalogData;
  serviceUrl: string;
  attachedCatalogNames?: string[];
  onBusyChange?: (busy: boolean) => void;
  initialReport?: ReportDocumentV1;
}

interface DatasetResult {
  table: ArrowTable | null;
  rows: Record<string, any>[];
  status: "idle" | "queued" | "running" | "success" | "error" | "blocked";
  error?: string;
  errorDetails?: string;
  errorCode?: ReportQueryErrorCode;
  retryable?: boolean;
  retryAfterSeconds?: number;
  fetchedAt?: number;
  durationMs?: number;
  dependencies?: string[];
  materialized?: boolean;
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
  errorDetails?: string;
  errorCode?: ReportQueryErrorCode;
  retryable?: boolean;
  retryAfterSeconds?: number;
  stale?: boolean;
}

interface ReportAgentMessage {
  id: string;
  role: "user" | "assistant";
  content?: string;
  blocks?: ContentBlock[];
  isStreaming?: boolean;
  usage?: AgentUsage;
}

interface BlockEditorState {
  block: ReportBlock;
  isNew: boolean;
  initialJson: string;
}

interface DatasetTestCache {
  reportId: string;
  datasetJson: string;
  results: Map<string, DatasetResult>;
}

function defaultValues(report: ReportDocumentV1): Record<string, ReportParameterValue> {
  return Object.fromEntries(report.parameters.map((p) => [p.key, structuredClone(p.defaultValue)]));
}

function parameterOptionsFromRows(parameter: ReportParameter, rowsByDataset: Map<string, Record<string, any>[]>): ReportOption[] | undefined {
  const options = parameter.options;
  if (!options) return undefined;
  if (options.kind === "static") return options.values;
  const rows = rowsByDataset.get(options.datasetId);
  if (!rows) return undefined;
  return rows.map((row) => ({
    value: row[options.valueColumn] as string | number,
    label: String(row[options.labelColumn || options.valueColumn] ?? ""),
  }));
}

function validationDatasetIssues(
  report: ReportDocumentV1,
  rowsByDataset: Map<string, Record<string, any>[]>,
  summaries: DatasetRunSummary[],
): ReportParameterIssue[] {
  const summaryById = new Map(summaries.map((summary) => [summary.datasetId, summary]));
  return report.parameters.flatMap((parameter): ReportParameterIssue[] => {
    const validator = parameter.validationDataset;
    if (!validator) return [];
    const summary = summaryById.get(validator.datasetId);
    if (summary && !summary.ok) return [{ parameterKey: parameter.key, code: "validation_unavailable", message: `${parameter.label} could not be validated: ${summary.error ?? "validation query failed"}` }];
    const row = rowsByDataset.get(validator.datasetId)?.[0];
    if (!row) return [{ parameterKey: parameter.key, code: "validation_unavailable", message: `${parameter.label} could not be validated because its validation query returned no rows.` }];
    const valid = row[validator.validColumn];
    if (valid === true || valid === 1 || String(valid).toLowerCase() === "true") return [];
    const detail = validator.messageColumn ? row[validator.messageColumn] : undefined;
    return [{ parameterKey: parameter.key, code: "business_rule", message: detail == null || detail === "" ? `${parameter.label} is not valid for the attached data.` : String(detail) }];
  });
}

function parameterRibbonValue(parameter: ReportParameter, value: ReportParameterValue, options: ReportOption[]): string {
  if (value == null || value === "" || (Array.isArray(value) && value.length === 0)) return "Not set";
  if (parameter.type === "date_range" && typeof value === "object" && !Array.isArray(value)) {
    return [value.start, value.end].filter(Boolean).join(" – ") || "Not set";
  }
  if (parameter.type === "boolean") return value ? "Yes" : "No";
  const labels = new Map(options.map((option) => [String(option.value), option.label]));
  if (Array.isArray(value)) return value.map((item) => labels.get(String(item)) ?? String(item)).join(", ");
  return labels.get(String(value)) ?? String(value);
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

function ParameterInput({ parameter, value, options, errors, onChange }: { parameter: ReportParameter; value: ReportParameterValue; options: ReportOption[]; errors: string[]; onChange: (value: ReportParameterValue) => void }) {
  const errorId = `report-parameter-${parameter.id}-error`;
  const invalid = errors.length > 0;
  const feedback = invalid ? <div id={errorId} role="alert" className="max-w-64 text-[11px] text-destructive">{errors.join(" ")}</div> : parameter.description ? <div className="max-w-64 text-[11px] text-muted-foreground">{parameter.description}</div> : null;
  const accessibility = { "aria-invalid": invalid || undefined, "aria-describedby": invalid ? errorId : undefined };
  if (parameter.type === "boolean") return <div className="space-y-1"><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={Boolean(value)} required={parameter.required} {...accessibility} onChange={(e) => onChange(e.target.checked)} />{parameter.label}</label>{feedback}</div>;
  if (parameter.type === "select") return <div className="space-y-1"><Label className="text-xs">{parameter.label}</Label><Select value={value == null ? "" : String(value)} onValueChange={(selected) => onChange(options.find((option) => String(option.value) === selected)?.value ?? selected)}><SelectTrigger className="h-8 min-w-40" {...accessibility}><SelectValue placeholder="Select…" /></SelectTrigger><SelectContent>{options.map((o) => <SelectItem key={String(o.value)} value={String(o.value)}>{o.label}</SelectItem>)}</SelectContent></Select>{feedback}</div>;
  if (parameter.type === "multi_select") return <div className="space-y-1"><Label className="text-xs">{parameter.label}</Label><div className={`flex flex-wrap gap-2 border rounded-md px-2 py-1.5 min-h-8 ${invalid ? "border-destructive" : ""}`} {...accessibility}>{options.map((o) => <label key={String(o.value)} className="text-xs flex gap-1"><input type="checkbox" checked={Array.isArray(value) && value.map(String).includes(String(o.value))} onChange={(e) => { const current = Array.isArray(value) ? value.map(String) : []; onChange(e.target.checked ? [...current, String(o.value)] : current.filter((v) => v !== String(o.value))); }} />{o.label}</label>)}</div>{feedback}</div>;
  if (parameter.type === "date_range") {
    const range = value && typeof value === "object" && !Array.isArray(value) ? value as { start: string | null; end: string | null } : { start: null, end: null };
    const min = typeof parameter.validation?.min === "string" ? parameter.validation.min : undefined;
    const max = typeof parameter.validation?.max === "string" ? parameter.validation.max : undefined;
    return <div className="space-y-1"><Label className="text-xs">{parameter.label}</Label><div className="flex gap-1"><Input className="h-8" type="date" value={range.start ?? ""} min={min} max={max} required={parameter.required || parameter.validation?.requireBoth} {...accessibility} onChange={(e) => onChange({ ...range, start: e.target.value || null })} /><Input className="h-8" type="date" value={range.end ?? ""} min={min} max={max} required={parameter.required || parameter.validation?.requireBoth} {...accessibility} onChange={(e) => onChange({ ...range, end: e.target.value || null })} /></div>{feedback}</div>;
  }
  const validation = parameter.validation;
  return <div className="space-y-1"><Label className="text-xs">{parameter.label}</Label><Input className="h-8 min-w-36" type={parameter.type === "number" ? "number" : parameter.type === "date" ? "date" : "text"} value={value == null ? "" : String(value)} required={parameter.required} min={validation?.min} max={validation?.max} step={parameter.type === "number" ? (validation?.step ?? (validation?.integer ? 1 : "any")) : undefined} minLength={validation?.minLength} maxLength={validation?.maxLength} pattern={validation?.pattern} {...accessibility} onChange={(e) => onChange(parameter.type === "number" ? (e.target.value === "" ? null : Number(e.target.value)) : e.target.value)} />{feedback}</div>;
}

const reportMenuItemClass = "flex w-full items-center gap-2 rounded px-2 py-2 text-left text-xs transition-colors hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const refreshChoices = [
  { value: 0, label: "Off" },
  { value: 30, label: "Every 30 seconds" },
  { value: 60, label: "Every minute" },
  { value: 300, label: "Every 5 minutes" },
  { value: 900, label: "Every 15 minutes" },
];

function ReportRunControl({ reader, running, disabled, label, interval, onRun, onIntervalChange }: {
  reader: boolean;
  running: boolean;
  disabled: boolean;
  label: string;
  interval?: number;
  onRun: () => void;
  onIntervalChange: (seconds?: number) => void;
}) {
  const choices = interval && !refreshChoices.some((choice) => choice.value === interval)
    ? [refreshChoices[0], { value: interval, label: `Every ${interval} seconds` }, ...refreshChoices.slice(1)]
    : refreshChoices;
  return <div className="inline-flex shrink-0" data-testid="report-run-control">
    <Button size="sm" variant="outline" className="rounded-r-none" data-testid="reports-run" aria-label={label} title={label} disabled={disabled} onClick={onRun}>
      {running ? <Loader2 className="h-4 w-4 animate-spin" /> : reader ? <RefreshCw className="h-4 w-4" /> : <Play className="h-4 w-4" />} <span className="hidden sm:inline">{label}</span>
    </Button>
    <Popover>
      <PopoverTrigger
        aria-label="Report refresh options"
        title="Automatic refresh settings"
        disabled={running}
        className={buttonVariants({ variant: "outline", size: "icon-sm", className: "rounded-l-none border-l-0" })}
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </PopoverTrigger>
      <PopoverContent className="min-w-[220px] p-1" aria-label="Automatic refresh">
        <div className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Automatic refresh</div>
        {choices.map((choice) => <BaseUIPopover.Close
          key={choice.value}
          role="menuitemradio"
          aria-checked={(interval ?? 0) === choice.value}
          data-testid={`report-auto-refresh-${choice.value}`}
          className={reportMenuItemClass}
          onClick={() => onIntervalChange(choice.value || undefined)}
        >
          <span className="flex h-4 w-4 items-center justify-center">{(interval ?? 0) === choice.value && <Check className="h-3.5 w-3.5" />}</span>
          <span>{choice.label}</span>
        </BaseUIPopover.Close>)}
      </PopoverContent>
    </Popover>
  </div>;
}

function ReportMoreMenu({ reader, revisions, onRestoreRevision, onShareDraft, onPrint, onEditSource, onDownload }: {
  reader: boolean;
  revisions: ReportDocumentV1[];
  onRestoreRevision?: (revision: number) => void | Promise<void>;
  onShareDraft?: () => void | Promise<void>;
  onPrint: () => void;
  onEditSource?: () => void;
  onDownload: () => void;
}) {
  return <Popover>
    <PopoverTrigger
      className={buttonVariants({ variant: "outline", size: "sm" })}
      aria-label="More report actions"
      data-testid="report-more-menu"
    >
      <MoreHorizontal className="h-4 w-4" /><span className="hidden sm:inline">More</span>
    </PopoverTrigger>
    <PopoverContent className="max-h-[min(70vh,520px)] min-w-[250px] overflow-y-auto p-1" aria-label="More report actions">
      {!reader && revisions.length > 0 && <div className="border-b pb-1">
        <div className="flex items-center gap-2 px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"><History className="h-3.5 w-3.5" /> Revision history</div>
        {revisions.slice().reverse().map((revision) => <BaseUIPopover.Close key={revision.revision} className={reportMenuItemClass} onClick={() => onRestoreRevision?.(revision.revision)}>
          <span className="w-4" />
          <span className="flex-1">Restore revision {revision.revision}</span>
          <span className="text-[10px] text-muted-foreground">{new Date(revision.updatedAt).toLocaleDateString()}</span>
        </BaseUIPopover.Close>)}
      </div>}
      {!reader && onShareDraft && <BaseUIPopover.Close className={reportMenuItemClass} onClick={onShareDraft} data-testid="report-copy-draft-link"><Link2 className="h-4 w-4" /><span>Copy draft review link</span></BaseUIPopover.Close>}
      <BaseUIPopover.Close className={reportMenuItemClass} onClick={onPrint}><Printer className="h-4 w-4" /><span>Print / Save as PDF</span></BaseUIPopover.Close>
      <BaseUIPopover.Close className={reportMenuItemClass} onClick={onDownload}><Download className="h-4 w-4" /><span>Download report definition</span><span className="ml-auto text-[10px] text-muted-foreground">.json</span></BaseUIPopover.Close>
      {!reader && onEditSource && <div className="mt-1 border-t pt-1">
        <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Advanced</div>
        <BaseUIPopover.Close className={reportMenuItemClass} onClick={onEditSource} data-testid="report-edit-json"><FileCode2 className="h-4 w-4" /><span>Edit report JSON</span></BaseUIPopover.Close>
      </div>}
    </PopoverContent>
  </Popover>;
}

function freshnessLabel(timestamp: number): string {
  if (!timestamp) return "";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1_000));
  if (seconds < 60) return "Updated just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Updated ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Updated ${hours} hr ago`;
  return `Updated ${Math.round(hours / 24)} d ago`;
}

export function ReportsWorkspace({ catalogData, serviceUrl, attachedCatalogNames = [], onBusyChange, initialReport }: Props) {
  const { settings } = useSettings();
  const [reports, setReports] = useState<ReportDocumentV1[]>([]);
  const [publishedReports, setPublishedReports] = useState<Record<string, ReportDocumentV1>>({});
  const [publishedTimes, setPublishedTimes] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<ReportDocumentV1 | null>(null);
  const [draft, setDraft] = useState<ReportDocumentV1 | null>(null);
  const [published, setPublished] = useState<ReportDocumentV1 | null>(null);
  const [publishedAt, setPublishedAt] = useState<number | null>(null);
  const [readerMode, setReaderMode] = useState(false);
  const [results, setResults] = useState<Record<string, DatasetResult>>({});
  const [runProgress, setRunProgress] = useState<ReportRunProgress | null>(null);
  const [engineWaiting, setEngineWaiting] = useState(false);
  const [values, setValues] = useState<Record<string, ReportParameterValue>>({});
  const [appliedValues, setAppliedValues] = useState<Record<string, ReportParameterValue>>({});
  const [parameterIssues, setParameterIssues] = useState<ReportParameterIssue[]>([]);
  const [parametersExpanded, setParametersExpanded] = useState(false);
  const [workspaceView, setWorkspaceView] = useState<"report" | "datasets">("report");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [sourceText, setSourceText] = useState("");
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [agentOpen, setAgentOpen] = useState(false);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [blockEditor, setBlockEditor] = useState<BlockEditorState | null>(null);
  const [blockEditorErrors, setBlockEditorErrors] = useState<string[]>([]);
  const [blockEditorApplying, setBlockEditorApplying] = useState(false);
  const [agentTargetBlockId, setAgentTargetBlockId] = useState<string | null>(null);
  const [datasetEditorRequest, setDatasetEditorRequest] = useState<string | null>(null);
  const [datasetEditorDirty, setDatasetEditorDirty] = useState(false);
  const [datasetEditorResetKey, setDatasetEditorResetKey] = useState(0);
  const [agentPrompt, setAgentPrompt] = useState("");
  const [agentConversation, setAgentConversation] = useState<ReportAgentMessage[]>([]);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentSummary, setAgentSummary] = useState<string | null>(null);
  const [narrativeStates, setNarrativeStates] = useState<Record<string, NarrativeGenerationState>>({});
  const [pendingPromotion, setPendingPromotion] = useState<ReportPromotion | null>(null);
  const [shareStatus, setShareStatus] = useState<string | null>(null);
  const [runFailureNotice, setRunFailureNotice] = useState<ReportRunFailureNotice | null>(null);
  const [revisionOptions, setRevisionOptions] = useState<ReportDocumentV1[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const narrativeAbortRef = useRef<AbortController | null>(null);
  const agentMessagesRef = useRef<MessageParam[]>([]);
  const agentThreadRef = useRef<HTMLDivElement>(null);
  const runGeneration = useRef(0);
  const initialReportOpened = useRef(false);
  const autoRefreshRunningRef = useRef(false);
  const rateLimitRetryTimerRef = useRef<number | null>(null);
  const rateLimitUntilRef = useRef(0);
  const engineWaitersRef = useRef(0);
  const validateAndRunRef = useRef<((report: ReportDocumentV1, values: Record<string, ReportParameterValue>, changedOnly: boolean, allowAutomaticRetry?: boolean) => Promise<boolean>) | null>(null);
  const autoRefreshStateRef = useRef<{
    report: ReportDocumentV1 | null;
    values: Record<string, ReportParameterValue>;
    busy: boolean;
  }>({ report: null, values: {}, busy: false });
  const resultCache = useRef(new QueryResultCache());
  const reportChartViews = useRef(new Map<string, VegaView>());
  const blockEditorRevisionRef = useRef(0);
  const blockApplyBusyRef = useRef(false);
  const datasetTestCacheRef = useRef<DatasetTestCache | null>(null);
  const setReportChartView = useCallback((blockId: string, view: VegaView | null) => {
    if (view) reportChartViews.current.set(blockId, view);
    else reportChartViews.current.delete(blockId);
  }, []);
  const { width, containerRef, mounted, measureWidth } = useContainerWidth({ initialWidth: 1000 });
  const engineLifecycle = useEngineLifecycle();
  const activeReport = readerMode && published ? published : draft;

  const clearScheduledRateLimitRetry = useCallback(() => {
    if (rateLimitRetryTimerRef.current !== null) window.clearTimeout(rateLimitRetryTimerRef.current);
    rateLimitRetryTimerRef.current = null;
    rateLimitUntilRef.current = 0;
  }, []);

  useEffect(() => () => clearScheduledRateLimitRetry(), [clearScheduledRateLimitRetry]);

  // The workspace first renders its library, so the hook's mount-time observer
  // has no report canvas to attach to. Start measuring when a report opens and
  // keep observing while the agent/source panel changes the available width.
  useEffect(() => {
    const node = containerRef.current;
    if (!draft || !node) return;
    measureWidth();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measureWidth());
    observer.observe(node);
    return () => observer.disconnect();
  }, [draft?.id, workspaceView, containerRef, measureWidth]);

  const reload = useCallback(async () => {
    const records = await listStoredReports();
    setReports(records.map((record) => record.document));
    setPublishedReports(Object.fromEntries(records.flatMap((record) => record.publishedDocument ? [[record.document.id, record.publishedDocument]] : [])));
    setPublishedTimes(Object.fromEntries(records.flatMap((record) => record.publishedAt ? [[record.document.id, record.publishedAt]] : [])));
  }, []);
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

  const openReport = useCallback((report: ReportDocumentV1, initialValues?: Record<string, ReportParameterValue>, autoRun = true, persisted = true, mode: "edit" | "reader" = "edit", publishedSnapshot?: ReportDocumentV1, publicationTime?: number) => {
    abortRef.current?.abort();
    abortRef.current = null;
    narrativeAbortRef.current?.abort();
    narrativeAbortRef.current = null;
    clearScheduledRateLimitRetry();
    const generation = ++runGeneration.current;
    agentMessagesRef.current = [];
    resultCache.current = new QueryResultCache();
    reportChartViews.current.clear();
    const copy = cloneReport(report);
    const publishedCopy = publishedSnapshot ? cloneReport(publishedSnapshot) : null;
    const viewed = mode === "reader" && publishedCopy ? publishedCopy : copy;
    const defaults = { ...defaultValues(viewed), ...initialValues };
    setSelected(persisted ? copy : null); setDraft(copy); setPublished(publishedCopy); setPublishedAt(publicationTime ?? null); setReaderMode(mode === "reader" && Boolean(publishedCopy)); setValues(defaults); setAppliedValues(defaults); setParameterIssues([]); setParametersExpanded(false); setWorkspaceView("report"); setResults({}); setNarrativeStates({}); setRunProgress(null); setRunFailureNotice(null); setSourceText(exportReportJson(copy)); setSourceError(null); setAgentSummary(null); setAgentConversation([]); setAgentPrompt(""); setAgentBusy(false); setSelectedBlockId(null); setBlockEditor(null); setBlockEditorErrors([]); setAgentTargetBlockId(null); setDatasetEditorRequest(null);
    void getStoredReport(copy.id).then((stored) => {
      setRevisionOptions(stored?.revisions ?? []);
      if (!publishedSnapshot && stored?.publishedDocument) {
        setPublished(cloneReport(stored.publishedDocument));
        setPublishedAt(stored.publishedAt ?? null);
      }
    });
    if (autoRun) setTimeout(() => {
      if (runGeneration.current !== generation) return;
      void validateAndRunRef.current?.(viewed, defaults, false);
    }, 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearScheduledRateLimitRetry]);

  useEffect(() => {
    if (!initialReport || initialReportOpened.current) return;
    initialReportOpened.current = true;
    openReport(initialReport, undefined, true, false);
    setShareStatus("Interactive examples use canned data queried locally in your browser; no VGI catalog is attached.");
  }, [initialReport, openReport]);

  useEffect(() => {
    if (initialReport) return;
    consumeSharedReport().then((shared) => { if (shared) { const reader = shared.mode === "reader"; openReport(shared.report, shared.values, reader, false, reader ? "reader" : "edit", reader ? shared.report : undefined); clearSharedReport(); setShareStatus(reader ? "Published report opened in reader mode." : "Shared report opened for review. Save and run it when ready."); } });
  }, [initialReport, openReport]);

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
    includeDependents = false,
    stagedResults?: Map<string, DatasetResult>,
  ): Promise<DatasetRunSummary[]> => {
    let datasets = report.datasets.filter((d) => !onlyIds || onlyIds.has(d.id));
    const valueErrors = validateReportParameterValues(report, runValues).map((issue) => issue.message);
    if (valueErrors.length) {
      const error = valueErrors.join(" ");
      setShareStatus(error);
      return datasets.map((dataset) => ({ datasetId: dataset.id, name: dataset.name, ok: false, error }));
    }
    if (datasets.length === 0) return [];
    const publishResults = !stagedResults;
    const generation = publishResults ? ++runGeneration.current : runGeneration.current;
    const summaries: DatasetRunSummary[] = [];
    let stagedState: Record<string, DatasetResult> = {};
    stagedResults?.clear();
    const updateDatasetResults = (updater: (previous: Record<string, DatasetResult>) => Record<string, DatasetResult>) => {
      if (publishResults) setResults(updater);
      else {
        stagedState = updater(stagedState);
        stagedResults!.clear();
        for (const [id, result] of Object.entries(stagedState)) stagedResults!.set(id, result);
      }
    };
    updateDatasetResults((prev) => {
      const next: Record<string, DatasetResult> = { ...prev };
      for (const [id, result] of Object.entries(next)) {
        if (isDatasetPending(result)) next[id] = { ...result, status: result.table ? "success" : "idle" };
      }
      for (const dataset of datasets) {
        next[dataset.id] = { ...(next[dataset.id] ?? { table: null, rows: [] }), status: "queued", error: undefined, errorDetails: undefined, errorCode: undefined, retryable: undefined, retryAfterSeconds: undefined };
      }
      return next;
    });
    const waitingForEngine = engine.lifecycleStatus === "idle" || engine.lifecycleStatus === "starting" || engine.lifecycleStatus === "attaching";
    if (waitingForEngine) {
      engineWaitersRef.current += 1;
      setEngineWaiting(true);
    }
    try {
      await waitForEngineReady();
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : "The data engine failed to start.";
      if (generation !== runGeneration.current) return summaries;
      updateDatasetResults((prev) => {
        const next = { ...prev };
        for (const dataset of datasets) next[dataset.id] = { ...(prev[dataset.id] ?? { table: null, rows: [] }), status: "error", error, errorDetails: error, errorCode: "service_unavailable", retryable: true };
        return next;
      });
      return datasets.map((dataset) => ({ datasetId: dataset.id, name: dataset.name, ok: false, error, errorDetails: error, errorCode: "service_unavailable", retryable: true, stale: captureRows?.has(dataset.id) ?? false }));
    } finally {
      if (waitingForEngine) {
        engineWaitersRef.current = Math.max(0, engineWaitersRef.current - 1);
        setEngineWaiting(engineWaitersRef.current > 0);
      }
    }
    if (generation !== runGeneration.current) return summaries;
    const queryPrepared = engine.queryPrepared;
    const query = engine.query;
    const getTableNames = engine.getTableNames;
    if (!queryPrepared || !query || !getTableNames) {
      const error = "The data engine reported ready before report query planning became available.";
      updateDatasetResults((prev) => {
        const next = { ...prev };
        for (const dataset of datasets) next[dataset.id] = { ...(prev[dataset.id] ?? { table: null, rows: [] }), status: "error", error, errorDetails: error, errorCode: "service_unavailable", retryable: true };
        return next;
      });
      return datasets.map((dataset) => ({ datasetId: dataset.id, name: dataset.name, ok: false, error, errorDetails: error, errorCode: "service_unavailable", retryable: true }));
    }
    let plan: ReportDatasetExecutionPlan;
    try {
      const dependencies = await inferReportDatasetDependencies(
        report.datasets,
        getTableNames,
        // DuckDB's table-name parser binds the statement and therefore rejects
        // unresolved prepared placeholders. Materialize already-validated
        // parameter values as escaped literals for planning only; execution of
        // ordinary datasets continues to use prepared statements below.
        (dataset) => materializeReportQuery(dataset.sql, report, runValues),
      );
      plan = buildReportDatasetExecutionPlan(report.datasets, dependencies, onlyIds, includeDependents);
      datasets = plan.datasets;
    } catch (cause) {
      const classified = classifyReportQueryError(cause);
      if (generation !== runGeneration.current) return summaries;
      updateDatasetResults((prev) => {
        const next = { ...prev };
        for (const dataset of datasets) next[dataset.id] = {
          ...(prev[dataset.id] ?? { table: null, rows: [] }),
          status: "error",
          error: "Cupola could not plan the report dataset dependencies.",
          errorDetails: classified.technicalDetails,
          errorCode: "query_failed",
          retryable: false,
        };
        return next;
      });
      return datasets.map((dataset) => ({ datasetId: dataset.id, name: dataset.name, ok: false, error: "Cupola could not plan the report dataset dependencies.", errorDetails: classified.technicalDetails, errorCode: "query_failed", retryable: false }));
    }
    if (generation !== runGeneration.current) return summaries;
    updateDatasetResults((prev) => {
      const next = { ...prev };
      for (const dataset of datasets) next[dataset.id] = {
        ...(prev[dataset.id] ?? { table: null, rows: [] }),
        status: "queued",
        error: undefined,
        errorDetails: undefined,
        errorCode: undefined,
        retryable: undefined,
        retryAfterSeconds: undefined,
        dependencies: [...(plan.dependencies.get(dataset.id) ?? [])],
        materialized: plan.materialized.has(dataset.id),
      };
      return next;
    });

    if (publishResults) setRunProgress({ generation, mode, total: datasets.length, completed: 0 });
    const failed = new Set<string>();
    const createdTempTables: string[] = [];
    try {
      for (let datasetIndex = 0; datasetIndex < datasets.length; datasetIndex++) {
        const dataset = datasets[datasetIndex];
        if (generation !== runGeneration.current) return summaries;
        const failedDependency = [...(plan.dependencies.get(dataset.id) ?? [])].find((id) => failed.has(id));
        if (failedDependency) {
          const dependencyName = report.datasets.find((candidate) => candidate.id === failedDependency)?.name ?? failedDependency;
          const blockedMessage = `Not refreshed because ${dependencyName} failed.`;
          failed.add(dataset.id);
          updateDatasetResults((prev) => ({ ...prev, [dataset.id]: {
            ...(prev[dataset.id] ?? { table: null, rows: [] }),
            status: "blocked",
            error: blockedMessage,
            errorDetails: `${dataset.name} depends on ${dependencyName}, so its query was not attempted.`,
            errorCode: "blocked",
            retryable: false,
            dependencies: [...(plan.dependencies.get(dataset.id) ?? [])],
            materialized: plan.materialized.has(dataset.id),
          } }));
          summaries.push({ datasetId: dataset.id, name: dataset.name, ok: false, error: blockedMessage, errorDetails: `${dataset.name} depends on ${dependencyName}, so its query was not attempted.`, errorCode: "blocked", retryable: false, stale: captureRows?.has(dataset.id) ?? false });
          if (publishResults) setRunProgress((progress) => progress?.generation === generation ? { ...progress, completed: progress.completed + 1, currentDatasetName: undefined } : progress);
          continue;
        }
        updateDatasetResults((prev) => ({
          ...prev,
          [dataset.id]: { ...(prev[dataset.id] ?? { table: null, rows: [] }), status: "running", error: undefined, errorDetails: undefined, errorCode: undefined, retryable: undefined, retryAfterSeconds: undefined, dependencies: [...(plan.dependencies.get(dataset.id) ?? [])], materialized: plan.materialized.has(dataset.id) },
        }));
        if (publishResults) setRunProgress((progress) => progress?.generation === generation
          ? { ...progress, currentDatasetName: dataset.name }
          : progress);
        const startedAt = performance.now();
        try {
          const readErrors = validateReadOnlySql(dataset.sql);
          if (readErrors.length) throw new Error(readErrors.join(" "));
          let response;
          if (plan.materialized.has(dataset.id)) {
            const identifier = quoteReportDatasetIdentifier(dataset.id);
            const create = await query(`CREATE TEMP TABLE ${identifier} AS ${materializeReportQuery(dataset.sql, report, runValues)}`);
            if (!create.ok) throw new Error(create.error || "The shared dataset could not be materialized.");
            createdTempTables.push(dataset.id);
            response = await queryPrepared(`SELECT * FROM temp.main.${identifier}`, []);
          } else {
            const compiled = compileReportQuery(dataset.sql, report, runValues);
            response = await queryPrepared(compiled.sql, compiled.params);
          }
          if (generation !== runGeneration.current) return summaries;
          if (!response.ok || !response.arrowBuffers?.[0]) throw new Error(response.error || "Query returned no result.");
          const table = decodeArrowBuffer(response.arrowBuffers[0]);
          const rows = tableToRows(table);
          captureRows?.set(dataset.id, rows);
          updateDatasetResults((prev) => ({ ...prev, [dataset.id]: { table, rows, status: "success", fetchedAt: Date.now(), durationMs: Math.round(performance.now() - startedAt), dependencies: [...(plan.dependencies.get(dataset.id) ?? [])], materialized: plan.materialized.has(dataset.id) } }));
          summaries.push({ datasetId: dataset.id, name: dataset.name, ok: true, rowCount: table.numRows, columns: table.schema.fields.map((field) => field.name), sample: rows.slice(0, 3) });
        } catch (e) {
          if (generation !== runGeneration.current) return summaries;
          failed.add(dataset.id);
          const classified = classifyReportQueryError(e);
          const stale = captureRows?.has(dataset.id) ?? false;
          updateDatasetResults((prev) => ({
            ...prev,
            [dataset.id]: {
              ...(prev[dataset.id] ?? { table: null, rows: [] }),
              status: "error",
              error: classified.message,
              errorDetails: classified.technicalDetails,
              errorCode: classified.code,
              retryable: classified.retryable,
              retryAfterSeconds: classified.retryAfterSeconds,
              durationMs: Math.round(performance.now() - startedAt),
              dependencies: [...(plan.dependencies.get(dataset.id) ?? [])],
              materialized: plan.materialized.has(dataset.id),
            },
          }));
          summaries.push({ datasetId: dataset.id, name: dataset.name, ok: false, error: classified.message, errorDetails: classified.technicalDetails, errorCode: classified.code, retryable: classified.retryable, retryAfterSeconds: classified.retryAfterSeconds, stale });
          if (classified.stopRun) {
            const remaining = datasets.slice(datasetIndex + 1);
            const blockedMessage = `Not refreshed because ${dataset.name} hit a data-service rate limit.`;
            updateDatasetResults((prev) => {
              const next = { ...prev };
              for (const blocked of remaining) {
                next[blocked.id] = {
                  ...(prev[blocked.id] ?? { table: null, rows: [] }),
                  status: "blocked",
                  error: blockedMessage,
                  errorDetails: `The refresh stopped before ${blocked.name} was requested, preventing more calls to the rate-limited service.`,
                  errorCode: "blocked",
                  retryable: true,
                  retryAfterSeconds: classified.retryAfterSeconds,
                  dependencies: [...(plan.dependencies.get(blocked.id) ?? [])],
                  materialized: plan.materialized.has(blocked.id),
                };
              }
              return next;
            });
            for (const blocked of remaining) {
              summaries.push({ datasetId: blocked.id, name: blocked.name, ok: false, error: blockedMessage, errorDetails: `Not attempted after ${dataset.name} returned a rate limit.`, errorCode: "blocked", retryable: true, retryAfterSeconds: classified.retryAfterSeconds, stale: captureRows?.has(blocked.id) ?? false });
            }
            if (publishResults) setRunProgress((progress) => progress?.generation === generation
              ? { ...progress, completed: datasets.length, currentDatasetName: undefined }
              : progress);
            break;
          }
        }
        if (publishResults) setRunProgress((progress) => progress?.generation === generation
          ? { ...progress, completed: progress.completed + 1, currentDatasetName: undefined }
          : progress);
      }
    } finally {
      for (const id of createdTempTables.reverse()) {
        try { await query(`DROP TABLE IF EXISTS temp.main.${quoteReportDatasetIdentifier(id)}`); } catch {}
      }
      if (publishResults) setRunProgress((progress) => progress?.generation === generation ? null : progress);
    }
    return summaries;
  }, []);

  const runDatasetsAndNarratives = useCallback(async (
    report: ReportDocumentV1,
    runValues: Record<string, ReportParameterValue>,
    onlyIds?: Set<string>,
    mode: "load" | "refresh" = "load",
    seedRows?: Map<string, Record<string, any>[]>,
    includeDependents = false,
  ): Promise<DatasetRunSummary[]> => {
    const rows = seedRows ?? new Map<string, Record<string, any>[]>();
    const summaries = await runDatasets(report, runValues, onlyIds, rows, mode, includeDependents);
    // A failed refresh may leave stale rows in the display cache. Keep those
    // rows visible, but never generate a new narrative from data we know did
    // not refresh successfully in this run.
    const narrativeRows = new Map(rows);
    for (const summary of summaries) if (!summary.ok) narrativeRows.delete(summary.datasetId);
    const generated = await generateNarratives(report, runValues, narrativeRows);
    if (generated !== report) {
      if (readerMode && published?.id === report.id) setPublished((current) => current?.id === report.id ? withNarrativeSnapshots(current, generated) : current);
      else setDraft((current) => current?.id === report.id ? withNarrativeSnapshots(current, generated) : current);
    }
    return summaries;
  }, [generateNarratives, published?.id, readerMode, runDatasets]);

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

  const validateAndRun = useCallback(async (report: ReportDocumentV1, candidateValues: Record<string, ReportParameterValue>, changedOnly: boolean, allowAutomaticRetry = true) => {
    const candidate = structuredClone(candidateValues);
    setRunFailureNotice(null);
    let issues = validateReportParameterValues(report, candidate);
    if (issues.length) {
      setParameterIssues(issues);
      setParametersExpanded(true);
      setShareStatus("Correct the highlighted parameters before running the report.");
      return false;
    }

    const rows = new Map(Object.entries(results).filter(([, result]) => Boolean(result.table)).map(([datasetId, result]) => [datasetId, result.rows]));
    const auxiliaryIds = new Set<string>();
    for (const parameter of report.parameters) {
      if (parameter.options?.kind === "dataset") auxiliaryIds.add(parameter.options.datasetId);
      if (parameter.validationDataset) auxiliaryIds.add(parameter.validationDataset.datasetId);
    }
    let auxiliarySummaries: DatasetRunSummary[] = [];
    if (auxiliaryIds.size) auxiliarySummaries = await runDatasets(report, candidate, auxiliaryIds, rows, "refresh");
    const auxiliaryFailures = auxiliarySummaries.filter((summary) => !summary.ok);
    if (getEngineLifecycleSnapshot().status === "error") return false;
    if (auxiliaryFailures.some((failure) => failure.retryable)) {
      const notice = buildReportRunFailureNotice(auxiliaryFailures, auxiliaryIds.size);
      setRunFailureNotice(notice);
      const rateLimit = auxiliaryFailures.find((failure) => failure.errorCode === "rate_limited");
      if (rateLimit && allowAutomaticRetry && rateLimitRetryTimerRef.current === null) {
        const delayMs = (rateLimit.retryAfterSeconds ?? 60) * 1_000 + Math.round(1_000 + Math.random() * 4_000);
        rateLimitUntilRef.current = Date.now() + delayMs;
        setRunFailureNotice({ ...notice, message: `${notice.message} Cupola will retry once automatically.` });
        rateLimitRetryTimerRef.current = window.setTimeout(() => {
          rateLimitRetryTimerRef.current = null;
          rateLimitUntilRef.current = 0;
          const current = autoRefreshStateRef.current;
          if (!current.report || current.report.id !== report.id || current.busy || document.visibilityState !== "visible") return;
          void validateAndRunRef.current?.(current.report, structuredClone(current.values), false, false);
        }, delayMs);
      }
      return false;
    }

    for (const parameter of report.parameters) {
      if (parameter.options?.kind !== "dataset") continue;
      const optionsDatasetId = parameter.options.datasetId;
      const failed = auxiliarySummaries.find((summary) => summary.datasetId === optionsDatasetId && !summary.ok);
      if (failed) issues.push({ parameterKey: parameter.key, code: "options_unavailable", message: `${parameter.label} choices could not be loaded: ${failed.error ?? "options query failed"}` });
    }
    const optionsByKey = Object.fromEntries(report.parameters.map((parameter) => [parameter.key, parameterOptionsFromRows(parameter, rows)]));
    issues.push(...validateReportParameterValues(report, candidate, optionsByKey));
    issues.push(...validationDatasetIssues(report, rows, auxiliarySummaries));
    issues = issues.filter((issue, index, all) => all.findIndex((candidateIssue) => candidateIssue.parameterKey === issue.parameterKey && candidateIssue.code === issue.code && candidateIssue.message === issue.message) === index);
    if (issues.length) {
      setParameterIssues(issues);
      setParametersExpanded(true);
      setShareStatus("The previous report remains active. Correct the highlighted parameters and apply again.");
      return false;
    }

    setParameterIssues([]);
    setAppliedValues(candidate);
    if (changedOnly) setParametersExpanded(false);
    const dataDatasets = report.datasets.filter((dataset) => dataset.role !== "parameter_options" && dataset.role !== "parameter_validation");
    const changed = new Set(Object.keys(candidate).filter((key) => JSON.stringify(candidate[key]) !== JSON.stringify(appliedValues[key])));
    const ids = changedOnly && changed.size
      ? new Set(dataDatasets.filter((dataset) => parameterTokens(dataset.sql).some((token) => changed.has(token) || changed.has(token.replace(/_(?:start|end)$/, "")))).map((dataset) => dataset.id))
      : new Set(dataDatasets.map((dataset) => dataset.id));
    const mode = dataDatasets.some((dataset) => ids.has(dataset.id) && Boolean(results[dataset.id]?.table)) ? "refresh" : "load";
    const execution = await runDatasetsAndNarratives(report, candidate, ids, mode, rows, true);
    const failures = execution.filter((summary) => !summary.ok);
    if (getEngineLifecycleSnapshot().status === "error") return false;
    if (failures.length) {
      const notice = buildReportRunFailureNotice(failures, execution.length);
      setRunFailureNotice(notice);
      const rateLimit = failures.find((failure) => failure.errorCode === "rate_limited");
      if (rateLimit && allowAutomaticRetry && rateLimitRetryTimerRef.current === null) {
        const delayMs = (rateLimit.retryAfterSeconds ?? 60) * 1_000 + Math.round(1_000 + Math.random() * 4_000);
        rateLimitUntilRef.current = Date.now() + delayMs;
        setRunFailureNotice({ ...notice, message: `${notice.message} Cupola will retry once automatically.` });
        rateLimitRetryTimerRef.current = window.setTimeout(() => {
          rateLimitRetryTimerRef.current = null;
          rateLimitUntilRef.current = 0;
          const current = autoRefreshStateRef.current;
          if (!current.report || current.report.id !== report.id || current.busy || document.visibilityState !== "visible") return;
          void validateAndRunRef.current?.(current.report, structuredClone(current.values), false, false);
        }, delayMs);
      }
      return false;
    }
    clearScheduledRateLimitRetry();
    setRunFailureNotice(null);
    if (!ids.size) setShareStatus("Parameters applied.");
    return true;
  }, [appliedValues, clearScheduledRateLimitRetry, results, runDatasets, runDatasetsAndNarratives]);
  validateAndRunRef.current = validateAndRun;

  const runFullReport = useCallback(() => {
    clearScheduledRateLimitRetry();
    if (activeReport) void validateAndRun(activeReport, values, false);
  }, [activeReport, clearScheduledRateLimitRetry, validateAndRun, values]);

  const handleApply = useCallback(() => {
    clearScheduledRateLimitRetry();
    if (activeReport) void validateAndRun(activeReport, values, true);
  }, [activeReport, clearScheduledRateLimitRetry, validateAndRun, values]);

  useEffect(() => {
    autoRefreshStateRef.current = {
      report: activeReport,
      values: appliedValues,
      busy: agentBusy || Object.values(results).some(isDatasetPending) || Object.values(narrativeStates).some((state) => state.status === "running"),
    };
  }, [activeReport, appliedValues, agentBusy, results, narrativeStates]);

  useEffect(() => {
    const seconds = activeReport?.refreshIntervalSeconds;
    if (!seconds) return;
    const interval = window.setInterval(() => {
      const current = autoRefreshStateRef.current;
      if (!current.report || current.busy || autoRefreshRunningRef.current || document.visibilityState !== "visible" || engine.lifecycleStatus !== "ready" || Date.now() < rateLimitUntilRef.current) return;
      autoRefreshRunningRef.current = true;
      const execution = validateAndRunRef.current?.(current.report, structuredClone(current.values), false) ?? Promise.resolve(false);
      void execution
        .finally(() => { autoRefreshRunningRef.current = false; });
    }, seconds * 1_000);
    return () => window.clearInterval(interval);
  }, [activeReport?.id, activeReport?.refreshIntervalSeconds]);

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
    if (!activeReport) return;
    if (!ui.openInEditor) { setShareStatus("The SQL editor is not ready yet."); return; }
    try {
      ui.openInEditor(materializeReportQuery(dataset.sql, activeReport, appliedValues), { autoRun: false });
    } catch (error) {
      setShareStatus(error instanceof Error ? error.message : String(error));
    }
  }, [activeReport, appliedValues]);

  const createNew = useCallback(() => openReport(createEmptyReport("New report", catalogData.catalogName, serviceUrl), undefined, false, false), [catalogData.catalogName, serviceUrl, openReport]);

  const acceptDraft = useCallback(async () => {
    if (!draft) return;
    const saved = await saveReport(draft);
    setSelected(saved); setDraft(cloneReport(saved)); setSourceText(exportReportJson(saved)); setAgentSummary(null); await reload();
  }, [draft, reload]);

  const publishDraft = useCallback(async () => {
    if (!draft) return;
    setShareStatus("Validating the draft before publishing…");
    const valid = await validateAndRun(draft, defaultValues(draft), false);
    if (!valid) return;
    const stored = await publishReport(draft);
    const saved = cloneReport(stored.document);
    const snapshot = cloneReport(stored.publishedDocument!);
    setSelected(saved);
    setDraft(saved);
    setPublished(snapshot);
    setPublishedAt(stored.publishedAt ?? null);
    setReaderMode(true);
    setAgentOpen(false);
    setInspectorOpen(false);
    setSourceText(exportReportJson(saved));
    setAgentSummary(null);
    setShareStatus(`Published revision ${snapshot.revision}.`);
    await reload();
  }, [draft, reload, validateAndRun]);

  const switchReportMode = useCallback((mode: "edit" | "reader") => {
    const next = mode === "reader" ? published : draft;
    if (!next) return;
    clearScheduledRateLimitRetry();
    const defaults = defaultValues(next);
    runGeneration.current += 1;
    setReaderMode(mode === "reader");
    setAgentOpen(false);
    setInspectorOpen(false);
    setValues(defaults);
    setAppliedValues(defaults);
    setParameterIssues([]);
    setParametersExpanded(false);
    setResults({});
    setNarrativeStates({});
    setRunProgress(null);
    setRunFailureNotice(null);
    setTimeout(() => void validateAndRunRef.current?.(next, defaults, false), 0);
  }, [clearScheduledRateLimitRetry, draft, published]);

  const updateLayout = useCallback((layout: Layout) => {
    setDraft((current) => current ? { ...current, blocks: current.blocks.map((b) => { const item = layout.find((l) => l.i === b.id); return item ? { ...b, layout: { x: item.x, y: item.y, w: item.w, h: item.h } } : b; }) } : current);
  }, []);

  const blockEditorDirty = Boolean(blockEditor && (blockEditor.isNew || JSON.stringify(blockEditor.block) !== blockEditor.initialJson));
  const discardDatasetEditor = useCallback(() => {
    if (!datasetEditorDirty) return true;
    if (!window.confirm("Discard unapplied dataset changes?")) return false;
    setDatasetEditorDirty(false);
    setDatasetEditorResetKey((key) => key + 1);
    return true;
  }, [datasetEditorDirty]);
  const discardBlockEditor = useCallback((force = false) => {
    if (blockApplyBusyRef.current) return false;
    if (!force && blockEditor && JSON.stringify(blockEditor.block) !== blockEditor.initialJson && !window.confirm("Discard unapplied block changes?")) return false;
    blockEditorRevisionRef.current += 1;
    setBlockEditor(null);
    setBlockEditorErrors([]);
    setBlockEditorApplying(false);
    return true;
  }, [blockEditor]);

  const openBlockEditor = useCallback((block: ReportBlock, isNew = false) => {
    if (blockApplyBusyRef.current) return;
    if (blockEditor && blockEditor.block.id !== block.id && !discardBlockEditor()) return;
    const copy = structuredClone(block);
    blockEditorRevisionRef.current += 1;
    setSelectedBlockId(copy.id);
    setBlockEditor({ block: copy, isNew, initialJson: JSON.stringify(copy) });
    setBlockEditorErrors([]);
    setAgentOpen(false);
    setInspectorOpen(false);
  }, [blockEditor, discardBlockEditor]);

  const candidateReportForBlock = useCallback((editor: BlockEditorState): ReportDocumentV1 | null => {
    if (!draft) return null;
    const blocks = editor.isNew
      ? [...draft.blocks, structuredClone(editor.block)]
      : draft.blocks.map((block) => block.id === editor.block.id ? structuredClone(editor.block) : block);
    return { ...draft, blocks, updatedAt: Date.now() };
  }, [draft]);

  const applyBlockEditor = useCallback(async () => {
    if (!blockEditor || blockApplyBusyRef.current) return;
    blockApplyBusyRef.current = true;
    setBlockEditorApplying(true);
    const revision = ++blockEditorRevisionRef.current;
    const candidate = candidateReportForBlock(blockEditor);
    try {
      if (!candidate) return;
      const errors = validateReport(candidate);
      const resultShapes: DatasetRunSummary[] = Object.entries(results)
        .filter(([, result]) => Boolean(result.table))
        .map(([datasetId, result]) => ({
          datasetId,
          name: candidate.datasets.find((dataset) => dataset.id === datasetId)?.name ?? datasetId,
          ok: true,
          columns: result.table!.schema.fields.map((field) => field.name),
        }));
      errors.push(...validateReportResultColumns({ ...candidate, blocks: [blockEditor.block] }, resultShapes));
      if (errors.length) { setBlockEditorErrors([...new Set(errors)]); return; }
      if (blockEditor.block.type === "chart") {
        const compile = await compileChartSpec(blockEditor.block.spec);
        if (revision !== blockEditorRevisionRef.current) return;
        const chartErrors = [compile.error, ...compile.warnings.filter(isBlockingVegaWarning)].filter((error): error is string => Boolean(error));
        if (chartErrors.length) { setBlockEditorErrors(chartErrors); return; }
        const rows = results[blockEditor.block.datasetId]?.rows;
        if (rows) {
          const rendered = await renderChartToPng(blockEditor.block.spec, rows);
          if (revision !== blockEditorRevisionRef.current) return;
          if ("error" in rendered) { setBlockEditorErrors([rendered.error]); return; }
        }
      }
      if (revision !== blockEditorRevisionRef.current) return;
      setDraft(candidate);
      setSourceText(exportReportJson(candidate));
      setSelectedBlockId(blockEditor.block.id);
      setBlockEditor(null);
      setBlockEditorErrors([]);
    } finally {
      if (revision === blockEditorRevisionRef.current) setBlockEditorApplying(false);
      blockApplyBusyRef.current = false;
    }
  }, [blockEditor, candidateReportForBlock, results]);

  const addBlock = useCallback((type: ReportBlock["type"]) => {
    if (!draft || !discardBlockEditor()) return;
    const datasetId = draft.datasets.find((dataset) => !dataset.role || dataset.role === "data")?.id;
    const columns = datasetId ? results[datasetId]?.table?.schema.fields.map((field) => field.name) ?? [] : [];
    const block = createReportBlock(draft, type, datasetId, columns);
    setSelectedBlockId(block.id);
    setBlockEditor({ block, isNew: true, initialJson: JSON.stringify(block) });
    setBlockEditorErrors([]);
    setAgentOpen(false);
    setInspectorOpen(false);
  }, [discardBlockEditor, draft, results]);

  const copyBlock = useCallback((block: ReportBlock) => {
    if (!draft || !discardBlockEditor()) return;
    const copy = duplicateReportBlock(draft, block);
    const next = { ...draft, blocks: [...draft.blocks, copy], updatedAt: Date.now() };
    setDraft(next);
    setSourceText(exportReportJson(next));
    setSelectedBlockId(copy.id);
  }, [discardBlockEditor, draft]);

  const removeBlock = useCallback((block: ReportBlock) => {
    if (!draft || !window.confirm(`Delete “${block.title || reportBlockLabel(block.type)}”? The dataset will be kept.`)) return;
    const next = { ...draft, blocks: draft.blocks.filter((candidate) => candidate.id !== block.id), updatedAt: Date.now() };
    setDraft(next);
    setSourceText(exportReportJson(next));
    setSelectedBlockId(null);
    if (blockEditor?.block.id === block.id) discardBlockEditor(true);
  }, [blockEditor?.block.id, discardBlockEditor, draft]);

  const editBlockDataset = useCallback((datasetId: string) => {
    if (!discardBlockEditor()) return;
    setWorkspaceView("datasets");
    setDatasetEditorRequest(datasetId);
  }, [discardBlockEditor]);

  const reportWithDataset = useCallback((dataset: ReportDataset): ReportDocumentV1 | null => {
    if (!draft) return null;
    return { ...draft, datasets: draft.datasets.map((candidate) => candidate.id === dataset.id ? structuredClone(dataset) : candidate), updatedAt: Date.now() };
  }, [draft]);

  const testReportDataset = useCallback(async (dataset: ReportDataset): Promise<{ ok: boolean; transient?: boolean; message: string; warnings?: string[] }> => {
    const candidate = reportWithDataset(dataset);
    if (!candidate) return { ok: false, message: "The report is no longer open." };
    datasetTestCacheRef.current = null;
    const errors = validateReport(candidate);
    if (errors.length) return { ok: false, message: errors.join(" ") };
    const captured = new Map<string, Record<string, any>[]>();
    const stagedResults = new Map<string, DatasetResult>();
    const summaries = await runDatasets(candidate, appliedValues, new Set([dataset.id]), captured, results[dataset.id]?.table ? "refresh" : "load", true, stagedResults);
    const failures = summaries.filter((summary) => !summary.ok);
    const permanent = failures.find((failure) => !failure.retryable);
    if (permanent) return { ok: false, message: permanent.error ?? "The dataset test failed." };
    const transient = failures.find((failure) => failure.retryable);
    if (transient) return { ok: false, message: "Live validation was delayed by the data source. Retry before applying so the current report remains intact." };
    const columnErrors = validateReportResultColumns(candidate, summaries);
    if (columnErrors.length) return { ok: false, message: "The query ran, but its result would break report blocks.", warnings: columnErrors };
    datasetTestCacheRef.current = { reportId: candidate.id, datasetJson: JSON.stringify(dataset), results: stagedResults };
    return { ok: true, message: `Tested ${summaries.length} affected dataset${summaries.length === 1 ? "" : "s"} successfully. Apply will reuse these results without querying again.` };
  }, [appliedValues, reportWithDataset, results, runDatasets]);

  const applyReportDataset = useCallback(async (dataset: ReportDataset) => {
    const candidate = reportWithDataset(dataset);
    if (!candidate) return;
    const cached = datasetTestCacheRef.current;
    if (!cached || cached.reportId !== candidate.id || cached.datasetJson !== JSON.stringify(dataset)) return;
    setDraft(candidate);
    setSourceText(exportReportJson(candidate));
    setResults((previous) => ({ ...previous, ...Object.fromEntries(cached.results) }));
    datasetTestCacheRef.current = null;
    setDatasetEditorRequest(null);
    setShareStatus("Dataset changes applied using the validated results.");
  }, [reportWithDataset]);

  const resetAgentConversation = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    agentMessagesRef.current = [];
    resultCache.current = new QueryResultCache();
    setAgentConversation([]);
    setAgentPrompt("");
    setAgentBusy(false);
    setAgentTargetBlockId(null);
  }, []);

  const runAgent = useCallback(async () => {
    const prompt = agentPrompt.trim();
    if (!draft || !prompt || agentBusy || engine.lifecycleStatus !== "ready") return;
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
    const agentTarget = agentTargetBlockId ? draft.blocks.find((block) => block.id === agentTargetBlockId) : undefined;
    const modelPrompt = agentTarget
      ? `The user is editing the existing report block ${JSON.stringify({ id: agentTarget.id, type: agentTarget.type, title: agentTarget.title, datasetId: "datasetId" in agentTarget ? agentTarget.datasetId : undefined })}. Keep this block ID when revising it and limit changes to this block unless the request explicitly requires related dataset changes.\n\n${prompt}`
      : prompt;
    agentMessagesRef.current.push({ role: "user", content: modelPrompt });
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
    let agentPlan: ReportAgentPlan | null = null;
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
      if (!agentPlan) return toolResult(reportAgentRepair("plan", "this authoring turn", ["Call plan_report before finalizing."], "plan_report"));
      const checkpoint = checkpointReportAgentPlan(agentPlan, candidate);
      if (!checkpoint.complete) return toolResult({
        ...reportAgentRepair("finalize", "planned report", [checkpoint.nextAction], "finalize_report"),
        checkpoint,
      });
      const structureErrors = validateReport(candidate);
      if (structureErrors.length) return toolResult(reportAgentRepair("finalize", "report structure", structureErrors, "finalize_report"));
      const sanitized = sanitizeReportChartSpecs(candidate);
      if (sanitized.errors.length) return toolResult(reportAgentRepair("finalize", "chart specifications", sanitized.errors, "finalize_report"));
      applyWorkingReport(sanitized.report, clearResults);
      workingRows.clear();
      const workingValues = defaultValues(workingReport);
      const execution = await runDatasets(workingReport, workingValues, undefined, workingRows);
      const failures = execution.filter((result) => !result.ok);
      const transientFailure = failures.find((result) => result.retryable);
      if (transientFailure) {
        setAgentSummary(`${summary} Live-data validation is temporarily delayed; the draft was kept unchanged.`);
        return toolResult({
          ok: false,
          code: "report_data_temporarily_unavailable",
          transient: true,
          retryAfterSeconds: transientFailure.retryAfterSeconds,
          message: "The report structure is intact, but its data source is temporarily unavailable. Do not rewrite SQL or visualizations in response to this error. Keep the draft and tell the user to retry validation shortly.",
          datasets: execution,
          checkpoint,
        });
      }
      const optionsByKey = Object.fromEntries(workingReport.parameters.map((parameter) => [parameter.key, parameterOptionsFromRows(parameter, workingRows)]));
      const parameterErrors = [
        ...validateReportParameterValues(workingReport, workingValues, optionsByKey).map((issue) => issue.message),
        ...validationDatasetIssues(workingReport, workingRows, execution).map((issue) => issue.message),
      ];
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
      const needsCorrection = failures.length > 0 || parameterErrors.length > 0 || blockErrors.length > 0 || charts.errors.length > 0 || narrativeErrors.length > 0;
      setAgentSummary(needsCorrection ? `${summary} The draft needs correction.` : `${summary} Data, visualizations, and AI narratives loaded.`);
      return toolResult({
        ...(needsCorrection ? reportAgentRepair("finalize", "report validation", [
          ...failures.map((failure) => `${failure.name}: ${failure.error ?? "query failed"}`),
          ...parameterErrors,
          ...blockErrors,
          ...charts.errors,
          ...narrativeErrors,
        ], "finalize_report") : { ok: true }),
        message: needsCorrection
          ? "The report ran, but has dataset, column, visualization, or AI narrative errors. Correct the affected item and finalize again."
          : "Every dataset executed, every chart rendered, and every AI narrative was snapshotted. The populated report is ready for user review.",
        checkpoint,
        datasets: execution,
        parameterErrors,
        blockErrors,
        chartErrors: charts.errors,
        chartWarnings: charts.warnings,
        narrativeErrors,
      }, charts.feedback);
    };
    const system: SystemPrompt = [{ text: `You are Cupola's report-authoring agent. Build and revise a declarative, rerunnable report. Never add JavaScript.

Use a compositional workflow: (1) inspect tables, (2) call plan_report with the concrete work and acceptance criteria for this turn, (3) call configure_report, (4) create any meaningful visual sections with upsert_report_group, (5) call upsert_report_dataset for one dataset and fix its SQL before continuing, (6) call upsert_report_block for one block and fix any compile/render error before continuing, and (7) call finalize_report. Do not mutate the report before plan_report succeeds. Tool results include a checkpoint showing planned versus completed work. Do not finish until finalize_report returns ok=true. Prefer these tools over replace_report_draft.

Treat rate limits and temporary service failures as infrastructure conditions, not evidence that SQL or a visualization is wrong. If a tool returns transient=true or reports HTTP 429/rate limiting, do not rewrite the affected dataset or block and do not repeatedly call the service. Keep the composed draft, continue work that does not require another live request, and tell the user that live-data validation is delayed.

Cupola owns grid placement for compositional blocks. upsert_report_block may request only the semantic width values quarter/third/half/full and height values compact/medium/tall; never send numeric col/x/y/w/h fields. The strict bulk fallback is different: every full-document block must contain layout nested exactly as {"layout":{"x":0,"y":0,"w":12,"h":6}}; layout fields are never top-level.

Use report groups when two or more blocks belong to the same subject and the grouping helps the reader scan the page—for example one rounded section for each city in a weather comparison. Create each group first, then set groupId on every related block. Give groups specific titles, optional short descriptions, and restrained tones; titleSize may be small, medium (the default), or large. Use large when the group name is a major report section and small only in dense layouts. Do not create a group around a single block unless the user asks for it.

Blocks may set appearance for semantic backgrounds. Use tone neutral/info/success/warning/danger and emphasis subtle/prominent. For value-driven alerts, add up to five ordered rules with column, operator, value, tone, label, and optional value2/emphasis/rowMatch; the first matching rule wins. Put severe rules first. Always provide a concise label such as "Above preferred range" so color is not the only signal. Only use thresholds supplied by the user or clearly defined by the data/domain—never invent alert boundaries. Prefer this for KPIs and compact status boxes; use it sparingly on large charts and tables.

Inspect every external table before using it. SQL datasets must be one read-only SELECT/VALUES/WITH query. When several datasets need the same expensive source query, create one upstream dataset with a short snake_case id (for example weather_base), then query that id from downstream dataset SQL with FROM weather_base or JOIN weather_base. Cupola uses DuckDB's parser to infer these dependencies, executes them in dependency order, and materializes shared upstream results once for the refresh; never write CREATE/DROP statements or duplicate the source query. A dataset may read an external relation with the same name as its own id, which is treated as a source rather than a self-dependency. Parameter references use $key, date ranges use $key_start/$key_end, and multi-select values appear in IN ($key). Put parameters used by several outputs in the upstream dataset when possible so its downstream datasets refresh together. Do not add a WHERE clause unless the user's request actually requires filtering.

Supported blocks are markdown, ai_narrative, kpi, sparkline, small_multiples, bullet, slopegraph, range_dot, table, chart, perspective, and map. Every block may include a concise caption and source note. Markdown content and reader-facing block and group titles may contain parameter tokens such as $city; Cupola replaces them with the currently applied value at render time. A markdown block may have a meaningful visible title or omit title for a clean content-only card; never title one "Text" or "Markdown", and omit the block title when the markdown already begins with its own heading. Markdown supports safe HTTPS and relative image URLs with ![alt text](url), but Cupola does not upload or persist image files.

Use ai_narrative only when data-dependent prose adds real value, such as an executive summary, comparison, anomaly explanation, or changing forecast commentary. Provide one datasetId and a focused instruction, optionally columns, maxRows from 1 to 100, and refreshPolicy manual or when_data_changes. Prefer a compact, aggregated dataset rather than sending raw detail. Manual is the default and avoids surprise cost; choose when_data_changes only when the user wants fresh prose during report refresh. The narrative call has no tools and cannot edit the report. Cupola generates and snapshots it during authoring, so do not also write a static markdown version of the same summary.

Use these semantic Tufte-style blocks before writing a free-form chart when they fit:
- small_multiples: facetColumn, xColumn, yColumn; optionally xType, mark, colorColumn, facetColumns, sharedY, referenceValue, and referenceLabel. Prefer sharedY=true for honest comparison unless units or magnitudes genuinely differ.
- bullet: categoryColumn, valueColumn, targetColumn; optionally up to three broad-to-narrow rangeColumns, format, color, and showValues auto/all/none. Auto directly labels values for six or fewer rows. Use for actual versus goal, not as a decorative gauge.
- slopegraph: categoryColumn, startColumn, endColumn; optionally startLabel, endLabel, colorColumn, and format. Use only for two endpoints.
- range_dot: categoryColumn, lowColumn, highColumn; optionally valueColumn, format, color, and showValues auto/all/none. Auto directly labels low/current/high for six or fewer rows. Use for intervals, uncertainty, min/max, or benchmarks.

For a KPI, valueColumn is the prominent first-row value. When the dataset also contains meaningful bounds, set lowColumn and highColumn to add a compact, directly labeled range strip; optionally add targetColumn and rangeLabel. Keep the value prominent and use appearance rules for accessible in/out-of-range status. Never invent bounds.

Use sparkline for a compact single-metric trend box: provide datasetId and valueColumn, optionally labelColumn, format, showValue, and color. Sparkline points follow query result order, so order the dataset in SQL. For a history/forecast or other data-driven boundary, return a boolean or phase column and set splitColumn; the first truthy, forecast, future, yes, after, or 1 value draws a vertical divider. Split sparklines headline and mark the last observed row by default, not the forecast endpoint. Set headlineRow to last, last_observed, or first_forecast to override it; headlineValueColumn can display another dataset column from that row. Optionally set splitLabel (for example Now) and splitColor for the portion at and after the divider; color controls the portion before it. It needs no Vega spec and defaults to a compact quarter-width box with almost no chart margin. Use a full chart when axes, legends, multiple series, or richer encodings matter. Charts are minimal Vega-Lite v5 specs without data, datasets, url, href, or src. Vega-Lite y2 is valid only as an encoding definition such as {"y2":{"field":"high"}}; use layers only when the visual itself needs layers, not as a generic error workaround. The block tool compiles and renders all visualization blocks with real rows and may return an image. Treat its exact compiler/render error as authoritative; do not guess at causes.

Maps are declarative Leaflet blocks: set type="map", datasetId, and either geometryColumn for WKB/GeoJSON or both latitudeColumn and longitudeColumn. Maps may also set labelColumn, colorColumn, tooltipColumns, basemap ("openstreetmap" or "none"), palette, and style.

Reports may set refreshIntervalSeconds from 5 through 86400 when the user wants live automatic refresh; omit it (or configure it as null) otherwise.

Parameters are a validated public interface, not merely SQL substitutions. Set required when empty input is invalid. Use validation for type-appropriate declarative constraints: number min/max/exclusiveMin/exclusiveMax/step/integer; text minLength/maxLength/pattern; date min/max; date_range min/max/requireBoth/maxSpanDays; multi_select minSelections/maxSelections. Static and dataset-backed select values are checked for membership when Apply is pressed. Use parameterRules for relationships between values, including date_range paths such as period.start and period.end. A rule has leftKey, operator, exactly one of rightKey or value, and a reader-friendly message. For data-dependent business rules, create a role="parameter_validation" dataset that returns one row with a boolean column and optional message column, then reference it from validationDataset on the parameter. Keep validation SQL read-only and parameterized. Reader text supports $key, $key_label, $key_value, and date-range $key_start/$key_end; use $$ for a literal dollar sign. Do not invent arbitrary JavaScript validation or interpolate raw SQL fragments.

`, cacheControl: true }, {
      text: `Current report:\n${JSON.stringify(draft)}`,
      cacheControl: true,
    }];
    try {
      await runAgentTurn(settings.anthropicApiKey, settings.aiModel, agentMessagesRef.current, system, async (name, input) => {
        if (name === "list_tables") return executeListTables(catalogData);
        if (name === "describe_table") return executeDescribeTable(catalogData, input.schema, input.table);
        if (name === "preview_sql") {
          const errors = validateReadOnlySql(String(input.sql ?? "")); if (errors.length) throw new Error(errors.join(" "));
          if (!engine.query) throw new Error("DuckDB is not ready.");
          return executeRunSql(input.sql, { query: engine.query, resultCache: resultCache.current });
        }
        if (name === "plan_report") {
          const plan = parseReportAgentPlan(input);
          const errors = validateReportAgentPlan(plan);
          if (errors.length) return toolResult(reportAgentRepair("plan", "authoring plan", errors, "plan_report"));
          agentPlan = plan;
          const checkpoint = checkpointReportAgentPlan(plan, workingReport);
          setAgentSummary(`Plan: ${plan.objective}`);
          return toolResult({ ok: true, plan, checkpoint, message: "Plan accepted. Follow the checkpoint and revise the plan if the requested scope changes." });
        }
        if (["configure_report", "upsert_report_group", "upsert_report_dataset", "upsert_report_block", "finalize_report", "replace_report_draft"].includes(name) && !agentPlan) {
          return toolResult(reportAgentRepair("plan", "this authoring turn", ["Call plan_report before changing the report."], "plan_report"));
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
          if (Array.isArray(input.parameterRules)) next.parameterRules = structuredClone(input.parameterRules);
          next.updatedAt = Date.now();
          const errors = validateReport(next);
          if (errors.length) return toolResult(reportAgentRepair("configure", "report configuration", errors, "configure_report"));
          applyWorkingReport(next);
          return toolResult({ ok: true, reportId: next.id, title: next.title, refreshIntervalSeconds: next.refreshIntervalSeconds ?? null, parameterKeys: next.parameters.map((parameter) => parameter.key), checkpoint: checkpointReportAgentPlan(agentPlan!, next) });
        }
        if (name === "upsert_report_group") {
          const updated = upsertAgentGroup(workingReport, input.group ?? {});
          const errors = validateReport(updated.report);
          if (errors.length) return toolResult({ ...reportAgentRepair("block", `group ${updated.group.id}`, errors, "upsert_report_group"), groupId: updated.group.id });
          applyWorkingReport(updated.report);
          setAgentSummary(`${updated.group.title} group added.`);
          return toolResult({ ok: true, groupId: updated.group.id, message: "Group created. Set this groupId on every related report block.", checkpoint: checkpointReportAgentPlan(agentPlan!, updated.report) });
        }
        if (name === "upsert_report_dataset") {
          const updated = upsertAgentDataset(workingReport, input.dataset ?? {});
          const errors = validateReport(updated.report);
          if (errors.length) return toolResult({ ...reportAgentRepair("dataset", `dataset ${updated.dataset.id}`, errors, "upsert_report_dataset"), datasetId: updated.dataset.id });
          applyWorkingReport(updated.report);
          const execution = await runDatasets(workingReport, defaultValues(workingReport), new Set([updated.dataset.id]), workingRows);
          const result = execution.find((candidate) => candidate.datasetId === updated.dataset.id);
          const transient = Boolean(result?.retryable);
          setAgentSummary(result?.ok ? `${updated.dataset.name} loaded.` : transient ? `${updated.dataset.name} validation was delayed by its data source.` : `${updated.dataset.name} needs correction.`);
          return toolResult({
            ...(result?.ok
              ? { ok: true }
              : transient
                ? { ok: false, code: "report_data_temporarily_unavailable", transient: true, retryAfterSeconds: result?.retryAfterSeconds }
                : reportAgentRepair("dataset", `dataset ${updated.dataset.id}`, [result?.error ?? "Dataset execution failed."], "upsert_report_dataset")),
            datasetId: updated.dataset.id,
            message: result?.ok
              ? "Dataset executed. Reuse datasetId when adding blocks or revising this query."
              : transient
                ? "The data source is temporarily unavailable. Keep this dataset unchanged; do not rewrite its SQL because of this transient error. Continue composing the report and retry validation later."
                : "Fix this dataset and call upsert_report_dataset again with the same datasetId.",
            result,
            checkpoint: checkpointReportAgentPlan(agentPlan!, workingReport),
          });
        }
        if (name === "upsert_report_block") {
          const updated = upsertAgentBlock(workingReport, input.block ?? {}, input.width as SemanticBlockWidth | undefined, input.height as SemanticBlockHeight | undefined);
          const sanitized = sanitizeReportChartSpecs(updated.report);
          const errors = [...sanitized.errors, ...validateReport(sanitized.report)];
          if (errors.length) return toolResult({ ...reportAgentRepair("block", `block ${updated.block.id}`, errors, "upsert_report_block"), blockId: updated.block.id });
          const block = sanitized.report.blocks.find((candidate) => candidate.id === updated.block.id)!;
          applyWorkingReport(sanitized.report);
          if (block.type === "markdown") {
            setAgentSummary(`${visibleMarkdownTitle(block.title) ?? "Text block"} added.`);
            return toolResult({ ok: true, blockId: block.id, layout: block.layout, message: "Text block rendered without requiring a dataset.", checkpoint: checkpointReportAgentPlan(agentPlan!, workingReport) });
          }
          const execution = await runDatasets(workingReport, defaultValues(workingReport), new Set([block.datasetId]), workingRows);
          const transientFailure = execution.find((result) => result.retryable);
          if (transientFailure) {
            setAgentSummary(`${block.title ?? block.type} was added; live-data validation is temporarily delayed.`);
            return toolResult({
              ok: false,
              code: "report_data_temporarily_unavailable",
              transient: true,
              retryAfterSeconds: transientFailure.retryAfterSeconds,
              blockId: block.id,
              layout: block.layout,
              dataset: transientFailure,
              message: "The block is saved, but its data source is temporarily unavailable. Do not rewrite the block or dataset in response; continue composing and retry validation later.",
              checkpoint: checkpointReportAgentPlan(agentPlan!, workingReport),
            });
          }
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
            ...(needsCorrection ? reportAgentRepair("block", `block ${block.id}`, [
              ...execution.filter((result) => !result.ok).map((result) => result.error ?? "Dataset execution failed."),
              ...blockErrors,
              ...charts.errors,
              ...narrativeErrors,
            ], "upsert_report_block") : { ok: true }),
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
            checkpoint: checkpointReportAgentPlan(agentPlan!, workingReport),
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
      }, controller.signal, settings.aiMaxToolRounds ?? 20, REPORT_TOOLS, settings.aiMaxTokens ?? DEFAULT_AI_MAX_TOKENS, "usage");
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
  }, [draft, agentPrompt, agentBusy, settings, catalogData, runDatasets, agentTargetBlockId]);

  const compatibleCatalogs = useMemo(() => new Set([catalogData.catalogName, ...attachedCatalogNames, "memory"]), [catalogData.catalogName, attachedCatalogNames]);
  const isCompatible = (r: ReportDocumentV1) => r.requiredSources.every((s) => compatibleCatalogs.has(s.catalog));
  const libraryReports = initialReport && !reports.some((report) => report.id === initialReport.id)
    ? [initialReport, ...reports]
    : reports;

  const promotionDialog = pendingPromotion ? <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4 report-authoring-control"><div className="bg-card border rounded-lg shadow-xl p-5 w-full max-w-md"><h2 className="font-semibold">Add query to a report</h2><p className="text-sm text-muted-foreground mt-1 mb-4">Create a new report or append this dataset to an existing report draft.</p><div className="flex flex-col gap-2 max-h-[60vh] overflow-y-auto"><Button onClick={() => { const report = applyPromotion(createEmptyReport(pendingPromotion.title || "Report from query", catalogData.catalogName, serviceUrl), pendingPromotion); setPendingPromotion(null); openReport(report, undefined, false, false); }}>Create new report</Button>{draft && <Button variant="outline" onClick={() => { const report = applyPromotion(draft, pendingPromotion); setPendingPromotion(null); setDraft(report); setSourceText(exportReportJson(report)); }}>Add to open report: {draft.title}</Button>}{reports.filter((r) => r.id !== draft?.id).map((report) => <Button key={report.id} variant="outline" onClick={() => { const updated = applyPromotion(report, pendingPromotion); setPendingPromotion(null); openReport(updated, undefined, false, false); }}>Add to {report.title}</Button>)}<Button variant="ghost" onClick={() => setPendingPromotion(null)}>Cancel</Button></div></div></div> : null;

  if (!draft) return <div className="h-full overflow-y-auto bg-background p-4 sm:p-6" data-testid="reports-workspace">
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center justify-between gap-4 mb-5"><div><h1 className="text-xl font-semibold">Reports</h1><p className="text-sm text-muted-foreground">Reusable, agent-authored analysis against your attached data.</p></div><div className="flex flex-wrap justify-end gap-2"><a href={`${import.meta.env.BASE_URL}report-guide/`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm hover:bg-muted"><BookOpen className="h-4 w-4" /> Visualization guide</a><label className="inline-flex"><input type="file" accept="application/json,.json" className="sr-only" onChange={async (e) => { const file = e.target.files?.[0]; if (!file) return; try { openReport(importReportJson(await file.text()), undefined, false, false); setShareStatus("Imported report opened for review."); } catch (err) { setShareStatus(err instanceof Error ? err.message : String(err)); } }} /><span className="inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm cursor-pointer hover:bg-muted"><FileJson className="h-4 w-4" /> Import</span></label><Button onClick={createNew}><Plus className="h-4 w-4" /> New report</Button></div></div>
      {shareStatus && <div className="mb-4 rounded-md border bg-muted/40 p-3 text-sm">{shareStatus}</div>}
      {libraryReports.length === 0 ? <div className="border border-dashed rounded-xl p-12 text-center"><BarChart3 className="h-10 w-10 mx-auto text-muted-foreground/40 mb-3" /><p className="font-medium">No saved reports yet</p><p className="text-sm text-muted-foreground mb-4">Ask the report agent to build one, or add a query from the editor.</p><Button onClick={createNew}><Sparkles className="h-4 w-4" /> Create with AI</Button></div> : <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">{libraryReports.map((report) => {
        const publication = publishedReports[report.id];
        return <div key={report.id} className="relative border rounded-lg bg-card hover:border-primary/50 transition-colors"><button onClick={() => openReport(report, undefined, isCompatible(publication ?? report), report.id !== initialReport?.id, publication ? "reader" : "edit", publication, publishedTimes[report.id])} className="w-full text-left p-4 pr-10"><div className="flex justify-between gap-2"><span className="font-medium truncate">{report.title}</span><span className={`text-[10px] rounded-full px-2 py-0.5 ${publication ? "bg-sky-500/10 text-sky-700" : isCompatible(report) ? "bg-muted text-muted-foreground" : "bg-amber-500/10 text-amber-700"}`}>{publication ? "Published" : isCompatible(report) ? "Draft" : "Missing source"}</span></div><p className="text-xs text-muted-foreground mt-2 line-clamp-2">{report.description || `${report.blocks.length} blocks · ${report.datasets.length} datasets`}</p><p className="text-[10px] text-muted-foreground mt-3">{report.id === initialReport?.id ? "Built-in example" : publication ? `Published revision ${publication.revision} · Draft revision ${report.revision}` : `Draft revision ${report.revision}`}</p></button>{report.id !== initialReport?.id && <button className="absolute right-2 bottom-2 p-1 text-muted-foreground hover:text-destructive" aria-label={`Delete ${report.title}`} onClick={async () => { if (confirm(`Delete “${report.title}”?`)) await deleteReport(report.id); }}><Trash2 className="h-3.5 w-3.5" /></button>}</div>;
      })}</div>}
    </div>
    {promotionDialog}
  </div>;

  const baseReport = activeReport ?? draft;
  const report = !readerMode && blockEditor
    ? candidateReportForBlock(blockEditor) ?? baseReport
    : baseReport;
  const reportErrors = validateReport(report);
  const editorValidationErrors = blockEditor ? [...new Set([...reportErrors, ...blockEditorErrors])] : [];
  const dirty = !selected || JSON.stringify(draft) !== JSON.stringify(selected);
  const columnsByDataset = Object.fromEntries(report.datasets.map((dataset) => [dataset.id, results[dataset.id]?.table?.schema.fields.map((field) => field.name) ?? []]));
  const optionValues = (p: ReportParameter) => {
    const rows = new Map(Object.entries(results).map(([datasetId, result]) => [datasetId, result.rows]));
    return parameterOptionsFromRows(p, rows) ?? [];
  };
  const parametersDirty = report.parameters.some((parameter) => JSON.stringify(values[parameter.key] ?? parameter.defaultValue) !== JSON.stringify(appliedValues[parameter.key] ?? parameter.defaultValue));
  const desktopLayout = report.blocks.map((block) => ({ i: block.id, ...block.layout }));
  let mobileY = 0;
  let previousMobileGroup: string | undefined;
  const mobileLayout = [...report.blocks]
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
  const groupBoxes = reportGroupBoxes(report.groups ?? [], report.blocks, activeLayout, width, width >= 768 ? 12 : 1);
  const engineReady = engineLifecycle.status === "ready";
  const reportRunning = engineWaiting || Object.values(results).some(isDatasetPending) || Object.values(narrativeStates).some((state) => state.status === "running");
  const reportFetchedAt = reportRunning ? 0 : Math.max(0, ...report.datasets.filter((dataset) => dataset.role !== "parameter_options" && dataset.role !== "parameter_validation").map((dataset) => results[dataset.id]?.fetchedAt ?? 0));
  const progressLabel = runProgress
    ? `${runProgress.mode === "refresh" ? "Refreshing" : "Loading"} ${runProgress.completed} of ${runProgress.total} datasets`
    : null;

  return <div className="h-full flex flex-col bg-background" data-testid="reports-workspace" data-report-mode={readerMode ? "reader" : "edit"} aria-busy={reportRunning}>
    {!readerMode ? <div className="report-authoring-control flex flex-wrap items-center gap-2 border-b bg-card px-3 py-2">
      <Button size="sm" variant="ghost" className="shrink-0" onClick={() => { if (!discardBlockEditor() || !discardDatasetEditor()) return; runGeneration.current += 1; setRunProgress(null); setDraft(null); setSelected(null); setResults({}); }}><ArrowLeft className="h-4 w-4" /> Reports</Button>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <Input aria-label="Report title" className="h-8 min-w-40 flex-1 font-medium sm:max-w-sm" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
        <span data-testid="report-save-status" className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${dirty ? "bg-amber-500/10 text-amber-800 dark:text-amber-200" : "bg-emerald-500/10 text-emerald-800 dark:text-emerald-200"}`}>{published ? (dirty ? "Unsaved changes" : "Saved") : (dirty ? "Draft · Unsaved" : "Draft · Saved")}</span>
        {published && <div role="group" aria-label="Report mode" className="inline-flex shrink-0 rounded-md border bg-muted/20 p-0.5 text-[10px]"><span className="rounded bg-background px-2 py-1 font-medium shadow-sm">Draft</span><button type="button" className="rounded px-2 py-1 text-muted-foreground hover:text-foreground" onClick={() => { if (discardBlockEditor() && discardDatasetEditor()) switchReportMode("reader"); }}>Published</button></div>}
        {(reportFetchedAt > 0 || draft.refreshIntervalSeconds) && <span className="hidden shrink-0 items-center gap-1 text-[10px] text-muted-foreground lg:inline-flex" title={reportFetchedAt ? new Date(reportFetchedAt).toLocaleString() : undefined}>{reportFetchedAt > 0 && <><Clock3 className="h-3 w-3" /><span data-testid="report-as-of">{freshnessLabel(reportFetchedAt)}</span></>}{reportFetchedAt > 0 && draft.refreshIntervalSeconds ? <span>·</span> : null}{draft.refreshIntervalSeconds ? <span>Auto · {refreshChoices.find((choice) => choice.value === draft.refreshIntervalSeconds)?.label.replace(/^Every /, "") ?? `${draft.refreshIntervalSeconds}s`}</span> : null}</span>}
      </div>
      <div className="flex w-full items-center justify-end gap-1 sm:gap-2 md:w-auto">
        <Button size="sm" variant="outline" aria-label="Edit with AI" title="Edit with AI" onClick={() => { if (!discardBlockEditor() || !discardDatasetEditor()) return; if (agentTargetBlockId) resetAgentConversation(); setAgentTargetBlockId(null); setInspectorOpen(false); setAgentOpen((v) => !v); }}><Bot className="h-4 w-4" /><span className="hidden sm:inline">Edit with AI</span></Button>
        <ReportRunControl reader={false} running={reportRunning} disabled={blockEditorDirty || datasetEditorDirty || reportErrors.length > 0 || reportRunning || !engineReady} label={engineWaiting ? "Preparing…" : progressLabel ?? "Run report"} interval={draft.refreshIntervalSeconds} onRun={runFullReport} onIntervalChange={updateAutoRefresh} />
        <Button size="sm" variant="outline" aria-label="Save report draft" title={datasetEditorDirty ? "Apply or discard the dataset edit before saving" : "Save report draft"} disabled={blockEditorDirty || datasetEditorDirty || !dirty || reportErrors.length > 0} onClick={acceptDraft}><Save className="h-4 w-4" /><span className="hidden sm:inline">Save</span></Button>
        <Button size="sm" disabled={blockEditorDirty || datasetEditorDirty || reportErrors.length > 0 || reportRunning || !engineReady || !isCompatible(draft)} onClick={publishDraft}><Send className="h-4 w-4" /> Publish{published ? <span className="hidden sm:inline"> changes</span> : null}</Button>
        <ReportMoreMenu
          reader={false}
          revisions={revisionOptions}
          onRestoreRevision={async (revision) => { const restored = await restoreReportRevision(draft.id, revision); openReport(restored, undefined, false); }}
          onShareDraft={async () => { try { await navigator.clipboard.writeText(await buildShareReportUrl(draft, { serviceUrl, values: appliedValues })); setShareStatus("Draft review link copied."); } catch (e) { setShareStatus(e instanceof Error ? e.message : String(e)); } }}
          onPrint={() => window.print()}
          onEditSource={() => { if (!discardBlockEditor() || !discardDatasetEditor()) return; setAgentOpen(false); setInspectorOpen(true); setSourceText(exportReportJson(draft)); }}
          onDownload={() => triggerDownload(new Blob([exportReportJson(draft)], { type: "application/json" }), `${safeFileStem(draft.title)}.cupola-report.json`)}
        />
      </div>
    </div> : <div className="flex flex-wrap items-center gap-3 border-b bg-card px-4 py-3">
      <Button size="sm" variant="ghost" className="shrink-0" onClick={() => { runGeneration.current += 1; setRunProgress(null); setDraft(null); setSelected(null); setPublished(null); setReaderMode(false); setResults({}); }}><ArrowLeft className="h-4 w-4" /> Reports</Button>
      <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><h1 className="truncate text-base font-semibold">{report.title}</h1><span className="shrink-0 rounded-full bg-sky-500/10 px-2 py-0.5 text-[10px] font-medium text-sky-700">Published</span></div><p className="truncate text-[10px] text-muted-foreground" title={reportFetchedAt ? new Date(reportFetchedAt).toLocaleString() : undefined}>{publishedAt ? `Published ${new Date(publishedAt).toLocaleString()}` : "Published report"}{reportFetchedAt > 0 ? ` · ${freshnessLabel(reportFetchedAt)}` : ""}{report.refreshIntervalSeconds ? ` · Auto ${report.refreshIntervalSeconds}s` : ""}</p></div>
      <div className="flex w-full items-center justify-end gap-1 sm:gap-2 md:w-auto">
        <ReportRunControl reader running={reportRunning} disabled={reportErrors.length > 0 || reportRunning || !engineReady} label={engineWaiting ? "Preparing…" : progressLabel ?? "Refresh"} interval={report.refreshIntervalSeconds} onRun={runFullReport} onIntervalChange={(seconds) => setPublished((current) => {
          if (!current) return current;
          const { refreshIntervalSeconds: _interval, ...withoutInterval } = current;
          return seconds ? { ...withoutInterval, refreshIntervalSeconds: seconds } : withoutInterval;
        })} />
        <Button size="sm" variant="outline" aria-label="Share" title="Share" onClick={async () => { try { await navigator.clipboard.writeText(await buildShareReportUrl(report, { serviceUrl, values: appliedValues, mode: "reader" })); setShareStatus("Reader link copied."); } catch (e) { setShareStatus(e instanceof Error ? e.message : String(e)); } }}><Share2 className="h-4 w-4" /><span className="hidden sm:inline">Share</span></Button>
        <Button size="sm" variant="outline" aria-label="Edit report" title="Edit report" onClick={() => switchReportMode("edit")}><Pencil className="h-4 w-4" /><span className="hidden sm:inline">Edit report</span></Button>
        <ReportMoreMenu reader revisions={[]} onPrint={() => window.print()} onDownload={() => triggerDownload(new Blob([exportReportJson(report)], { type: "application/json" }), `${safeFileStem(report.title)}.cupola-report.json`)} />
      </div>
    </div>}
    <div className="report-authoring-control flex h-10 shrink-0 items-end gap-1 border-b bg-card px-3">
      <div role="tablist" aria-label="Report views" className="flex h-10 items-end gap-1">
      <button type="button" role="tab" id="report-view-tab" aria-selected={workspaceView === "report"} aria-controls="report-view-panel" data-testid="report-view-tab" onClick={() => { if (workspaceView !== "report" && (!discardBlockEditor() || !discardDatasetEditor())) return; setWorkspaceView("report"); }} className={`inline-flex h-10 items-center gap-1.5 border-b-2 px-3 text-sm ${workspaceView === "report" ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}><BarChart3 className="h-3.5 w-3.5" /> Report</button>
      <button type="button" role="tab" id="report-datasets-tab" aria-selected={workspaceView === "datasets"} aria-controls="report-datasets-panel" data-testid="report-datasets-tab" onClick={() => { if (!discardBlockEditor()) return; setWorkspaceView("datasets"); }} className={`inline-flex h-10 items-center gap-1.5 border-b-2 px-3 text-sm ${workspaceView === "datasets" ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}><Database className="h-3.5 w-3.5" /> Datasets <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none">{report.datasets.length}</span></button>
      </div>
      <div className="flex-1" />
      {!readerMode && workspaceView === "report" && <Popover><PopoverTrigger className={buttonVariants({ variant: "ghost", size: "sm", className: "mb-1" })} data-testid="report-add-block"><Plus className="h-4 w-4" /> Add block</PopoverTrigger><PopoverContent className="w-64 p-2" align="end"><div className="text-xs font-semibold">Add report block</div><div className="mt-2 space-y-2">{["Text", "Metrics", "Visualizations", "Data"].map((group) => <div key={group}><div className="px-1 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{group}</div><div className="grid grid-cols-2 gap-1">{REPORT_BLOCK_TYPES.filter((item) => item.group === group).map((item) => <BaseUIPopover.Close key={item.type} data-testid={`report-add-${item.type}`} className="rounded px-2 py-1.5 text-left text-xs hover:bg-muted" onClick={() => addBlock(item.type)}>{item.label}</BaseUIPopover.Close>)}</div></div>)}</div></PopoverContent></Popover>}
    </div>
    {!engineReady && <div data-testid="report-engine-waiting" role={engineLifecycle.status === "error" ? "alert" : "status"} className={engineLifecycle.status === "error" ? "border-b border-destructive/25 bg-destructive/5 px-4 py-2 text-xs text-destructive" : "border-b border-sky-300/50 bg-sky-50/50 px-4 py-2 text-xs text-sky-950 dark:border-sky-800 dark:bg-sky-950/25 dark:text-sky-100"}>
      <div className="flex items-center gap-2">{engineLifecycle.status === "error" ? null : <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />}<span className="font-medium">{engineLifecycle.status === "error" ? "Report data is unavailable because the local data engine did not start." : "Preparing the local data engine. This report will run automatically when it is ready."}</span></div>
    </div>}
    {runProgress && <div data-testid="report-run-progress" className="border-b bg-muted/30 px-4 py-2" aria-live="polite">
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
    {(!isCompatible(report) || reportErrors.length > 0 || shareStatus || (!readerMode && agentSummary)) && <div className="px-4 py-2 border-b text-xs space-y-1">{!isCompatible(report) && <div className="text-amber-700">Missing required catalogs: {report.requiredSources.filter((s) => !compatibleCatalogs.has(s.catalog)).map((s) => s.catalog).join(", ")}</div>}{reportErrors.length > 0 && <div className="text-destructive">{reportErrors.join(" ")}</div>}{shareStatus && <div>{shareStatus}</div>}{!readerMode && agentSummary && <div className="text-primary"><Check className="inline h-3 w-3 mr-1" />Agent draft: {agentSummary}</div>}</div>}
    {runFailureNotice && <div data-testid="report-run-failure" role="alert" className="border-b border-amber-300/70 bg-amber-50/80 px-4 py-3 text-xs text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
      <div className="font-semibold">{runFailureNotice.title}</div>
      <div className="mt-0.5">{runFailureNotice.message}</div>
      {runFailureNotice.details.length > 0 && <details className="mt-1.5"><summary className="cursor-pointer font-medium">Technical details</summary><ul className="mt-1 list-disc space-y-0.5 pl-5 font-mono text-[10px] opacity-80">{runFailureNotice.details.map((detail, index) => <li key={`${index}-${detail}`}>{detail}</li>)}</ul></details>}
    </div>}
    {report.parameters.length > 0 && <div className="report-parameters border-b bg-muted/20" aria-label="Report parameters">
      <button
        type="button"
        data-testid="report-parameters-toggle"
        aria-expanded={parametersExpanded}
        aria-controls="report-parameter-controls"
        className="flex h-10 w-full min-w-0 items-center gap-2 px-4 text-left hover:bg-muted/40"
        onClick={() => setParametersExpanded((expanded) => !expanded)}
      >
        <SlidersHorizontal className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-xs font-medium">Parameters</span>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto" aria-label="Applied parameter values">
          {report.parameters.map((parameter) => {
            const summary = parameterRibbonValue(parameter, appliedValues[parameter.key] ?? parameter.defaultValue, optionValues(parameter));
            return <span key={parameter.id} title={`${parameter.label}: ${summary}`} className="inline-flex min-w-0 max-w-56 shrink-0 items-center gap-1 rounded-full border bg-background/80 px-2 py-0.5 text-[11px]">
              <span className="shrink-0 text-muted-foreground">{parameter.label}:</span>
              <span className="truncate font-medium">{summary}</span>
            </span>;
          })}
        </div>
        {parametersDirty && <span className="shrink-0 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-700">Unapplied changes</span>}
        {parametersExpanded ? <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />}
      </button>
      {parametersExpanded && <div id="report-parameter-controls" className="flex flex-wrap items-end gap-3 border-t px-4 py-3">{report.parameters.map((p) => <ParameterInput key={p.id} parameter={p} value={values[p.key] ?? p.defaultValue} options={optionValues(p)} errors={parameterIssues.filter((issue) => issue.parameterKey === p.key).map((issue) => issue.message)} onChange={(value) => setValues((current) => {
        const next = { ...current, [p.key]: value };
        setParameterIssues(validateReportParameterValues(report, next));
        return next;
      })} />)}<Button size="sm" disabled={reportRunning || !engineReady} onClick={handleApply}><Play className="h-4 w-4" /> Apply</Button>{parameterIssues.some((issue) => !issue.parameterKey) && <div role="alert" className="basis-full text-xs text-destructive">{parameterIssues.filter((issue) => !issue.parameterKey).map((issue) => issue.message).join(" ")}</div>}</div>}
    </div>}
    <div className="relative flex min-h-0 flex-1">
      {workspaceView === "datasets" ? <div id="report-datasets-panel" role="tabpanel" aria-labelledby="report-datasets-tab" className="min-h-0 min-w-0 flex-1">
        <ReportDatasetsView
          key={datasetEditorResetKey}
          report={report}
          results={results}
          appliedValues={appliedValues}
          running={reportRunning}
          engineReady={engineReady}
          canEdit={!readerMode}
          editRequestId={datasetEditorRequest}
          onEditRequestHandled={() => setDatasetEditorRequest(null)}
          onTestDataset={testReportDataset}
          onApplyDataset={applyReportDataset}
          onDirtyChange={setDatasetEditorDirty}
          onRunDataset={(datasetId) => {
            const existing = results[datasetId];
            setRunFailureNotice(null);
            void runDatasets(report, appliedValues, new Set([datasetId]), undefined, existing?.table ? "refresh" : "load");
          }}
          onOpenSql={(datasetId) => {
            const dataset = report.datasets.find((candidate) => candidate.id === datasetId);
            if (dataset) openDatasetInEditor(dataset);
          }}
        />
      </div> : <div id="report-view-panel" role="tabpanel" aria-labelledby="report-view-tab" className="flex-1 min-w-0 overflow-y-auto report-canvas p-3">
        <div ref={containerRef} className="min-h-full min-w-0">
        <div className="print-only hidden mb-4"><h1 className="text-2xl font-bold">{report.title}</h1><p className="text-sm text-muted-foreground">{report.description}</p></div>
        {report.blocks.length === 0 ? <div className="h-full flex items-center justify-center"><div className="text-center"><FilePlus2 className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" /><p className="font-medium">Start with a request</p><p className="text-sm text-muted-foreground mb-4">Open the agent and describe the report you need.</p>{!readerMode && <Button onClick={() => setAgentOpen(true)}><Sparkles className="h-4 w-4" /> Open report agent</Button>}</div></div> : mounted && <div className="report-grid-stack relative" style={{ paddingTop: REPORT_GRID_TOP_PADDING }}>
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
                  <span className={`truncate font-semibold leading-tight ${titleSize}`}>{interpolateReportText(box.group.title, report, appliedValues)}</span>
                  {box.group.description && <span className="hidden truncate text-xs font-normal opacity-70 sm:inline">{interpolateReportText(box.group.description, report, appliedValues)}</span>}
                </div>
              </div>;
            })}
          </div>
          <ResponsiveGridLayout className="relative z-10" width={width} breakpoints={{ lg: 768, sm: 0 }} cols={{ lg: 12, sm: 1 }} layouts={layouts} rowHeight={REPORT_GRID_ROW_HEIGHT} margin={[REPORT_GRID_MARGIN, REPORT_GRID_MARGIN]} compactor={(report.groups?.length ?? 0) > 0 ? noCompactor : undefined} dragConfig={{ enabled: !readerMode && !blockEditor, handle: ".report-drag-handle" }} resizeConfig={{ enabled: !readerMode && !blockEditor }} onLayoutChange={(layout) => { if (!readerMode && !blockEditor && width >= 768) updateLayout(layout); }}>
          {report.blocks.map((block) => {
            const result = block.type === "markdown" ? null : results[block.datasetId];
            const dataset = block.type === "markdown" ? null : report.datasets.find((candidate) => candidate.id === block.datasetId);
            const displayBlockTitle = block.title ? interpolateReportText(block.title, report, appliedValues) : undefined;
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
                  ? (result.errorCode === "rate_limited" ? "Refresh delayed · showing earlier data" : "Refresh failed · showing earlier data")
                  : result?.status === "blocked"
                    ? (hasData ? "Refresh blocked · showing earlier data" : "Refresh blocked")
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
            const reportGroup = block.groupId ? (report.groups ?? []).find((group) => group.id === block.groupId) : undefined;
            const selectedForEditing = !readerMode && selectedBlockId === block.id;
            const openTargetedAgent = () => {
              if (!discardBlockEditor()) return;
              if (agentTargetBlockId !== block.id) resetAgentConversation();
              setSelectedBlockId(block.id);
              setAgentTargetBlockId(block.id);
              setInspectorOpen(false);
              setAgentOpen(true);
              setAgentPrompt(`Update “${block.title || reportBlockLabel(block.type)}”: `);
            };
            return <div key={block.id} style={gridStyle} data-testid={`report-block-${block.id}`} data-report-group={block.groupId} data-report-tone={resolvedAppearance.tone} data-report-emphasis={resolvedAppearance.emphasis} aria-busy={pending || narrativePending} tabIndex={readerMode ? undefined : 0} aria-label={readerMode ? undefined : `${displayBlockTitle || reportBlockLabel(block.type)} report block`} onClick={() => { if (!readerMode) setSelectedBlockId(block.id); }} onKeyDown={(event) => { if (!readerMode && event.key === "Enter" && event.target === event.currentTarget) { event.preventDefault(); openBlockEditor(block); } }} className={`group relative rounded-lg border shadow-sm overflow-hidden flex flex-col print:shadow-none ${appearanceStyle[resolvedAppearance.emphasis]} ${selectedForEditing ? "ring-2 ring-primary ring-offset-1" : ""}`}>
              {reportGroup && <div className="print-only hidden border-b px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{interpolateReportText(reportGroup.title, report, appliedValues)}</div>}
              {showBlockHeader && <div data-testid={`report-block-header-${block.id}`} className={`report-drag-handle px-3 py-2 border-b flex items-center gap-2 text-sm font-medium ${readerMode ? "cursor-default" : "cursor-move"}`}>
                <span className="truncate">{block.type === "markdown" ? markdownTitle : displayBlockTitle || reportBlockLabel(block.type)}</span>
                {resolvedAppearance.label && <span data-testid={`report-block-status-${block.id}`} title={resolvedAppearance.label} className="inline-flex min-w-0 max-w-[45%] items-center gap-1.5 rounded-full border border-current/15 bg-background/55 px-2 py-0.5 text-[10px] font-medium"><span className={`h-1.5 w-1.5 shrink-0 rounded-full ${appearanceStyle.dot}`} /><span className="truncate">{resolvedAppearance.label}</span></span>}
                <div className="flex-1" />
                <div className="report-authoring-control flex items-center gap-2" onMouseDown={(event) => event.stopPropagation()}>
                  {!readerMode && <div data-testid={`report-edit-actions-${block.id}`} className={`flex items-center gap-0.5 overflow-hidden transition-all ${selectedForEditing ? "max-w-44 opacity-100" : "max-w-0 opacity-0 group-hover:max-w-44 group-hover:opacity-100 group-focus-within:max-w-44 group-focus-within:opacity-100"}`}>
                    <button type="button" className="min-h-6 min-w-6 rounded px-1.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Edit ${displayBlockTitle || reportBlockLabel(block.type)}`} title="Edit block" onClick={(event) => { event.stopPropagation(); openBlockEditor(block); }}>Edit</button>
                    <button type="button" className="min-h-6 min-w-6 rounded px-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Ask AI about ${displayBlockTitle || reportBlockLabel(block.type)}`} title="Ask AI about this block" onClick={(event) => { event.stopPropagation(); openTargetedAgent(); }}>AI</button>
                    <button type="button" className="min-h-6 min-w-6 rounded px-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Duplicate ${displayBlockTitle || reportBlockLabel(block.type)}`} title="Duplicate block" onClick={(event) => { event.stopPropagation(); copyBlock(block); }}>Copy</button>
                    <button type="button" className="min-h-6 min-w-6 rounded px-1 text-[11px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive" aria-label={`Delete ${displayBlockTitle || reportBlockLabel(block.type)}`} title="Delete block" onClick={(event) => { event.stopPropagation(); removeBlock(block); }}>×</button>
                  </div>}
                  {datasetStatusLabel && <span
                    data-testid={`report-dataset-status-${block.id}`}
                    className={`inline-flex items-center gap-1 text-[10px] font-normal ${result?.status === "error" ? "text-destructive" : result?.status === "blocked" ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground"}`}
                    title={narrativeState?.status === "error" ? narrativeState.error : result?.error}
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
              {!readerMode && !showBlockHeader && <div className={`report-authoring-control absolute right-1 top-1 z-20 flex items-center rounded-md border bg-background/90 shadow-sm transition-opacity group-focus-within:opacity-100 ${selectedForEditing ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`} onMouseDown={(event) => event.stopPropagation()}><button type="button" className="rounded px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Edit ${displayBlockTitle || "text block"}`} onClick={(event) => { event.stopPropagation(); openBlockEditor(block); }}>Edit</button><button type="button" className="rounded px-1 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Ask AI about ${displayBlockTitle || "text block"}`} onClick={(event) => { event.stopPropagation(); openTargetedAgent(); }}>AI</button><button type="button" className="rounded px-1 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Duplicate ${displayBlockTitle || "text block"}`} onClick={(event) => { event.stopPropagation(); copyBlock(block); }}>Copy</button><button type="button" className="rounded px-1 py-1 text-[11px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive" aria-label={`Delete ${displayBlockTitle || "text block"}`} onClick={(event) => { event.stopPropagation(); removeBlock(block); }}>×</button><div data-testid={`report-block-drag-${block.id}`} title="Drag text block" className="report-drag-handle cursor-move rounded p-1 text-muted-foreground/50 hover:bg-muted hover:text-foreground"><GripVertical className="h-3.5 w-3.5" /></div></div>}
              <div className={`relative flex-1 min-h-0 ${block.type === "sparkline" ? "p-2" : !showBlockHeader && block.type === "markdown" ? "p-3 pr-8" : "p-3"} ${visualBlock || block.type === "sparkline" || block.type === "perspective" || block.type === "map" ? "overflow-hidden" : "overflow-auto"}`}>{block.type === "markdown" ? <ChatMarkdown content={interpolateReportText(block.markdown, report, appliedValues)} /> : block.type === "ai_narrative" && block.snapshot ? <ReportAiNarrative block={block} state={narrativeState} onGenerate={() => void regenerateNarrative(block)} /> : result?.error && !result.table ? <div className="h-full flex flex-col items-center justify-center gap-3 text-center"><div className={result.status === "blocked" ? "text-xs text-amber-700 dark:text-amber-300" : "text-xs text-destructive"}>{result.error}</div>{result.errorDetails && <details className="max-w-full text-left text-[10px] text-muted-foreground"><summary className="cursor-pointer text-center">Technical details</summary><div className="mt-1 max-h-20 overflow-auto font-mono">{result.errorDetails}</div></details>}<Button size="sm" variant="outline" onClick={runFullReport}><Play className="h-3.5 w-3.5" /> Run report again</Button></div> : !result?.table && pending ? <div data-testid={`report-dataset-loading-${block.id}`} className="h-full flex flex-col items-center justify-center gap-2 text-center"><Loader2 className={`h-5 w-5 text-primary ${result?.status === "running" ? "animate-spin" : "opacity-50"}`} /><p className="text-xs text-muted-foreground">{result?.status === "queued" ? "Waiting to load data…" : "Loading data…"}</p></div> : !result?.table ? <div className="h-full flex flex-col items-center justify-center gap-3 text-center"><p className="text-xs text-muted-foreground">This report has not loaded its data yet.</p><Button size="sm" onClick={runFullReport}><Play className="h-4 w-4" /> Run report</Button></div> : block.type === "ai_narrative" ? <ReportAiNarrative block={block} state={narrativeState} onGenerate={() => void regenerateNarrative(block)} /> : block.type === "table" ? (() => { const columns = block.columns ?? result.table.schema.fields.map((field: any) => field.name); const pageSize = block.pageSize ?? 50; return <QueryResultTable columns={columns} rows={reportDisplayRows(result.table, columns, pageSize)} rowCount={result.rows.length} showing={Math.min(result.rows.length, pageSize)} />; })() : block.type === "kpi" ? <ReportKpi block={block} row={result.rows[0]} formatValue={formatKpi} /> : block.type === "sparkline" ? <ReportSparkline block={block} rows={result.rows} formatValue={formatKpi} /> : visualBlock ? <ReportChart block={visualBlock} rows={result.rows} onViewChange={setReportChartView} /> : block.type === "map" ? <ReportMap block={block} rows={reportMapRows(result.table, block.geometryColumn)} /> : block.type === "perspective" ? <ReportPerspective table={result.table} config={block.config} onConfig={(config) => { if (!readerMode) setDraft((current) => current ? { ...current, blocks: current.blocks.map((b) => b.id === block.id && b.type === "perspective" ? { ...b, config } : b) } : current); }} /> : null}</div>
              {(block.caption || block.source) && <div data-testid={`report-note-${block.id}`} className="px-3 pb-2 text-[10px] leading-snug text-muted-foreground">
                {block.caption && <span>{interpolateReportText(block.caption, report, appliedValues)}</span>}{block.caption && block.source && <span> · </span>}{block.source && <span>Source: {interpolateReportText(block.source, report, appliedValues)}</span>}
              </div>}
            </div>;
          })}
          </ResponsiveGridLayout>
        </div>}
        </div>
      </div>}
      {!readerMode && (blockEditor || agentOpen || inspectorOpen) && <aside className="report-authoring-control relative z-[1000] flex min-h-0 w-[min(42vw,520px)] min-w-[340px] flex-col border-l bg-card max-sm:fixed max-sm:inset-0 max-sm:w-full max-sm:min-w-0">
        {blockEditor ? <ReportBlockEditor
          key={blockEditor.block.id}
          block={blockEditor.block}
          isNew={blockEditor.isNew}
          datasets={draft.datasets}
          groups={draft.groups ?? []}
          parameters={draft.parameters}
          columnsByDataset={columnsByDataset}
          errors={editorValidationErrors}
          applying={blockEditorApplying}
          onChange={(nextBlock) => {
            if (blockApplyBusyRef.current) return;
            const current = blockEditor.block;
            if (current.type === "ai_narrative" && nextBlock.type === "ai_narrative" && (current.datasetId !== nextBlock.datasetId || current.instruction !== nextBlock.instruction || JSON.stringify(current.columns) !== JSON.stringify(nextBlock.columns) || current.maxRows !== nextBlock.maxRows)) delete nextBlock.snapshot;
            setBlockEditor((editor) => editor ? { ...editor, block: nextBlock } : editor);
            setBlockEditorErrors([]);
          }}
          onApply={() => void applyBlockEditor()}
          onCancel={() => { discardBlockEditor(); }}
          onRunDataset={(datasetId) => void runDatasets(draft, appliedValues, new Set([datasetId]))}
          onEditDataset={editBlockDataset}
        /> : <>
          <div className="flex items-center border-b"><button className={`px-4 py-2 text-sm ${agentOpen ? "border-b-2 border-primary" : ""}`} onClick={() => { setAgentOpen(true); setInspectorOpen(false); }}>Edit with AI</button><button className={`px-4 py-2 text-sm ${inspectorOpen ? "border-b-2 border-primary" : ""}`} onClick={() => { setInspectorOpen(true); setAgentOpen(false); setSourceText(exportReportJson(draft)); }}>Report JSON</button><div className="flex-1" />{agentOpen && agentConversation.length > 0 && <Button size="sm" variant="ghost" disabled={agentBusy} onClick={resetAgentConversation}>New conversation</Button>}<button className="p-2" onClick={() => { setAgentOpen(false); setInspectorOpen(false); }}><X className="h-4 w-4" /></button></div>
          {agentOpen ? <><div ref={agentThreadRef} data-testid="report-agent-thread" className="flex-1 overflow-y-auto p-4 text-sm"><p className="text-muted-foreground mb-4">{agentTargetBlockId ? `Describe the change to ${draft.blocks.find((block) => block.id === agentTargetBlockId)?.title || "the selected block"}.` : "Describe the report or revision."} The agent edits a draft; nothing is saved until you accept it.</p><div className="space-y-5">{agentConversation.map((message) => <div key={message.id} data-role={message.role}>{message.role === "user" ? <ChatMessageUser content={message.content ?? ""} /> : <ChatMessageAssistant blocks={message.blocks ?? []} isStreaming={message.isStreaming} usage={message.usage} model={settings.aiModel} onCancel={message.isStreaming ? () => abortRef.current?.abort() : undefined} />}</div>)}</div></div><div className="p-3 border-t"><textarea className="w-full min-h-24 rounded-md border bg-background p-2 text-sm" value={agentPrompt} onChange={(e) => setAgentPrompt(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void runAgent(); } }} placeholder="Build a monthly sales report with a date range and region filter…" /><div className="flex justify-end mt-2">{agentBusy ? <Button variant="destructive" size="sm" onClick={() => abortRef.current?.abort()}>Stop</Button> : <Button size="sm" disabled={!agentPrompt.trim()} onClick={runAgent}><Sparkles className="h-4 w-4" /> Send</Button>}</div></div></> : <><textarea className="flex-1 min-h-0 resize-none bg-background p-3 font-mono text-xs" spellCheck={false} value={sourceText} onChange={(e) => setSourceText(e.target.value)} />{sourceError && <div className="px-3 py-2 text-xs text-destructive border-t">{sourceError}</div>}<div className="p-3 border-t flex justify-end"><Button size="sm" onClick={() => { try { const parsed = importReportJson(sourceText); setDraft(parsed); setSourceError(null); } catch (e) { setSourceError(e instanceof Error ? e.message : String(e)); } }}>Preview source</Button></div></>}
        </>}
      </aside>}
    </div>
    {promotionDialog}
  </div>;
}
