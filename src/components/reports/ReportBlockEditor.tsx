import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AlertCircle, CircleHelp, Code2, Eye, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { basicChartConfigFromSpec, basicChartSpec, REPORT_BLOCK_TYPES, type BasicChartConfig } from "@/lib/reports/direct-editor";
import { reportBlockFieldHelp, reportChartBuilderHelp } from "@/lib/reports/block-help";
import { HelpTip } from "./HelpTip";
import type { ReportBlock, ReportDataset, ReportGroup, ReportParameter } from "@/lib/reports/types";
import { semanticBlockDefaults, semanticOutput, semanticOutputLabel, type SemanticPresentation } from "@/lib/reports/semantic-presentation";

interface Props {
  block: ReportBlock;
  isNew: boolean;
  datasets: ReportDataset[];
  groups: ReportGroup[];
  parameters: ReportParameter[];
  columnsByDataset: Record<string, string[]>;
  semanticsByDataset?: Record<string, SemanticPresentation | undefined>;
  errors: string[];
  applying?: boolean;
  onChange: (block: ReportBlock) => void;
  onApply: () => void;
  onCancel: () => void;
  onRunDataset: (datasetId: string) => void;
  onEditDataset: (datasetId: string) => void;
  onAddDataset: (kind: "semantic" | "sql") => void;
}

const control = "h-8 w-full rounded-md border bg-background px-2 text-xs";
const textarea = "min-h-24 w-full rounded-md border bg-background p-2 font-mono text-xs leading-relaxed";

/**
 * A labeled setting. The label points at its control by id rather than
 * wrapping it, so the help button can sit beside the label: inside a
 * `<label>` it would be the labeled control. Help text is also the control's
 * accessible description, for screen readers that never open the popover.
 */
function Field({ id, label, help, children }: { id: string; label: string; help?: string; children: React.ReactNode }) {
  return <div className="space-y-1" data-report-field={label}>
    <div className="flex items-center gap-1"><label htmlFor={id} className="text-xs font-medium">{label}</label>{help && <HelpTip text={help} />}</div>
    {children}
    {help && <span id={`${id}-help`} className="sr-only">{help}</span>}
  </div>;
}

const describedBy = (id: string, help?: string) => help ? `${id}-help` : undefined;

function TextField({ label, help, value, onChange, placeholder }: { label: string; help?: string; value?: string; onChange: (value: string) => void; placeholder?: string }) {
  const id = useId();
  return <Field id={id} label={label} help={help}><Input id={id} aria-label={label} aria-describedby={describedBy(id, help)} className="h-8 text-xs" value={value ?? ""} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} /></Field>;
}

function TextAreaField({ label, help, value, onChange, placeholder, className = "", testId }: { label: string; help?: string; value: string; onChange: (value: string) => void; placeholder?: string; className?: string; testId?: string }) {
  const id = useId();
  return <Field id={id} label={label} help={help}><textarea id={id} data-testid={testId} aria-describedby={describedBy(id, help)} className={`${textarea} ${className}`} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} /></Field>;
}

function SelectField({ label, help, value, options, onChange, empty = "None" }: { label: string; help?: string; value?: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void; empty?: string }) {
  const id = useId();
  return <Field id={id} label={label} help={help}><select id={id} aria-label={label} aria-describedby={describedBy(id, help)} className={control} value={value ?? ""} onChange={(event) => onChange(event.target.value)}><option value="">{empty}</option>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></Field>;
}

function CheckField({ label, help, checked, onChange }: { label: string; help?: string; checked: boolean; onChange: (checked: boolean) => void }) {
  const id = useId();
  return <div className="flex items-center gap-1" data-report-field={label}>
    <label className="flex items-center gap-2 text-xs"><input type="checkbox" aria-describedby={describedBy(id, help)} checked={checked} onChange={(event) => onChange(event.target.checked)} />{label}</label>
    {help && <HelpTip text={help} />}
    {help && <span id={`${id}-help`} className="sr-only">{help}</span>}
  </div>;
}

