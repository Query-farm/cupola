import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Code2, Eye, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { basicChartConfigFromSpec, basicChartSpec, type BasicChartConfig } from "@/lib/reports/direct-editor";
import type { ReportBlock, ReportDataset, ReportGroup, ReportParameter } from "@/lib/reports/types";

interface Props {
  block: ReportBlock;
  isNew: boolean;
  datasets: ReportDataset[];
  groups: ReportGroup[];
  parameters: ReportParameter[];
  columnsByDataset: Record<string, string[]>;
  errors: string[];
  applying?: boolean;
  onChange: (block: ReportBlock) => void;
  onApply: () => void;
  onCancel: () => void;
  onRunDataset: (datasetId: string) => void;
  onEditDataset: (datasetId: string) => void;
}

const control = "h-8 w-full rounded-md border bg-background px-2 text-xs";
const textarea = "min-h-24 w-full rounded-md border bg-background p-2 font-mono text-xs leading-relaxed";

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return <label className="block space-y-1"><span className="block text-xs font-medium">{label}</span>{children}{hint && <span className="block text-[10px] text-muted-foreground">{hint}</span>}</label>;
}

function TextField({ label, value, onChange, placeholder }: { label: string; value?: string; onChange: (value: string) => void; placeholder?: string }) {
  return <Field label={label}><Input aria-label={label} className="h-8 text-xs" value={value ?? ""} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} /></Field>;
}

function SelectField({ label, value, options, onChange, empty = "None" }: { label: string; value?: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void; empty?: string }) {
  return <Field label={label}><select aria-label={label} className={control} value={value ?? ""} onChange={(event) => onChange(event.target.value)}><option value="">{empty}</option>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></Field>;
}

function CheckField({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />{label}</label>;
}

function JsonField({ label, value, onChange, onValidityChange }: { label: string; value: unknown; onChange: (value: any) => void; onValidityChange?: (valid: boolean) => void }) {
  const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 2));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setText(JSON.stringify(value ?? {}, null, 2)); setError(null); }, [value]);
  return <Field label={label}><textarea aria-label={label} className={textarea} spellCheck={false} value={text} onChange={(event) => {
    const next = event.target.value;
    setText(next);
    try { onChange(JSON.parse(next)); setError(null); onValidityChange?.(true); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); onValidityChange?.(false); }
  }} />{error && <p role="alert" className="text-[10px] text-destructive">{error}</p>}</Field>;
}

const formats = ["number", "currency", "percent", "text"].map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) }));
const valueModes = ["auto", "all", "none"].map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) }));

