import { useMemo, useState } from "react";
import { Filter, Search, ShieldCheck } from "lucide-react";
import type { CatalogData } from "@/lib/service";
import { buildSemanticEnvironment, type SemanticEntity, type SemanticMember } from "@/lib/semantic-model";
import type { ReportDocumentV1, ReportSemanticDataset } from "@/lib/reports/types";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

interface Props {
  dataset: ReportSemanticDataset;
  report: Pick<ReportDocumentV1, "parameters">;
  catalogs: readonly CatalogData[];
  onChange: (dataset: ReportSemanticDataset) => void;
}

interface MemberItem {
  entity: SemanticEntity;
  member: SemanticMember;
}

const keyOf = (item: MemberItem) => `${item.entity.catalogId}::${item.entity.entityId}::${item.member.member_id}`;
const selectionKey = (selection: any) => `${selection.catalog_id}::${selection.entity_id}::${selection.member_id}`;

function ref(item: MemberItem) {
  return { catalog_id: item.entity.catalogId, entity_id: item.entity.entityId, member_id: item.member.member_id };
}

function title(item: MemberItem): string {
  return item.member.title || item.member.member_id.replaceAll("_", " ");
}

function inputValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function typedValue(value: string, duckdbType?: string): unknown {
  const normalized = duckdbType?.toUpperCase() ?? "";
  if (/^(?:UTINYINT|USMALLINT|UINTEGER|UBIGINT|TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|FLOAT|DOUBLE|DECIMAL)/.test(normalized)) {
    const number = Number(value);
    return Number.isFinite(number) ? number : value;
  }
  if (normalized === "BOOLEAN") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return value;
}

function simpleFilters(query: Record<string, any>): any[] | null {
  if (!query.filters) return [];
  const values = Array.isArray(query.filters.and) ? query.filters.and : [query.filters];
  return values.every((item: any) => item && typeof item === "object" && "member" in item && "operator" in item) ? values : null;
}