function JsonField({ label, help, value, onChange, onValidityChange }: { label: string; help?: string; value: unknown; onChange: (value: any) => void; onValidityChange?: (valid: boolean) => void }) {
  const id = useId();
  const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 2));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setText(JSON.stringify(value ?? {}, null, 2)); setError(null); }, [value]);
  return <Field id={id} label={label} help={help}><textarea id={id} aria-label={label} aria-describedby={describedBy(id, help)} className={textarea} spellCheck={false} value={text} onChange={(event) => {
    const next = event.target.value;
    setText(next);
    try { onChange(JSON.parse(next)); setError(null); onValidityChange?.(true); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); onValidityChange?.(false); }
  }} />{error && <p role="alert" className="text-[10px] text-destructive">{error}</p>}</Field>;
}

const formats = ["number", "currency", "percent", "text"].map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) }));
const valueModes = ["auto", "all", "none"].map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) }));

export function ReportBlockEditor({ block, isNew, datasets, groups, parameters, columnsByDataset, semanticsByDataset = {}, errors, applying = false, onChange, onApply, onCancel, onRunDataset, onEditDataset, onAddDataset }: Props) {
  const editorRef = useRef<HTMLDivElement>(null);
  const datasetId = block.type === "markdown" ? "" : block.datasetId;
  const columns = columnsByDataset[datasetId] ?? [];
  const blockDatasets = datasets.filter((dataset) => !dataset.role || dataset.role === "data");
  const setupErrors = errors.map((error) => error.replace(
    /report\.blocks\[\d+\]\.(datasetId|\w+Column) must be a non-empty string\./g,
    (_match, field: string) => field === "datasetId"
      ? "Select a dataset for this block."
      : `Select the ${field.replace(/Column$/, "").replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`)} column.`,
  ));
  const semanticPlan = semanticsByDataset[datasetId];
  const semanticDefaults = semanticBlockDefaults(block, semanticPlan);
  const columnOptions = columns.map((column) => {
    const output = semanticOutput(semanticPlan, column);
    return { value: column, label: output ? `${semanticOutputLabel(output, column)} · ${column}` : column };
  });
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

  const help = (key: string) => reportBlockFieldHelp(block.type, key);
  const blockType = REPORT_BLOCK_TYPES.find((candidate) => candidate.type === block.type);
  const column = (label: string, key: string, required = false) => <SelectField label={label} help={help(key)} value={(block as any)[key]} options={columnOptions} empty={required ? "Select a column" : "None"} onChange={(value) => patchOptional(key, value)} />;
  const format = () => <SelectField label="Value format" help={help("format")} value={(block as any).format} options={formats} empty="Automatic" onChange={(value) => patchOptional("format", value)} />;

  return <div ref={editorRef} data-testid="report-block-editor" role="region" aria-label="Report block editor" className="flex min-h-0 flex-1 flex-col" aria-busy={applying} onKeyDown={(event) => {
      // React bubbles keys from portaled popups (a help popover) through this
      // element; Escape there closes the popup, not the editor.
      if (event.key === "Escape" && !applying && editorRef.current?.contains(event.target as Node)) { event.preventDefault(); onCancel(); }
    }}>
    <div className="flex items-center gap-2 border-b px-4 py-3"><div className="min-w-0 flex-1"><div className="text-sm font-semibold">{isNew ? "Add" : "Edit"} {blockType?.label ?? block.type.replaceAll("_", " ")}</div>{blockType && <div data-testid="report-block-editor-description" className="text-xs text-muted-foreground">{blockType.description}</div>}<div className="truncate text-[10px] text-muted-foreground">Changes preview in the report until you apply them. Hover or tap <CircleHelp className="inline h-3 w-3 align-[-2px]" aria-hidden="true" /> for what a setting does.</div></div><Button size="icon-sm" variant="ghost" aria-label="Close block editor" disabled={applying} onClick={onCancel}><X className="h-4 w-4" /></Button></div>
    <div className={`min-h-0 flex-1 space-y-5 overflow-y-auto p-4 ${applying ? "pointer-events-none opacity-70" : ""}`}>
      <section className="space-y-3"><h3 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Content</h3>
        <TextField label="Title" help={help("title")} value={block.title} placeholder={semanticDefaults.title || "Optional"} onChange={(value) => patchOptional("title", value)} />
        <TextField label="Caption" help={help("caption")} value={block.caption} placeholder="Optional interpretive note" onChange={(value) => patchOptional("caption", value)} />
        <TextField label="Source" help={help("source")} value={block.source} placeholder="Optional provenance" onChange={(value) => patchOptional("source", value)} />
        {parameterTokens.length > 0 && <p className="text-[10px] text-muted-foreground">Available text parameters: <code>{parameterTokens.join(", ")}</code></p>}
      </section>

      {block.type === "chart" && <details className="space-y-3"><summary className="cursor-pointer text-xs font-medium">Chart interaction</summary><SelectField help="Choose the report parameter to update when a reader selects a chart mark. Leave empty to disable click filtering." label="Filter parameter" value={block.filter?.parameterKey} options={parameters.filter(p => p.type !== "date_range").map(p => ({ value: p.key, label: p.label }))} empty="No click filter" onChange={(key) => { const { filter, ...rest } = block; onChange(key ? { ...rest, filter: { parameterKey: key, column: filter?.column || columns[0] || "" } } : rest); }} />{block.filter && <SelectField help="The selected mark must contain this column. Its value becomes the parameter value, and affected report datasets refresh after validation." label="Filter column" value={block.filter.column} options={columnOptions} empty="Select a column" onChange={(column) => patch({ filter: { ...block.filter, column } })} />}<p className="text-xs text-muted-foreground">Selecting a chart mark applies its column value to this report parameter. Related datasets refresh using the same validation as the filter controls.</p></details>}
      {block.type !== "markdown" && <section className="space-y-3"><h3 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Data</h3>
        {blockDatasets.length === 0 && <p className="text-xs text-muted-foreground">This report has no datasets for blocks yet. <span className="block mt-1">Add a query or governed metrics from your connected data, then choose the columns for this block.</span></p>}
        <SelectField label="Dataset" help={help("datasetId")} value={datasetId} options={blockDatasets.map((dataset) => ({ value: dataset.id, label: dataset.name }))} empty="Select a dataset" onChange={changeDataset} />
        <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={applying} onClick={() => onAddDataset("sql")}><Plus className="h-3.5 w-3.5" /> Add SQL dataset</Button><Button size="sm" variant="outline" disabled={applying} onClick={() => onAddDataset("semantic")}><Plus className="h-3.5 w-3.5" /> Add governed metrics</Button></div>
        {datasetId && <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={applying} onClick={() => onEditDataset(datasetId)}><Code2 className="h-3.5 w-3.5" /> Edit dataset</Button>{columns.length === 0 && <Button size="sm" variant="outline" disabled={applying} onClick={() => onRunDataset(datasetId)}><Eye className="h-3.5 w-3.5" /> Run for columns</Button>}</div>}
        {datasetId && columns.length === 0 && <p className="text-[10px] text-muted-foreground">Run this dataset to populate schema-backed column selectors.</p>}
        {semanticPlan && <div className="rounded-md border bg-muted/20 p-2 text-xs"><p>Automatic titles, chart axes, and value units follow the governed model. Set a title or value format to override them.</p>{semanticPlan.outputs?.filter((output) => columns.includes(output.name) && output.description).map((output) => <p key={output.name} className="mt-1 text-muted-foreground"><strong>{output.title || output.name}:</strong> {output.description}</p>)}</div>}
      </section>}

      <section className="space-y-3"><h3 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Block settings</h3>
        {block.type === "markdown" && <TextAreaField label="Markdown" help={help("markdown")} testId="report-markdown-editor" className="min-h-48 font-sans" value={block.markdown} onChange={(markdown) => patch({ markdown })} />}
        {block.type === "kpi" && <>{column("Value", "valueColumn", true)}{column("Label", "labelColumn")}{format()}<div className="grid grid-cols-2 gap-2">{column("Low bound", "lowColumn")}{column("High bound", "highColumn")}</div>{column("Target", "targetColumn")}<TextField label="Range label" help={help("rangeLabel")} value={block.rangeLabel} onChange={(value) => patchOptional("rangeLabel", value)} /></>}
        {block.type === "sparkline" && <>{column("Series value", "valueColumn", true)}{column("Headline value", "headlineValueColumn")}{column("Headline label", "labelColumn")}{format()}<CheckField label="Show headline value" help={help("showValue")} checked={block.showValue !== false} onChange={(showValue) => patch({ showValue })} />{column("Observed/forecast split", "splitColumn")}<SelectField label="Headline row" help={help("headlineRow")} value={block.headlineRow} empty="Automatic" options={["last", "last_observed", "first_forecast"].map((value) => ({ value, label: value.replaceAll("_", " ") }))} onChange={(value) => patchOptional("headlineRow", value)} /><TextField label="Split label" help={help("splitLabel")} value={block.splitLabel} onChange={(value) => patchOptional("splitLabel", value)} /><div className="grid grid-cols-2 gap-2"><TextField label="Observed color" help={help("color")} value={block.color} onChange={(value) => patchOptional("color", value)} /><TextField label="Forecast color" help={help("splitColor")} value={block.splitColor} onChange={(value) => patchOptional("splitColor", value)} /></div></>}
        {block.type === "table" && <><TextAreaField label="Visible columns" help={help("columns")} value={(block.columns ?? []).join(", ")} placeholder="Empty shows all columns" onChange={(value) => patchOptionalList("columns", value)} /><TextField label="Page size" help={help("pageSize")} value={String(block.pageSize ?? 50)} onChange={(value) => patch({ pageSize: Math.min(10_000, Math.max(1, Math.round(Number(value) || 1))) })} /></>}
        {block.type === "ai_narrative" && <><TextAreaField label="Instruction" help={help("instruction")} value={block.instruction} onChange={(instruction) => patch({ instruction, snapshot: undefined })} /><TextAreaField label="Columns" help={help("columns")} value={(block.columns ?? []).join(", ")} placeholder="Empty uses all columns" onChange={(value) => patch({ columns: value.split(",").map((item) => item.trim()).filter(Boolean), snapshot: undefined })} /><TextField label="Maximum rows" help={help("maxRows")} value={String(block.maxRows ?? 25)} onChange={(value) => patch({ maxRows: Math.min(100, Math.max(1, Number(value) || 1)), snapshot: undefined })} /><SelectField label="Refresh policy" help={help("refreshPolicy")} value={block.refreshPolicy} options={[{ value: "manual", label: "Manual" }, { value: "when_data_changes", label: "When data changes" }]} onChange={(refreshPolicy) => patch({ refreshPolicy })} /></>}
        {block.type === "small_multiples" && <>{column("Facet", "facetColumn", true)}{column("X", "xColumn", true)}{column("Y", "yColumn", true)}{column("Color", "colorColumn")}<div className="grid grid-cols-2 gap-2"><SelectField label="X type" help={help("xType")} value={block.xType} empty="Automatic" options={["temporal", "quantitative", "ordinal", "nominal"].map((value) => ({ value, label: value }))} onChange={(value) => patchOptional("xType", value)} /><SelectField label="Mark" help={help("mark")} value={block.mark} empty="Line" options={["line", "area", "bar", "point"].map((value) => ({ value, label: value }))} onChange={(value) => patchOptional("mark", value)} /></div><TextField label="Facet columns (1–6)" help={help("facetColumns")} value={block.facetColumns == null ? "" : String(block.facetColumns)} onChange={(value) => value ? patch({ facetColumns: Math.min(6, Math.max(1, Number(value) || 1)) }) : patchOptional("facetColumns", "")} /><CheckField label="Share Y scale" help={help("sharedY")} checked={block.sharedY !== false} onChange={(sharedY) => patch({ sharedY })} /><div className="grid grid-cols-2 gap-2"><TextField label="Reference value" help={help("referenceValue")} value={block.referenceValue == null ? "" : String(block.referenceValue)} onChange={(value) => value ? patch({ referenceValue: Number(value) }) : patchOptional("referenceValue", "")} /><TextField label="Reference label" help={help("referenceLabel")} value={block.referenceLabel} onChange={(value) => patchOptional("referenceLabel", value)} /></div></>}
        {block.type === "bullet" && <>{column("Category", "categoryColumn", true)}{column("Value", "valueColumn", true)}{column("Target", "targetColumn", true)}<TextAreaField label="Range columns" help={help("rangeColumns")} value={(block.rangeColumns ?? []).join(", ")} onChange={(value) => patch({ rangeColumns: value.split(",").map((item) => item.trim()).filter(Boolean).slice(0, 3) })} />{format()}<TextField label="Color" help={help("color")} value={block.color} onChange={(value) => patchOptional("color", value)} /><SelectField label="Value labels" help={help("showValues")} value={block.showValues} options={valueModes} onChange={(showValues) => patch({ showValues })} /></>}
        {block.type === "slopegraph" && <>{column("Category", "categoryColumn", true)}{column("Start", "startColumn", true)}{column("End", "endColumn", true)}{column("Color", "colorColumn")}<div className="grid grid-cols-2 gap-2"><TextField label="Start label" help={help("startLabel")} value={block.startLabel} onChange={(value) => patchOptional("startLabel", value)} /><TextField label="End label" help={help("endLabel")} value={block.endLabel} onChange={(value) => patchOptional("endLabel", value)} /></div>{format()}</>}
        {block.type === "range_dot" && <>{column("Category", "categoryColumn", true)}{column("Low", "lowColumn", true)}{column("High", "highColumn", true)}{column("Current value", "valueColumn")}{format()}<TextField label="Color" help={help("color")} value={block.color} onChange={(value) => patchOptional("color", value)} /><SelectField label="Value labels" help={help("showValues")} value={block.showValues} options={valueModes} onChange={(showValues) => patch({ showValues })} /></>}
        {block.type === "map" && <>{column("Geometry", "geometryColumn")}<div className="grid grid-cols-2 gap-2">{column("Latitude", "latitudeColumn")}{column("Longitude", "longitudeColumn")}</div>{column("Label", "labelColumn")}{column("Color", "colorColumn")}<TextAreaField label="Popup columns" help={help("tooltipColumns")} value={(block.tooltipColumns ?? []).join(", ")} onChange={(value) => patchOptionalList("tooltipColumns", value)} /><TextAreaField label="Palette" help={help("palette")} value={(block.palette ?? []).join(", ")} placeholder="#2563eb, #7c3aed" onChange={(value) => patchOptionalList("palette", value, 20)} /><SelectField label="Basemap" help={help("basemap")} value={block.basemap} options={[{ value: "openstreetmap", label: "OpenStreetMap" }, { value: "none", label: "None" }]} onChange={(basemap) => patch({ basemap })} /><JsonField label="Map style" help={help("style")} value={block.style ?? {}} onChange={(style) => patch({ style })} onValidityChange={jsonValidity("Map style")} /></>}
        {block.type === "perspective" && <JsonField label="Perspective configuration" help={help("config")} value={block.config ?? {}} onChange={(config) => patch({ config })} onValidityChange={jsonValidity("Perspective configuration")} />}
        {block.type === "chart" && <><div className="inline-flex rounded-md border p-0.5"><button type="button" aria-pressed={chartMode === "basic"} className={`rounded px-3 py-1 text-xs ${chartMode === "basic" ? "bg-muted font-medium" : ""}`} onClick={() => {
          if (basicChart) { setChartMode("basic"); jsonValidity("Vega-Lite specification")(true); }
          else if (window.confirm("Replace this advanced Vega-Lite specification with a basic line chart?")) {
            const config: BasicChartConfig = { mark: "line", xField: columns[0] ?? "", xType: "auto", xAggregate: "none", xTitle: "", yField: columns[1] ?? columns[0] ?? "", yType: "auto", yAggregate: "none", yTitle: "", colorField: "", fixedColor: "", facetRow: "", facetColumn: "", legend: true, legendTitle: "", zero: "auto", palette: "" };
            patch({ spec: basicChartSpec(config) }); setChartMode("basic");
          }
        }}>Basic</button><button type="button" aria-pressed={chartMode === "advanced"} className={`rounded px-3 py-1 text-xs ${chartMode === "advanced" ? "bg-muted font-medium" : ""}`} onClick={() => setChartMode("advanced")}>Advanced</button></div>{help("chartMode") && <span className="ml-1 inline-flex align-middle"><HelpTip text={help("chartMode")!} /></span>}
          {chartMode === "basic" && basicChart ? <BasicChartFields config={basicChart} columns={columnOptions} onChange={(config) => patch({ spec: basicChartSpec(config) })} /> : <JsonField label="Vega-Lite specification" help={help("spec")} value={block.spec} onChange={(spec) => patch({ spec })} onValidityChange={jsonValidity("Vega-Lite specification")} />}
        </>}
      </section>

      <section className="space-y-3"><h3 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Layout and appearance</h3>
        <div className="grid grid-cols-2 gap-2"><TextField label="Width (1–12)" help={help("layout.w")} value={String(block.layout.w)} onChange={(value) => patch({ layout: { ...block.layout, w: Math.min(12, Math.max(1, Number(value) || 1)), x: Math.min(block.layout.x, 12 - Math.min(12, Math.max(1, Number(value) || 1))) } })} /><TextField label="Height" help={help("layout.h")} value={String(block.layout.h)} onChange={(value) => patch({ layout: { ...block.layout, h: Math.max(1, Number(value) || 1) } })} /></div>
        <SelectField label="Group" help={help("groupId")} value={block.groupId} options={groups.map((group) => ({ value: group.id, label: group.title }))} onChange={(value) => patchOptional("groupId", value)} />
        <div className="grid grid-cols-2 gap-2"><SelectField label="Tone" help={help("appearance.tone")} value={block.appearance?.tone} empty="Neutral" options={["neutral", "info", "success", "warning", "danger"].map((value) => ({ value, label: value }))} onChange={(tone) => patch({ appearance: { ...block.appearance, tone: tone || undefined } })} /><SelectField label="Emphasis" help={help("appearance.emphasis")} value={block.appearance?.emphasis} empty="Subtle" options={[{ value: "subtle", label: "Subtle" }, { value: "prominent", label: "Prominent" }]} onChange={(emphasis) => patch({ appearance: { ...block.appearance, emphasis: emphasis || undefined } })} /></div>
        <TextField label="Status label" help={help("appearance.label")} value={block.appearance?.label} onChange={(label) => patch({ appearance: { ...block.appearance, label: label || undefined } })} />
        {block.type !== "markdown" && <details><summary className="mb-2 cursor-pointer text-xs font-medium">Advanced appearance</summary><JsonField label="Conditional appearance rules" help={help("appearance.rules")} value={block.appearance?.rules ?? []} onChange={(rules) => patch({ appearance: { ...block.appearance, rules } })} onValidityChange={jsonValidity("Conditional appearance rules")} /></details>}
      </section>

      {setupErrors.length > 0 && <div role="alert" className="rounded-md border border-destructive/25 bg-destructive/5 p-3 text-xs text-destructive"><div className="flex items-center gap-1.5 font-medium"><AlertCircle className="h-3.5 w-3.5" /> {isNew ? "Complete block setup" : "Fix before applying"}</div><ul className="mt-2 list-disc space-y-1 pl-5">{setupErrors.map((error) => <li key={error}>{error}</li>)}</ul></div>}
    </div>
    <div className="flex items-center justify-end gap-2 border-t p-3">{invalidJson.size > 0 && <span className="mr-auto text-[10px] text-destructive">Fix invalid JSON before applying.</span>}<Button size="sm" variant="ghost" disabled={applying} onClick={onCancel}>Cancel</Button><Button size="sm" data-testid="report-block-apply" disabled={applying || errors.length > 0 || invalidJson.size > 0} onClick={onApply}>{isNew ? <Plus className="h-4 w-4" /> : null}{applying ? "Checking…" : isNew ? "Add block" : "Apply"}</Button></div>
  </div>;
}

function BasicChartFields({ config, columns, onChange }: { config: BasicChartConfig; columns: Array<{ value: string; label: string }>; onChange: (config: BasicChartConfig) => void }) {
  const patch = (values: Partial<BasicChartConfig>) => onChange({ ...config, ...values });
  const types = ["auto", "quantitative", "temporal", "ordinal", "nominal"].map((value) => ({ value, label: value }));
  const aggregates = ["none", "count", "sum", "mean", "median", "min", "max"].map((value) => ({ value, label: value }));
  return <div className="space-y-3 rounded-md border bg-muted/10 p-3">
    <SelectField help={reportChartBuilderHelp("mark")} label="Mark" value={config.mark} options={["bar", "line", "area", "point", "tick"].map((value) => ({ value, label: value }))} onChange={(mark) => patch({ mark: mark as BasicChartConfig["mark"] })} />
    <div className="grid grid-cols-2 gap-2"><SelectField help={reportChartBuilderHelp("xField")} label="X field" value={config.xField} options={columns} empty="Select" onChange={(xField) => patch({ xField })} /><SelectField help={reportChartBuilderHelp("xType")} label="X type" value={config.xType} options={types} onChange={(xType) => patch({ xType: xType as BasicChartConfig["xType"] })} /></div>
    <div className="grid grid-cols-2 gap-2"><SelectField help={reportChartBuilderHelp("xAggregate")} label="X aggregate" value={config.xAggregate} options={aggregates} onChange={(xAggregate) => patch({ xAggregate: xAggregate as BasicChartConfig["xAggregate"] })} /><TextField help={reportChartBuilderHelp("xTitle")} label="X title" value={config.xTitle} onChange={(xTitle) => patch({ xTitle })} /></div>
    <div className="grid grid-cols-2 gap-2"><SelectField help={reportChartBuilderHelp("yField")} label="Y field" value={config.yField} options={columns} empty="Select" onChange={(yField) => patch({ yField })} /><SelectField help={reportChartBuilderHelp("yType")} label="Y type" value={config.yType} options={types} onChange={(yType) => patch({ yType: yType as BasicChartConfig["yType"] })} /></div>
    <div className="grid grid-cols-2 gap-2"><SelectField help={reportChartBuilderHelp("yAggregate")} label="Y aggregate" value={config.yAggregate} options={aggregates} onChange={(yAggregate) => patch({ yAggregate: yAggregate as BasicChartConfig["yAggregate"] })} /><TextField help={reportChartBuilderHelp("yTitle")} label="Y title" value={config.yTitle} onChange={(yTitle) => patch({ yTitle })} /></div>
    <SelectField help={reportChartBuilderHelp("colorField")} label="Color / series" value={config.colorField} options={columns} onChange={(colorField) => patch({ colorField })} />
    <div className="grid grid-cols-2 gap-2"><SelectField help={reportChartBuilderHelp("facetRow")} label="Row facet" value={config.facetRow} options={columns} onChange={(facetRow) => patch({ facetRow })} /><SelectField help={reportChartBuilderHelp("facetColumn")} label="Column facet" value={config.facetColumn} options={columns} onChange={(facetColumn) => patch({ facetColumn })} /></div>
    <div className="grid grid-cols-2 gap-2"><TextField help={reportChartBuilderHelp("fixedColor")} label="Fixed color" value={config.fixedColor} onChange={(fixedColor) => patch({ fixedColor })} /><TextField help={reportChartBuilderHelp("palette")} label="Palette scheme" value={config.palette} onChange={(palette) => patch({ palette })} /></div>
    <SelectField help={reportChartBuilderHelp("zero")} label="Y scale zero" value={config.zero} options={[{ value: "auto", label: "Automatic" }, { value: "include", label: "Include zero" }, { value: "exclude", label: "Fit data" }]} onChange={(zero) => patch({ zero: zero as BasicChartConfig["zero"] })} />
    <CheckField help={reportChartBuilderHelp("legend")} label="Show legend" checked={config.legend} onChange={(legend) => patch({ legend })} />{config.legend && <TextField help={reportChartBuilderHelp("legendTitle")} label="Legend title" value={config.legendTitle} onChange={(legendTitle) => patch({ legendTitle })} />}
  </div>;
}