export function ReportBlockEditor({ block, isNew, datasets, groups, parameters, columnsByDataset, errors, applying = false, onChange, onApply, onCancel, onRunDataset, onEditDataset }: Props) {
  const editorRef = useRef<HTMLDivElement>(null);
  const datasetId = block.type === "markdown" ? "" : block.datasetId;
  const columns = columnsByDataset[datasetId] ?? [];
  const columnOptions = columns.map((column) => ({ value: column, label: column }));
  const patch = (values: Record<string, unknown>) => onChange({ ...block, ...values } as ReportBlock);
  const patchOptional = (key: string, value: string) => {
    const next = { ...block } as Record<string, any>;
    if (value) next[key] = value;
    else delete next[key];
    onChange(next as ReportBlock);
  };
  const patchOptionalList = (key: string, value: string, limit?: number) => {
    const values = value.split(",").map((item) => item.trim()).filter(Boolean);
    const next = { ...block } as Record<string, any>;
    if (values.length) next[key] = limit ? values.slice(0, limit) : values;
    else delete next[key];
    onChange(next as ReportBlock);
  };
  const changeDataset = (nextDatasetId: string) => {
    const next = { ...block, datasetId: nextDatasetId } as Record<string, any>;
    const nextColumns = columnsByDataset[nextDatasetId];
    if (nextColumns) {
      const available = new Set(nextColumns);
      for (const key of ["valueColumn", "headlineValueColumn", "labelColumn", "lowColumn", "highColumn", "targetColumn", "splitColumn", "facetColumn", "xColumn", "yColumn", "colorColumn", "categoryColumn", "startColumn", "endColumn", "geometryColumn", "latitudeColumn", "longitudeColumn"]) {
        if (typeof next[key] === "string" && !available.has(next[key])) delete next[key];
      }
      for (const key of ["columns", "rangeColumns", "tooltipColumns"]) {
        if (Array.isArray(next[key])) {
          const retained = next[key].filter((column: string) => available.has(column));
          if (retained.length) next[key] = retained;
          else delete next[key];
        }
      }
    }
    if (block.type === "ai_narrative") delete next.snapshot;
    onChange(next as ReportBlock);
  };
  const [chartMode, setChartMode] = useState<"basic" | "advanced">(() => block.type === "chart" && basicChartConfigFromSpec(block.spec) ? "basic" : "advanced");
  const [invalidJson, setInvalidJson] = useState<Set<string>>(() => new Set());
  const jsonValidity = (label: string) => (valid: boolean) => setInvalidJson((current) => {
    const next = new Set(current);
    if (valid) next.delete(label); else next.add(label);
    return next;
  });
  const basicChart = useMemo(() => block.type === "chart" ? basicChartConfigFromSpec(block.spec) : null, [block]);
  const parameterTokens = parameters.flatMap((parameter) => parameter.type === "date_range"
    ? [`$${parameter.key}_start`, `$${parameter.key}_end`]
    : [`$${parameter.key}`]);
  useEffect(() => {
    editorRef.current?.querySelector<HTMLElement>("input, textarea, select")?.focus();
  }, []);

  const column = (label: string, key: string, required = false) => <SelectField label={label} value={(block as any)[key]} options={columnOptions} empty={required ? "Select a column" : "None"} onChange={(value) => patchOptional(key, value)} />;
  const format = () => <SelectField label="Value format" value={(block as any).format} options={formats} empty="Automatic" onChange={(value) => patchOptional("format", value)} />;

  return <div ref={editorRef} data-testid="report-block-editor" role="region" aria-label="Report block editor" className="flex min-h-0 flex-1 flex-col" aria-busy={applying} onKeyDown={(event) => { if (event.key === "Escape" && !applying) { event.preventDefault(); onCancel(); } }}>
    <div className="flex items-center gap-2 border-b px-4 py-3"><div className="min-w-0 flex-1"><div className="text-sm font-semibold">{isNew ? "Add" : "Edit"} {block.type.replaceAll("_", " ")}</div><div className="truncate text-[10px] text-muted-foreground">Changes preview in the report until you apply them.</div></div><Button size="icon-sm" variant="ghost" aria-label="Close block editor" disabled={applying} onClick={onCancel}><X className="h-4 w-4" /></Button></div>
    <div className={`min-h-0 flex-1 space-y-5 overflow-y-auto p-4 ${applying ? "pointer-events-none opacity-70" : ""}`}>
      <section className="space-y-3"><h3 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Content</h3>
        <TextField label="Title" value={block.title} placeholder="Optional" onChange={(value) => patchOptional("title", value)} />
        <TextField label="Caption" value={block.caption} placeholder="Optional interpretive note" onChange={(value) => patchOptional("caption", value)} />
        <TextField label="Source" value={block.source} placeholder="Optional provenance" onChange={(value) => patchOptional("source", value)} />
        {parameterTokens.length > 0 && <p className="text-[10px] text-muted-foreground">Available text parameters: <code>{parameterTokens.join(", ")}</code></p>}
      </section>

      {block.type !== "markdown" && <section className="space-y-3"><h3 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Data</h3>
        <SelectField label="Dataset" value={datasetId} options={datasets.filter((dataset) => !dataset.role || dataset.role === "data").map((dataset) => ({ value: dataset.id, label: dataset.name }))} empty="Select a dataset" onChange={changeDataset} />
        {datasetId && <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={applying} onClick={() => onEditDataset(datasetId)}><Code2 className="h-3.5 w-3.5" /> Edit dataset SQL</Button>{columns.length === 0 && <Button size="sm" variant="outline" disabled={applying} onClick={() => onRunDataset(datasetId)}><Eye className="h-3.5 w-3.5" /> Run for columns</Button>}</div>}
        {datasetId && columns.length === 0 && <p className="text-[10px] text-muted-foreground">Run this dataset to populate schema-backed column selectors.</p>}
      </section>}

      <section className="space-y-3"><h3 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Block settings</h3>
        {block.type === "markdown" && <Field label="Markdown"><textarea data-testid="report-markdown-editor" className={`${textarea} min-h-48 font-sans`} value={block.markdown} onChange={(event) => patch({ markdown: event.target.value })} /></Field>}
        {block.type === "kpi" && <>{column("Value", "valueColumn", true)}{column("Label", "labelColumn")}{format()}<div className="grid grid-cols-2 gap-2">{column("Low bound", "lowColumn")}{column("High bound", "highColumn")}</div>{column("Target", "targetColumn")}<TextField label="Range label" value={block.rangeLabel} onChange={(value) => patchOptional("rangeLabel", value)} /></>}
        {block.type === "sparkline" && <>{column("Series value", "valueColumn", true)}{column("Headline value", "headlineValueColumn")}{column("Headline label", "labelColumn")}{format()}<CheckField label="Show headline value" checked={block.showValue !== false} onChange={(showValue) => patch({ showValue })} />{column("Observed/forecast split", "splitColumn")}<SelectField label="Headline row" value={block.headlineRow} empty="Automatic" options={["last", "last_observed", "first_forecast"].map((value) => ({ value, label: value.replaceAll("_", " ") }))} onChange={(value) => patchOptional("headlineRow", value)} /><TextField label="Split label" value={block.splitLabel} onChange={(value) => patchOptional("splitLabel", value)} /><div className="grid grid-cols-2 gap-2"><TextField label="Observed color" value={block.color} onChange={(value) => patchOptional("color", value)} /><TextField label="Forecast color" value={block.splitColor} onChange={(value) => patchOptional("splitColor", value)} /></div></>}
        {block.type === "table" && <><Field label="Visible columns"><textarea className={textarea} value={(block.columns ?? []).join(", ")} placeholder="Empty shows all columns" onChange={(event) => patchOptionalList("columns", event.target.value)} /></Field><TextField label="Page size" value={String(block.pageSize ?? 50)} onChange={(value) => patch({ pageSize: Math.min(10_000, Math.max(1, Math.round(Number(value) || 1))) })} /></>}
        {block.type === "ai_narrative" && <><Field label="Instruction"><textarea className={textarea} value={block.instruction} onChange={(event) => patch({ instruction: event.target.value, snapshot: undefined })} /></Field><Field label="Columns"><textarea className={textarea} value={(block.columns ?? []).join(", ")} placeholder="Empty uses all columns" onChange={(event) => patch({ columns: event.target.value.split(",").map((value) => value.trim()).filter(Boolean), snapshot: undefined })} /></Field><TextField label="Maximum rows" value={String(block.maxRows ?? 25)} onChange={(value) => patch({ maxRows: Math.min(100, Math.max(1, Number(value) || 1)), snapshot: undefined })} /><SelectField label="Refresh policy" value={block.refreshPolicy} options={[{ value: "manual", label: "Manual" }, { value: "when_data_changes", label: "When data changes" }]} onChange={(refreshPolicy) => patch({ refreshPolicy })} /></>}
        {block.type === "small_multiples" && <>{column("Facet", "facetColumn", true)}{column("X", "xColumn", true)}{column("Y", "yColumn", true)}{column("Color", "colorColumn")}<div className="grid grid-cols-2 gap-2"><SelectField label="X type" value={block.xType} empty="Automatic" options={["temporal", "quantitative", "ordinal", "nominal"].map((value) => ({ value, label: value }))} onChange={(value) => patchOptional("xType", value)} /><SelectField label="Mark" value={block.mark} empty="Line" options={["line", "area", "bar", "point"].map((value) => ({ value, label: value }))} onChange={(value) => patchOptional("mark", value)} /></div><TextField label="Facet columns (1–6)" value={block.facetColumns == null ? "" : String(block.facetColumns)} onChange={(value) => value ? patch({ facetColumns: Math.min(6, Math.max(1, Number(value) || 1)) }) : patchOptional("facetColumns", "")} /><CheckField label="Share Y scale" checked={block.sharedY !== false} onChange={(sharedY) => patch({ sharedY })} /><div className="grid grid-cols-2 gap-2"><TextField label="Reference value" value={block.referenceValue == null ? "" : String(block.referenceValue)} onChange={(value) => value ? patch({ referenceValue: Number(value) }) : patchOptional("referenceValue", "")} /><TextField label="Reference label" value={block.referenceLabel} onChange={(value) => patchOptional("referenceLabel", value)} /></div></>}
        {block.type === "bullet" && <>{column("Category", "categoryColumn", true)}{column("Value", "valueColumn", true)}{column("Target", "targetColumn", true)}<Field label="Range columns"><textarea className={textarea} value={(block.rangeColumns ?? []).join(", ")} onChange={(event) => patch({ rangeColumns: event.target.value.split(",").map((value) => value.trim()).filter(Boolean).slice(0, 3) })} /></Field>{format()}<TextField label="Color" value={block.color} onChange={(value) => patchOptional("color", value)} /><SelectField label="Value labels" value={block.showValues} options={valueModes} onChange={(showValues) => patch({ showValues })} /></>}
        {block.type === "slopegraph" && <>{column("Category", "categoryColumn", true)}{column("Start", "startColumn", true)}{column("End", "endColumn", true)}{column("Color", "colorColumn")}<div className="grid grid-cols-2 gap-2"><TextField label="Start label" value={block.startLabel} onChange={(value) => patchOptional("startLabel", value)} /><TextField label="End label" value={block.endLabel} onChange={(value) => patchOptional("endLabel", value)} /></div>{format()}</>}
        {block.type === "range_dot" && <>{column("Category", "categoryColumn", true)}{column("Low", "lowColumn", true)}{column("High", "highColumn", true)}{column("Current value", "valueColumn")}{format()}<TextField label="Color" value={block.color} onChange={(value) => patchOptional("color", value)} /><SelectField label="Value labels" value={block.showValues} options={valueModes} onChange={(showValues) => patch({ showValues })} /></>}
        {block.type === "map" && <>{column("Geometry", "geometryColumn")}<div className="grid grid-cols-2 gap-2">{column("Latitude", "latitudeColumn")}{column("Longitude", "longitudeColumn")}</div>{column("Label", "labelColumn")}{column("Color", "colorColumn")}<Field label="Tooltip columns"><textarea className={textarea} value={(block.tooltipColumns ?? []).join(", ")} onChange={(event) => patchOptionalList("tooltipColumns", event.target.value)} /></Field><Field label="Palette"><textarea className={textarea} value={(block.palette ?? []).join(", ")} placeholder="#2563eb, #7c3aed" onChange={(event) => patchOptionalList("palette", event.target.value, 20)} /></Field><SelectField label="Basemap" value={block.basemap} options={[{ value: "openstreetmap", label: "OpenStreetMap" }, { value: "none", label: "None" }]} onChange={(basemap) => patch({ basemap })} /><JsonField label="Map style" value={block.style ?? {}} onChange={(style) => patch({ style })} onValidityChange={jsonValidity("Map style")} /></>}
        {block.type === "perspective" && <JsonField label="Perspective configuration" value={block.config ?? {}} onChange={(config) => patch({ config })} onValidityChange={jsonValidity("Perspective configuration")} />}
        {block.type === "chart" && <><div className="inline-flex rounded-md border p-0.5"><button type="button" aria-pressed={chartMode === "basic"} className={`rounded px-3 py-1 text-xs ${chartMode === "basic" ? "bg-muted font-medium" : ""}`} onClick={() => {
          if (basicChart) { setChartMode("basic"); jsonValidity("Vega-Lite specification")(true); }
          else if (window.confirm("Replace this advanced Vega-Lite specification with a basic line chart?")) {
            const config: BasicChartConfig = { mark: "line", xField: columns[0] ?? "", xType: "auto", xAggregate: "none", xTitle: "", yField: columns[1] ?? columns[0] ?? "", yType: "auto", yAggregate: "none", yTitle: "", colorField: "", fixedColor: "", facetRow: "", facetColumn: "", legend: true, legendTitle: "", zero: "auto", palette: "" };
            patch({ spec: basicChartSpec(config) }); setChartMode("basic");
          }
        }}>Basic</button><button type="button" aria-pressed={chartMode === "advanced"} className={`rounded px-3 py-1 text-xs ${chartMode === "advanced" ? "bg-muted font-medium" : ""}`} onClick={() => setChartMode("advanced")}>Advanced</button></div>
          {chartMode === "basic" && basicChart ? <BasicChartFields config={basicChart} columns={columnOptions} onChange={(config) => patch({ spec: basicChartSpec(config) })} /> : <JsonField label="Vega-Lite specification" value={block.spec} onChange={(spec) => patch({ spec })} onValidityChange={jsonValidity("Vega-Lite specification")} />}
        </>}
      </section>

      <section className="space-y-3"><h3 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Layout and appearance</h3>
        <div className="grid grid-cols-2 gap-2"><TextField label="Width (1–12)" value={String(block.layout.w)} onChange={(value) => patch({ layout: { ...block.layout, w: Math.min(12, Math.max(1, Number(value) || 1)), x: Math.min(block.layout.x, 12 - Math.min(12, Math.max(1, Number(value) || 1))) } })} /><TextField label="Height" value={String(block.layout.h)} onChange={(value) => patch({ layout: { ...block.layout, h: Math.max(1, Number(value) || 1) } })} /></div>
        <SelectField label="Group" value={block.groupId} options={groups.map((group) => ({ value: group.id, label: group.title }))} onChange={(value) => patchOptional("groupId", value)} />
        <div className="grid grid-cols-2 gap-2"><SelectField label="Tone" value={block.appearance?.tone} empty="Neutral" options={["neutral", "info", "success", "warning", "danger"].map((value) => ({ value, label: value }))} onChange={(tone) => patch({ appearance: { ...block.appearance, tone: tone || undefined } })} /><SelectField label="Emphasis" value={block.appearance?.emphasis} empty="Subtle" options={[{ value: "subtle", label: "Subtle" }, { value: "prominent", label: "Prominent" }]} onChange={(emphasis) => patch({ appearance: { ...block.appearance, emphasis: emphasis || undefined } })} /></div>
        <TextField label="Status label" value={block.appearance?.label} onChange={(label) => patch({ appearance: { ...block.appearance, label: label || undefined } })} />
        {block.type !== "markdown" && <JsonField label="Conditional appearance rules" value={block.appearance?.rules ?? []} onChange={(rules) => patch({ appearance: { ...block.appearance, rules } })} onValidityChange={jsonValidity("Conditional appearance rules")} />}
      </section>

      {errors.length > 0 && <div role="alert" className="rounded-md border border-destructive/25 bg-destructive/5 p-3 text-xs text-destructive"><div className="flex items-center gap-1.5 font-medium"><AlertCircle className="h-3.5 w-3.5" /> Fix before applying</div><ul className="mt-2 list-disc space-y-1 pl-5">{errors.map((error) => <li key={error}>{error}</li>)}</ul></div>}
    </div>
    <div className="flex items-center justify-end gap-2 border-t p-3">{invalidJson.size > 0 && <span className="mr-auto text-[10px] text-destructive">Fix invalid JSON before applying.</span>}<Button size="sm" variant="ghost" disabled={applying} onClick={onCancel}>Cancel</Button><Button size="sm" data-testid="report-block-apply" disabled={applying || errors.length > 0 || invalidJson.size > 0} onClick={onApply}>{isNew ? <Plus className="h-4 w-4" /> : null}{applying ? "Checking…" : isNew ? "Add block" : "Apply"}</Button></div>
  </div>;
}