export function ReportSemanticDatasetBuilder({ dataset, report, catalogs, onChange }: Props) {
  const [search, setSearch] = useState("");
  const environment = useMemo(() => buildSemanticEnvironment(catalogs), [catalogs]);
  const members = useMemo(() => environment.entities.flatMap((entity) => [...entity.members.values()]
    .filter((member) => !member.hidden)
    .map((member) => ({ entity, member }))), [environment]);
  const normalizedSearch = search.trim().toLocaleLowerCase("en-US");
  const visible = members.filter((item) => !normalizedSearch || `${title(item)} ${item.member.description ?? ""} ${item.entity.entityId}`.toLocaleLowerCase("en-US").includes(normalizedSearch));
  const measures = visible.filter((item) => item.member.kind === "measure");
  const dimensions = visible.filter((item) => item.member.kind !== "measure");
  const selectedMeasures = new Map<string, any>((dataset.query.measures ?? []).map((item: any) => [selectionKey(item), item]));
  const selectedDimensions = new Map<string, any>((dataset.query.dimensions ?? []).map((item: any) => [selectionKey(item), item]));
  const filters = simpleFilters(dataset.query);
  const selectedEntityKeys = new Set([...selectedMeasures.keys(), ...selectedDimensions.keys()].map((key) => key.split("::").slice(0, 2).join("::")));
  const sourceParameters = environment.entities
    .filter((entity) => selectedEntityKeys.has(`${entity.catalogId}::${entity.entityId}`))
    .flatMap((entity) => entity.sourceArguments.map((mapping) => ({
      entity,
      mapping,
      argument: entity.functionArguments.find((argument) => argument.name === mapping.argument),
    })))
    .filter((item, index, all) => all.findIndex((candidate) => candidate.mapping.parameter === item.mapping.parameter) === index);
  const selectedOutputs = [...(dataset.query.dimensions ?? []), ...(dataset.query.measures ?? [])]
    .map((selection: any) => selection.alias || selection.member_id)
    .filter((name: unknown): name is string => typeof name === "string" && name.length > 0);
  const order = Array.isArray(dataset.query.order) ? dataset.query.order : [];

  const updateQuery = (patch: Record<string, any>) => onChange({ ...dataset, query: { ...dataset.query, ...patch }, acceptedModelFingerprint: undefined });
  const toggle = (item: MemberItem, kind: "measures" | "dimensions") => {
    const current = [...(dataset.query[kind] ?? [])];
    const key = keyOf(item);
    const index = current.findIndex((selection) => selectionKey(selection) === key);
    if (index >= 0) current.splice(index, 1);
    else current.push(ref(item));
    updateQuery({ [kind]: current });
  };
  const updateGranularity = (item: MemberItem, granularity: string) => {
    const current = [...(dataset.query.dimensions ?? [])].map((selection: any) => selectionKey(selection) === keyOf(item)
      ? { ...selection, ...(granularity ? { granularity } : {}) }
      : selection);
    if (!granularity) {
      const selected = current.find((selection: any) => selectionKey(selection) === keyOf(item));
      if (selected) delete selected.granularity;
    }
    updateQuery({ dimensions: current });
  };
  const updateFilter = (index: number, patch: Record<string, any>) => {
    if (!filters) return;
    const next = filters.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item);
    updateQuery({ filters: next.length === 1 ? next[0] : { and: next } });
  };
  const addFilter = () => {
    const first = dimensions[0] ?? members.find((item) => item.member.kind !== "measure");
    if (!first || !filters) return;
    const next = [...filters, { member: ref(first), operator: "eq", value: "" }];
    updateQuery({ filters: next.length === 1 ? next[0] : { and: next } });
  };
  const removeFilter = (index: number) => {
    if (!filters) return;
    const next = filters.filter((_, itemIndex) => itemIndex !== index);
    updateQuery({ filters: next.length === 0 ? undefined : next.length === 1 ? next[0] : { and: next } });
  };
  const updateParameter = (parameter: string, value: unknown, remove = false) => {
    const parameters = { ...(dataset.query.parameters ?? {}) };
    if (remove) delete parameters[parameter];
    else parameters[parameter] = value;
    updateQuery({ parameters: Object.keys(parameters).length ? parameters : undefined });
  };
  const addOrder = () => {
    const member = selectedOutputs.find((name) => !order.some((item: any) => item.member === name));
    if (member) updateQuery({ order: [...order, { member, direction: "asc" }] });
  };
  const updateOrder = (index: number, patch: Record<string, any>) => updateQuery({ order: order.map((item: any, itemIndex: number) => itemIndex === index ? { ...item, ...patch } : item) });
  const removeOrder = (index: number) => {
    const next = order.filter((_: any, itemIndex: number) => itemIndex !== index);
    updateQuery({ order: next.length ? next : undefined });
  };

  const renderMember = (item: MemberItem, kind: "measures" | "dimensions") => {
    const selected = (kind === "measures" ? selectedMeasures : selectedDimensions).get(keyOf(item));
    return <div key={keyOf(item)} className="rounded-md border bg-background p-2.5">
      <label className="flex cursor-pointer items-start gap-2">
        <input type="checkbox" className="mt-1" checked={Boolean(selected)} onChange={() => toggle(item, kind)} />
        <span className="min-w-0 flex-1"><span className="block text-sm font-medium capitalize">{title(item)}</span><span className="block text-[10px] text-muted-foreground">{item.entity.entityId}{item.member.unit ? ` · ${item.member.unit}` : ""}</span>{item.member.description && <span className="mt-1 block text-xs text-muted-foreground">{item.member.description}</span>}</span>
      </label>
      {selected && item.member.kind === "time_dimension" && item.member.granularities?.length ? <label className="mt-2 flex items-center gap-2 pl-6 text-xs"><span className="text-muted-foreground">Time grain</span><select className="h-7 rounded border bg-background px-2" value={selected.granularity ?? ""} onChange={(event) => updateGranularity(item, event.target.value)}><option value="">Exact time</option>{item.member.granularities.map((granularity) => <option key={granularity} value={granularity}>{granularity}</option>)}</select></label> : null}
    </div>;
  };

  return <div data-testid="report-semantic-builder" className="mt-3 space-y-4">
    <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 p-3 text-xs text-emerald-950 dark:border-emerald-900 dark:bg-emerald-950/20 dark:text-emerald-100"><div className="flex items-center gap-2 font-medium"><ShieldCheck className="h-4 w-4" /> Governed metrics</div><p className="mt-1 text-muted-foreground">Choose business measures and how to break them down. Cupola validates joins, aggregation, required filters, and units before the dataset can be applied.</p></div>
    <label className="relative block"><Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" /><Input className="pl-8" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a measure or dimension…" /></label>
    {environment.diagnostics.length > 0 && <details className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs dark:border-amber-800 dark:bg-amber-950/30"><summary className="cursor-pointer font-medium">{environment.diagnostics.length} semantic model warning{environment.diagnostics.length === 1 ? "" : "s"}</summary><ul className="mt-2 list-disc pl-5">{environment.diagnostics.slice(0, 10).map((diagnostic, index) => <li key={`${diagnostic.code}-${index}`}>{diagnostic.message}</li>)}</ul></details>}
    <div className="grid gap-4 lg:grid-cols-2"><section><h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Measures</h4><div className="max-h-72 space-y-2 overflow-auto pr-1">{measures.map((item) => renderMember(item, "measures"))}{measures.length === 0 && <p className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">No matching measures.</p>}</div></section><section><h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Break down by</h4><div className="max-h-72 space-y-2 overflow-auto pr-1">{dimensions.map((item) => renderMember(item, "dimensions"))}{dimensions.length === 0 && <p className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">No matching dimensions.</p>}</div></section></div>
    {sourceParameters.length > 0 && <section className="rounded-lg border p-3"><h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Function parameters</h4><p className="mt-1 text-xs text-muted-foreground">Leave a value blank to use the model-discovered default, or bind it to a report control.</p><div className="mt-3 space-y-3">{sourceParameters.map(({ entity, mapping, argument }) => {
      const value = dataset.query.parameters?.[mapping.parameter];
      const bound = value && typeof value === "object" && "report_parameter" in value;
      return <div key={mapping.parameter} className="grid gap-2 rounded-md bg-muted/20 p-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_150px]"><div><div className="text-xs font-medium">{mapping.parameter.replaceAll("_", " ")}</div><div className="text-[10px] text-muted-foreground">{entity.entityId} · {argument?.duckdbType ?? "unknown type"}{argument?.defaultValue !== undefined ? ` · default ${argument.defaultValue}` : mapping.required ? " · required" : ""}</div>{argument?.description && <div className="mt-1 text-[10px] text-muted-foreground">{argument.description}</div>}</div><Input className="h-8 text-xs" list={`semantic-choices-${mapping.parameter}`} placeholder={argument?.defaultValue !== undefined ? `Model default: ${argument.defaultValue}` : "Value"} value={bound ? "" : inputValue(value)} disabled={Boolean(bound)} onChange={(event) => updateParameter(mapping.parameter, typedValue(event.target.value, argument?.duckdbType), event.target.value === "")} />{argument?.choices?.length ? <datalist id={`semantic-choices-${mapping.parameter}`}>{argument.choices.map((choice) => <option key={choice} value={choice} />)}</datalist> : null}<select aria-label={`Bind ${mapping.parameter} to report parameter`} className="h-8 rounded border bg-background px-2 text-xs" value={bound ? value.report_parameter : ""} onChange={(event) => event.target.value ? updateParameter(mapping.parameter, { report_parameter: event.target.value }) : updateParameter(mapping.parameter, undefined, true)}><option value="">Fixed/default</option>{report.parameters.filter((parameter) => parameter.type !== "date_range").map((parameter) => <option key={parameter.key} value={parameter.key}>${parameter.key}</option>)}</select></div>;
    })}</div></section>}
    <section className="rounded-lg border p-3"><div className="flex items-center gap-2"><Filter className="h-3.5 w-3.5 text-muted-foreground" /><h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Filters</h4><div className="flex-1" />{filters && <Button type="button" size="sm" variant="outline" onClick={addFilter}>Add filter</Button>}</div>{filters === null ? <p className="mt-2 text-xs text-muted-foreground">This query uses an advanced filter expression. Edit it in Advanced JSON to preserve its boolean structure.</p> : filters.length === 0 ? <p className="mt-2 text-xs text-muted-foreground">No filters. Required model filters are checked when you test the dataset.</p> : <div className="mt-3 space-y-2">{filters.map((filter, index) => <div key={index} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_100px_minmax(0,1fr)_auto]"><select className="h-8 rounded border bg-background px-2 text-xs" value={typeof filter.member === "string" ? filter.member : selectionKey(filter.member)} onChange={(event) => { const item = members.find((candidate) => keyOf(candidate) === event.target.value); if (item) updateFilter(index, { member: ref(item) }); }}>{members.filter((item) => item.member.kind !== "measure").map((item) => <option key={keyOf(item)} value={keyOf(item)}>{title(item)} · {item.entity.entityId}</option>)}</select><select className="h-8 rounded border bg-background px-2 text-xs" value={filter.operator} onChange={(event) => updateFilter(index, { operator: event.target.value })}>{["eq", "neq", "gt", "gte", "lt", "lte"].map((operator) => <option key={operator} value={operator}>{operator}</option>)}</select><div className="flex gap-1"><Input className="h-8 text-xs" value={typeof filter.value === "object" ? "" : String(filter.value ?? "")} disabled={typeof filter.value === "object"} onChange={(event) => updateFilter(index, { value: event.target.value })} /><select aria-label="Bind filter to report parameter" className="h-8 max-w-32 rounded border bg-background px-1 text-[10px]" value={filter.value?.report_parameter ?? ""} onChange={(event) => updateFilter(index, { value: event.target.value ? { report_parameter: event.target.value } : "" })}><option value="">Fixed value</option>{report.parameters.filter((parameter) => parameter.type !== "date_range").map((parameter) => <option key={parameter.key} value={parameter.key}>${parameter.key}</option>)}</select></div><Button type="button" size="sm" variant="ghost" onClick={() => removeFilter(index)}>Remove</Button></div>)}</div>}</section>
    <section className="rounded-lg border p-3"><div className="flex items-center"><h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sort results</h4><div className="flex-1" /><Button type="button" size="sm" variant="outline" disabled={order.length >= selectedOutputs.length} onClick={addOrder}>Add sort</Button></div>{order.length === 0 ? <p className="mt-2 text-xs text-muted-foreground">No explicit sort order.</p> : <div className="mt-3 space-y-2">{order.map((item: any, index: number) => <div key={index} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_100px_auto]"><select className="h-8 rounded border bg-background px-2 text-xs" value={item.member} onChange={(event) => updateOrder(index, { member: event.target.value })}>{selectedOutputs.map((name) => <option key={name} value={name}>{name}</option>)}</select><select className="h-8 rounded border bg-background px-2 text-xs" value={item.direction} onChange={(event) => updateOrder(index, { direction: event.target.value })}><option value="asc">Ascending</option><option value="desc">Descending</option></select><Button type="button" size="sm" variant="ghost" onClick={() => removeOrder(index)}>Remove</Button></div>)}</div>}</section>
    <label className="flex max-w-56 items-center gap-2 text-xs"><span className="whitespace-nowrap text-muted-foreground">Maximum rows</span><Input type="number" min={1} max={10000} value={dataset.query.limit ?? 1000} onChange={(event) => updateQuery({ limit: Math.max(1, Math.min(10000, Number(event.target.value) || 1000)) })} /></label>
  </div>;
}
