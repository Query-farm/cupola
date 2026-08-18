import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ResponsiveGridLayout, useContainerWidth, type Layout, type ResponsiveLayouts } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import { ArrowLeft, BarChart3, Bot, Check, Download, FileJson, FilePlus2, Loader2, Play, Plus, Printer, Save, Share2, Sparkles, Trash2, X } from "lucide-react";
import type { Table as ArrowTable } from "@query-farm/apache-arrow";
import type { CatalogData } from "@/lib/service";
import { engine } from "@/lib/shell-bridge";
import { decodeArrowBuffer, tableToRows } from "@/lib/duckdb-query";
import { ChatMarkdown } from "@/components/chat/ChatMarkdown";
import { ChatMessageAssistant, type ContentBlock, type ToolCallEntry } from "@/components/chat/ChatMessageAssistant";
import { ChatMessageUser } from "@/components/chat/ChatMessageUser";
import { QueryResultTable } from "@/components/chat/QueryResultTable";
import { ReportMap } from "@/components/reports/ReportMap";
import { embedChart, downloadPNG, downloadSVG, type VegaView } from "@/components/chat/chart-embed";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useSettings } from "@/lib/settings";
import { runAgentTurn, executeListTables, executeDescribeTable, type MessageParam, type Tool } from "@/lib/ai-agent";
import { executeRunSql } from "@/lib/ai-tool-executor";
import { QueryResultCache } from "@/lib/query-results";
import { DEFAULT_AI_MAX_TOKENS } from "@/lib/ai/model-limits";
import { toolInputLabel } from "@/lib/ai/tool-labels";
import { exportResult, safeFileStem, triggerDownload } from "@/lib/editor/result-export";
import { consumeReportPromotion, type ReportPromotion } from "@/lib/reports/events";
import { reportDisplayRows, reportMapRows } from "@/lib/reports/display";
import { validateReportResultColumns } from "@/lib/reports/execution";
import { compileReportQuery } from "@/lib/reports/parameters";
import { buildShareReportUrl, clearSharedReport, consumeSharedReport } from "@/lib/reports/share";
import { deleteReport, exportReportJson, getStoredReport, importReportJson, listReports, restoreReportRevision, saveReport } from "@/lib/reports/store";
import { cloneReport, createEmptyReport, newReportId, type ReportBlock, type ReportDataset, type ReportDocumentV1, type ReportParameter, type ReportParameterValue } from "@/lib/reports/types";
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
  running: boolean;
  error?: string;
  fetchedAt?: number;
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

const REPORT_TOOLS: Tool[] = [
  { name: "list_tables", description: "List the connected catalog's schemas, tables, and views.", input_schema: { type: "object", properties: {} } },
  { name: "describe_table", description: "Describe a table before writing SQL for it.", input_schema: { type: "object", properties: { catalog: { type: "string" }, schema: { type: "string" }, table: { type: "string" } }, required: ["schema", "table"] } },
  { name: "preview_sql", description: "Run one read-only SQL query to verify columns and sample results.", input_schema: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] } },
  { name: "replace_report_draft", description: "Replace and execute the complete report draft. Preserve schemaVersion=1 and all stable IDs when editing. Returns each dataset's columns, row count, sample rows, or execution error so you can correct the draft before finishing.", input_schema: { type: "object", properties: { report: { type: "object" }, summary: { type: "string" } }, required: ["report", "summary"] } },
];