function BasicChartFields({ config, columns, onChange }: { config: BasicChartConfig; columns: Array<{ value: string; label: string }>; onChange: (config: BasicChartConfig) => void }) {
  const patch = (values: Partial<BasicChartConfig>) => onChange({ ...config, ...values });
  const types = ["auto", "quantitative", "temporal", "ordinal", "nominal"].map((value) => ({ value, label: value }));
  const aggregates = ["none", "count", "sum", "mean", "median", "min", "max"].map((value) => ({ value, label: value }));
  return <div className="space-y-3 rounded-md border bg-muted/10 p-3">
    <SelectField label="Mark" value={config.mark} options={["bar", "line", "area", "point", "tick"].map((value) => ({ value, label: value }))} onChange={(mark) => patch({ mark: mark as BasicChartConfig["mark"] })} />
    <div className="grid grid-cols-2 gap-2"><SelectField label="X field" value={config.xField} options={columns} empty="Select" onChange={(xField) => patch({ xField })} /><SelectField label="X type" value={config.xType} options={types} onChange={(xType) => patch({ xType: xType as BasicChartConfig["xType"] })} /></div>
    <div className="grid grid-cols-2 gap-2"><SelectField label="X aggregate" value={config.xAggregate} options={aggregates} onChange={(xAggregate) => patch({ xAggregate: xAggregate as BasicChartConfig["xAggregate"] })} /><TextField label="X title" value={config.xTitle} onChange={(xTitle) => patch({ xTitle })} /></div>
    <div className="grid grid-cols-2 gap-2"><SelectField label="Y field" value={config.yField} options={columns} empty="Select" onChange={(yField) => patch({ yField })} /><SelectField label="Y type" value={config.yType} options={types} onChange={(yType) => patch({ yType: yType as BasicChartConfig["yType"] })} /></div>
    <div className="grid grid-cols-2 gap-2"><SelectField label="Y aggregate" value={config.yAggregate} options={aggregates} onChange={(yAggregate) => patch({ yAggregate: yAggregate as BasicChartConfig["yAggregate"] })} /><TextField label="Y title" value={config.yTitle} onChange={(yTitle) => patch({ yTitle })} /></div>
    <SelectField label="Color / series" value={config.colorField} options={columns} onChange={(colorField) => patch({ colorField })} />
    <div className="grid grid-cols-2 gap-2"><SelectField label="Row facet" value={config.facetRow} options={columns} onChange={(facetRow) => patch({ facetRow })} /><SelectField label="Column facet" value={config.facetColumn} options={columns} onChange={(facetColumn) => patch({ facetColumn })} /></div>
    <div className="grid grid-cols-2 gap-2"><TextField label="Fixed color" value={config.fixedColor} onChange={(fixedColor) => patch({ fixedColor })} /><TextField label="Palette scheme" value={config.palette} onChange={(palette) => patch({ palette })} /></div>
    <SelectField label="Y scale zero" value={config.zero} options={[{ value: "auto", label: "Automatic" }, { value: "include", label: "Include zero" }, { value: "exclude", label: "Fit data" }]} onChange={(zero) => patch({ zero: zero as BasicChartConfig["zero"] })} />
    <CheckField label="Show legend" checked={config.legend} onChange={(legend) => patch({ legend })} />{config.legend && <TextField label="Legend title" value={config.legendTitle} onChange={(legendTitle) => patch({ legendTitle })} />}
  </div>;
}