function defaultValues(report: ReportDocumentV1): Record<string, ReportParameterValue> {
  return Object.fromEntries(report.parameters.map((p) => [p.key, structuredClone(p.defaultValue)]));
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

function ReportChart({ block, rows }: { block: Extract<ReportBlock, { type: "chart" }>; rows: Record<string, any>[] }) {
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
        else viewRef.current = view;
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
    return () => { disposed = true; renderVersion++; cancelAnimationFrame(frame); observer.disconnect(); viewRef.current?.finalize(); viewRef.current = null; };
  }, [block.spec, rows]);
  return <div className="h-full flex flex-col min-h-0">
    <div className="flex justify-end gap-1 report-authoring-control">
      <button className="text-[10px] text-muted-foreground hover:text-foreground" onClick={() => viewRef.current && downloadPNG(viewRef.current, block.title || "chart")}>PNG</button>
      <button className="text-[10px] text-muted-foreground hover:text-foreground" onClick={() => viewRef.current && downloadSVG(viewRef.current, block.title || "chart")}>SVG</button>
    </div>
    {error ? <div className="text-xs text-destructive">{error}</div> : <div ref={elRef} data-testid="report-chart-container" className="flex-1 min-h-0 w-full overflow-hidden" />}
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
  const [pendingPromotion, setPendingPromotion] = useState<ReportPromotion | null>(null);
  const [shareStatus, setShareStatus] = useState<string | null>(null);
  const [revisionOptions, setRevisionOptions] = useState<ReportDocumentV1[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const agentMessagesRef = useRef<MessageParam[]>([]);
  const agentThreadRef = useRef<HTMLDivElement>(null);
  const runGeneration = useRef(0);
  const resultCache = useRef(new QueryResultCache());
  const { width, containerRef, mounted } = useContainerWidth({ initialWidth: 1000 });

  const reload = useCallback(async () => setReports(await listReports()), []);
  useEffect(() => { reload(); const listener = () => reload(); window.addEventListener("cupola:reports-changed", listener); return () => window.removeEventListener("cupola:reports-changed", listener); }, [reload]);
  useEffect(() => { onBusyChange?.(agentBusy || Object.values(results).some((r) => r.running)); }, [agentBusy, results, onBusyChange]);
  useEffect(() => {
    const thread = agentThreadRef.current;
    if (thread) thread.scrollTop = thread.scrollHeight;
  }, [agentConversation, agentBusy]);

  const openReport = useCallback((report: ReportDocumentV1, initialValues?: Record<string, ReportParameterValue>, autoRun = true, persisted = true) => {
    abortRef.current?.abort();
    abortRef.current = null;
    agentMessagesRef.current = [];
    resultCache.current = new QueryResultCache();
    const copy = cloneReport(report);
    const defaults = { ...defaultValues(copy), ...initialValues };
    setSelected(persisted ? copy : null); setDraft(copy); setValues(defaults); setAppliedValues(defaults); setResults({}); setSourceText(exportReportJson(copy)); setSourceError(null); setAgentSummary(null); setAgentConversation([]); setAgentPrompt(""); setAgentBusy(false);
    void getStoredReport(copy.id).then((stored) => setRevisionOptions(stored?.revisions ?? []));
    if (autoRun) setTimeout(() => runDatasets(copy, defaults), 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    consumeSharedReport().then((shared) => { if (shared) { openReport(shared.report, shared.values, false, false); clearSharedReport(); setShareStatus("Shared report opened for review. Save and run it when ready."); } });
  }, [openReport]);

  useEffect(() => {
    const consume = () => { const promotion = consumeReportPromotion(); if (promotion) setPendingPromotion(promotion); };
    consume(); window.addEventListener("cupola:promote-report", consume); return () => window.removeEventListener("cupola:promote-report", consume);
  }, []);

  const runDatasets = useCallback(async (report: ReportDocumentV1, runValues: Record<string, ReportParameterValue>, onlyIds?: Set<string>): Promise<DatasetRunSummary[]> => {
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
    const generation = ++runGeneration.current;
    const summaries: DatasetRunSummary[] = [];
    setResults((prev) => ({ ...prev, ...Object.fromEntries(datasets.map((d) => [d.id, { ...(prev[d.id] ?? { table: null, rows: [] }), running: true, error: undefined }])) }));
    for (const dataset of datasets) {
      if (generation !== runGeneration.current) return summaries;
      try {
        const readErrors = validateReadOnlySql(dataset.sql);
        if (readErrors.length) throw new Error(readErrors.join(" "));
        const compiled = compileReportQuery(dataset.sql, report, runValues);
        const response = await engine.queryPrepared(compiled.sql, compiled.params);
        if (!response.ok || !response.arrowBuffers?.[0]) throw new Error(response.error || "Query returned no result.");
        const table = decodeArrowBuffer(response.arrowBuffers[0]);
        const rows = tableToRows(table);
        setResults((prev) => ({ ...prev, [dataset.id]: { table, rows, running: false, fetchedAt: Date.now() } }));
        summaries.push({ datasetId: dataset.id, name: dataset.name, ok: true, rowCount: table.numRows, columns: table.schema.fields.map((field) => field.name), sample: rows.slice(0, 3) });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setResults((prev) => ({ ...prev, [dataset.id]: { ...(prev[dataset.id] ?? { table: null, rows: [] }), running: false, error: message } }));
        summaries.push({ datasetId: dataset.id, name: dataset.name, ok: false, error: message });
      }
    }
    return summaries;
  }, []);

  const runFullReport = useCallback(() => {
    if (!draft) return;
    const nextValues = structuredClone(values);
    setAppliedValues(nextValues);
    void runDatasets(draft, nextValues);
  }, [draft, values, runDatasets]);

  const handleApply = useCallback(() => {
    if (!draft) return;
    const changed = new Set(Object.keys(values).filter((k) => JSON.stringify(values[k]) !== JSON.stringify(appliedValues[k])));
    const ids = changed.size ? new Set(draft.datasets.filter((d) => parameterTokens(d.sql).some((t) => changed.has(t) || changed.has(t.replace(/_(?:start|end)$/, "")))).map((d) => d.id)) : undefined;
    setAppliedValues(structuredClone(values));
    runDatasets(draft, values, ids);
  }, [draft, values, appliedValues, runDatasets]);

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
    const system = `You are Cupola's report-authoring agent. Build and revise a declarative report JSON document. Never add JavaScript. Inspect every table before using it. SQL datasets must be one read-only SELECT/VALUES/WITH query. Parameter references use $key, date ranges use $key_start/$key_end, and multi-select values appear in IN ($key). Supported blocks are markdown, kpi, table, chart, perspective, and map. Charts are Vega-Lite v5 specs without data, datasets, url, href, or src. Maps are declarative Leaflet blocks: set type=\"map\", datasetId, and either geometryColumn for WKB/GeoJSON or both latitudeColumn and longitudeColumn. Maps may also set labelColumn, colorColumn, tooltipColumns, basemap (\"openstreetmap\" or \"none\"), palette, and style. Use a 12-column layout. Always finish by calling replace_report_draft with the complete document and a concise summary. That tool executes every dataset. If it returns an execution error, correct the report and call replace_report_draft again so the user receives a populated, working report.\n\nCurrent report:\n${JSON.stringify(draft)}`;
    try {
      await runAgentTurn(settings.anthropicApiKey, settings.aiModel, agentMessagesRef.current, system, async (name, input) => {
        if (name === "list_tables") return executeListTables(catalogData);
        if (name === "describe_table") return executeDescribeTable(catalogData, input.schema, input.table);
        if (name === "preview_sql") {
          const errors = validateReadOnlySql(String(input.sql ?? "")); if (errors.length) throw new Error(errors.join(" "));
          if (!engine.query) throw new Error("DuckDB is not ready.");
          return executeRunSql(input.sql, { query: engine.query, resultCache: resultCache.current });
        }
        if (name === "replace_report_draft") {
          const proposed = input.report as ReportDocumentV1;
          const errors = validateReport(proposed); if (errors.length) throw new Error(errors.join("\n"));
          const proposedValues = defaultValues(proposed);
          setDraft(cloneReport(proposed)); setSourceText(exportReportJson(proposed)); setValues(proposedValues); setAppliedValues(proposedValues); setResults({});
          const execution = await runDatasets(proposed, proposedValues);
          const failures = execution.filter((result) => !result.ok);
          const blockErrors = validateReportResultColumns(proposed, execution);
          const summary = String(input.summary ?? "Draft updated");
          const needsCorrection = failures.length > 0 || blockErrors.length > 0;
          setAgentSummary(needsCorrection ? `${summary} The draft needs correction.` : `${summary} Data loaded.`);
          return JSON.stringify({ ok: !needsCorrection, message: needsCorrection ? "The draft ran, but has dataset or block-column errors. Correct them and replace the draft again." : "Draft validated and all datasets executed. The report is populated for user review.", datasets: execution, blockErrors });
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
      <div className="flex items-center justify-between mb-5"><div><h1 className="text-xl font-semibold">Reports</h1><p className="text-sm text-muted-foreground">Reusable, agent-authored analysis against your attached data.</p></div><div className="flex gap-2"><label className="inline-flex"><input type="file" accept="application/json,.json" className="sr-only" onChange={async (e) => { const file = e.target.files?.[0]; if (!file) return; try { openReport(importReportJson(await file.text()), undefined, false, false); setShareStatus("Imported report opened for review."); } catch (err) { setShareStatus(err instanceof Error ? err.message : String(err)); } }} /><span className="inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm cursor-pointer hover:bg-muted"><FileJson className="h-4 w-4" /> Import</span></label><Button onClick={createNew}><Plus className="h-4 w-4" /> New report</Button></div></div>
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
  const layouts: ResponsiveLayouts<"lg" | "sm"> = {
    lg: draft.blocks.map((b) => ({ i: b.id, ...b.layout })),
    sm: [...draft.blocks].sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x).map((b, i) => ({ i: b.id, x: 0, y: i * b.layout.h, w: 1, h: b.layout.h })),
  };

  return <div className="h-full flex flex-col bg-background" data-testid="reports-workspace">
    <div className="report-authoring-control flex items-center gap-2 px-3 py-2 border-b bg-card overflow-x-auto">
      <Button size="sm" variant="ghost" onClick={() => { setDraft(null); setSelected(null); setResults({}); }}><ArrowLeft className="h-4 w-4" /> Library</Button>
      <Input className="h-8 min-w-48 max-w-sm font-medium" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
      <div className="flex-1" />
      <Button size="sm" variant="outline" onClick={() => setAgentOpen((v) => !v)}><Bot className="h-4 w-4" /> Agent</Button>
      {revisionOptions.length > 0 && <select className="h-8 rounded-md border bg-background px-2 text-xs" defaultValue="" aria-label="Restore report revision" onChange={async (e) => { const revision = Number(e.target.value); if (!revision) return; const restored = await restoreReportRevision(draft.id, revision); openReport(restored, undefined, false); }}><option value="">History</option>{revisionOptions.slice().reverse().map((r) => <option key={r.revision} value={r.revision}>Restore revision {r.revision}</option>)}</select>}
      <Button size="sm" variant="outline" onClick={() => { setInspectorOpen((v) => !v); setSourceText(exportReportJson(draft)); }}><FileJson className="h-4 w-4" /> Source</Button>
      <Button size="sm" data-testid="reports-run" disabled={reportErrors.length > 0 || Object.values(results).some((result) => result.running)} onClick={runFullReport}>{Object.values(results).some((result) => result.running) ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} {Object.values(results).some((result) => result.running) ? "Running report…" : "Run report"}</Button>
      <Button size="sm" variant="outline" onClick={() => window.print()}><Printer className="h-4 w-4" /> Print</Button>
      <Button size="sm" variant="outline" onClick={() => triggerDownload(new Blob([exportReportJson(draft)], { type: "application/json" }), `${safeFileStem(draft.title)}.cupola-report.json`)}><Download className="h-4 w-4" /> JSON</Button>
      <Button size="sm" variant="outline" onClick={async () => { try { await navigator.clipboard.writeText(await buildShareReportUrl(draft, { serviceUrl, values: appliedValues })); setShareStatus("Share link copied."); } catch (e) { setShareStatus(e instanceof Error ? e.message : String(e)); } }}><Share2 className="h-4 w-4" /> Share</Button>
      <Button size="sm" disabled={!dirty || reportErrors.length > 0} onClick={acceptDraft}><Save className="h-4 w-4" /> Accept & save</Button>
    </div>
    {(!isCompatible(draft) || reportErrors.length > 0 || shareStatus || agentSummary) && <div className="px-4 py-2 border-b text-xs space-y-1">{!isCompatible(draft) && <div className="text-amber-700">Missing required catalogs: {draft.requiredSources.filter((s) => !compatibleCatalogs.has(s.catalog)).map((s) => s.catalog).join(", ")}</div>}{reportErrors.length > 0 && <div className="text-destructive">{reportErrors.join(" ")}</div>}{shareStatus && <div>{shareStatus}</div>}{agentSummary && <div className="text-primary"><Check className="inline h-3 w-3 mr-1" />Agent draft: {agentSummary}</div>}</div>}
    {draft.parameters.length > 0 && <div className="report-parameters report-authoring-control flex flex-wrap items-end gap-3 px-4 py-3 border-b bg-muted/20">{draft.parameters.map((p) => <ParameterInput key={p.id} parameter={p} value={values[p.key] ?? p.defaultValue} options={optionValues(p)} onChange={(value) => setValues((v) => ({ ...v, [p.key]: value }))} />)}<Button size="sm" onClick={handleApply}><Play className="h-4 w-4" /> Apply</Button></div>}
    <div className="flex-1 min-h-0 flex">
      <div ref={containerRef} className="flex-1 min-w-0 overflow-y-auto report-canvas p-3">
        <div className="print-only hidden mb-4"><h1 className="text-2xl font-bold">{draft.title}</h1><p className="text-sm text-muted-foreground">{draft.description}</p></div>
        {draft.blocks.length === 0 ? <div className="h-full flex items-center justify-center"><div className="text-center"><FilePlus2 className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" /><p className="font-medium">Start with a request</p><p className="text-sm text-muted-foreground mb-4">Open the agent and describe the report you need.</p><Button onClick={() => setAgentOpen(true)}><Sparkles className="h-4 w-4" /> Open report agent</Button></div></div> : mounted && <ResponsiveGridLayout width={width} breakpoints={{ lg: 768, sm: 0 }} cols={{ lg: 12, sm: 1 }} layouts={layouts} rowHeight={56} margin={[12, 12]} dragConfig={{ handle: ".report-drag-handle" }} resizeConfig={{ enabled: true }} onLayoutChange={(layout) => { if (width >= 768) updateLayout(layout); }}>
          {draft.blocks.map((block) => {
            const result = block.type === "markdown" ? null : results[block.datasetId];
            return <div key={block.id} className="rounded-lg border bg-card shadow-sm overflow-hidden flex flex-col print:shadow-none">
              <div className="report-drag-handle report-authoring-control cursor-move px-3 py-2 border-b flex items-center gap-2 text-sm font-medium"><span className="truncate">{block.title || (block.type === "markdown" ? "Text" : block.type[0].toUpperCase() + block.type.slice(1))}</span><div className="flex-1" />{result?.running && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{result?.fetchedAt && <span className="text-[10px] text-muted-foreground">{new Date(result.fetchedAt).toLocaleTimeString()}</span>}</div>
              <div className={`flex-1 min-h-0 p-3 ${block.type === "chart" || block.type === "perspective" || block.type === "map" ? "overflow-hidden" : "overflow-auto"}`}>{block.type === "markdown" ? <ChatMarkdown content={block.markdown} /> : result?.error ? <div className="h-full flex flex-col items-center justify-center gap-3 text-center"><div className="text-xs text-destructive">{result.error}</div><Button size="sm" variant="outline" onClick={runFullReport}><Play className="h-3.5 w-3.5" /> Run report again</Button></div> : !result?.table ? <div className="h-full flex flex-col items-center justify-center gap-3 text-center"><p className="text-xs text-muted-foreground">This report has not loaded its data yet.</p><Button size="sm" onClick={runFullReport}><Play className="h-3.5 w-3.5" /> Run report</Button></div> : block.type === "table" ? <div><div className="report-authoring-control flex justify-end gap-2 mb-1"><button className="text-[10px]" onClick={() => exportResult(result.table!, "csv", block.title || "report-table")}>CSV</button><button className="text-[10px]" onClick={() => exportResult(result.table!, "excel", block.title || "report-table")}>XLSX</button></div>{(() => { const columns = block.columns ?? result.table.schema.fields.map((field: any) => field.name); const pageSize = block.pageSize ?? 50; return <QueryResultTable columns={columns} rows={reportDisplayRows(result.table, columns, pageSize)} rowCount={result.rows.length} showing={Math.min(result.rows.length, pageSize)} />; })()}</div> : block.type === "kpi" ? <div className="h-full flex flex-col justify-center items-center"><div className="text-3xl font-semibold">{formatKpi(result.rows[0]?.[block.valueColumn], block.format)}</div><div className="text-xs text-muted-foreground">{block.labelColumn ? String(result.rows[0]?.[block.labelColumn] ?? "") : block.title}</div></div> : block.type === "chart" ? <ReportChart block={block} rows={result.rows} /> : block.type === "map" ? <ReportMap block={block} rows={reportMapRows(result.table, block.geometryColumn)} /> : <ReportPerspective table={result.table} config={block.config} onConfig={(config) => setDraft((current) => current ? { ...current, blocks: current.blocks.map((b) => b.id === block.id && b.type === "perspective" ? { ...b, config } : b) } : current)} />}</div>
            </div>;
          })}
        </ResponsiveGridLayout>}
      </div>
      {(agentOpen || inspectorOpen) && <aside className="report-authoring-control w-[min(42vw,520px)] min-w-[340px] border-l bg-card flex flex-col min-h-0">
        <div className="flex items-center border-b"><button className={`px-4 py-2 text-sm ${agentOpen ? "border-b-2 border-primary" : ""}`} onClick={() => { setAgentOpen(true); setInspectorOpen(false); }}>Agent</button><button className={`px-4 py-2 text-sm ${inspectorOpen ? "border-b-2 border-primary" : ""}`} onClick={() => { setInspectorOpen(true); setAgentOpen(false); setSourceText(exportReportJson(draft)); }}>Source</button><div className="flex-1" />{agentOpen && agentConversation.length > 0 && <Button size="sm" variant="ghost" disabled={agentBusy} onClick={resetAgentConversation}>New conversation</Button>}<button className="p-2" onClick={() => { setAgentOpen(false); setInspectorOpen(false); }}><X className="h-4 w-4" /></button></div>
        {agentOpen ? <><div ref={agentThreadRef} data-testid="report-agent-thread" className="flex-1 overflow-y-auto p-4 text-sm"><p className="text-muted-foreground mb-4">Describe the report or revision. The agent edits a draft; nothing is saved until you accept it.</p><div className="space-y-5">{agentConversation.map((message) => <div key={message.id} data-role={message.role}>{message.role === "user" ? <ChatMessageUser content={message.content ?? ""} /> : <ChatMessageAssistant blocks={message.blocks ?? []} isStreaming={message.isStreaming} usage={message.usage} model={settings.aiModel} onCancel={message.isStreaming ? () => abortRef.current?.abort() : undefined} />}</div>)}</div></div><div className="p-3 border-t"><textarea className="w-full min-h-24 rounded-md border bg-background p-2 text-sm" value={agentPrompt} onChange={(e) => setAgentPrompt(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void runAgent(); } }} placeholder="Build a monthly sales report with a date range and region filter…" /><div className="flex justify-end mt-2">{agentBusy ? <Button variant="destructive" size="sm" onClick={() => abortRef.current?.abort()}>Stop</Button> : <Button size="sm" disabled={!agentPrompt.trim()} onClick={runAgent}><Sparkles className="h-4 w-4" /> Send</Button>}</div></div></> : <><textarea className="flex-1 min-h-0 resize-none bg-background p-3 font-mono text-xs" spellCheck={false} value={sourceText} onChange={(e) => setSourceText(e.target.value)} />{sourceError && <div className="px-3 py-2 text-xs text-destructive border-t">{sourceError}</div>}<div className="p-3 border-t flex justify-end"><Button size="sm" onClick={() => { try { const parsed = importReportJson(sourceText); setDraft(parsed); setSourceError(null); } catch (e) { setSourceError(e instanceof Error ? e.message : String(e)); } }}>Preview source</Button></div></>}
      </aside>}
    </div>
    {promotionDialog}
  </div>;
}
