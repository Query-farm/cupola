import { useMemo, useState } from "react";
import { SemanticMemberTree } from "./SemanticMemberTree";
import { Search, ShieldCheck } from "lucide-react";
import type { CatalogData } from "@/lib/service";
import {
  buildSemanticEnvironment,
  type SemanticEntity,
  type SemanticMember,
} from "@/lib/semantic-model";
import type {
  ReportDocumentV1,
  ReportSemanticDataset,
} from "@/lib/reports/types";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { compileSemanticQuery } from "@/lib/semantic-compiler";
import { resolveReportSemanticQuery } from "@/lib/reports/semantic";
import {
  semanticParameterOptions,
  semanticEntityKey,
  semanticEntities,
  renameSemanticOutput,
  semanticBuilderShapeError,
} from "@/lib/reports/semantic-builder";
import { SemanticFilterEditor } from "./SemanticFilterEditor";
import { SemanticFormulaEditor } from "./SemanticFormulaEditor";
import { SemanticInputsEditor } from "./SemanticInputsEditor";
import { SemanticRelationshipEditor } from "./SemanticRelationshipEditor";
import {
  SemanticSelect,
  SemanticText,
  SemanticSection,
  SemanticValueEditor,
  type SemanticChoice,
} from "./SemanticFormControls";

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

const keyOf = (item: MemberItem) =>
  `${item.entity.catalogId}::${item.entity.entityId}::${item.member.member_id}`;
const selectionKey = (selection: any) =>
  `${selection.catalog_id}::${selection.entity_id}::${selection.member_id}`;

function ref(item: MemberItem) {
  return {
    catalog_id: item.entity.catalogId,
    entity_id: item.entity.entityId,
    member_id: item.member.member_id,
  };
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
  if (
    /^(?:UTINYINT|USMALLINT|UINTEGER|UBIGINT|TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|FLOAT|DOUBLE|DECIMAL)/.test(
      normalized,
    )
  ) {
    const number = Number(value);
    return Number.isFinite(number) ? number : value;
  }
  if (normalized === "BOOLEAN") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return value;
}

export function ReportSemanticDatasetBuilder(props: Props) {
  const field = semanticBuilderShapeError(props.dataset.query);
  if (field)
    return (
      <p role="alert" className="mt-3 text-xs text-destructive">
        The shape of “{field}” cannot be displayed. Repair it in Advanced
        semantic JSON below to resume using the builder.
      </p>
    );
  return <SemanticDatasetForm {...props} />;
}

function SemanticDatasetForm({ dataset, report, catalogs, onChange }: Props) {
  const [search, setSearch] = useState("");
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [newParameter, setNewParameter] = useState("");
  const environment = useMemo(
    () => buildSemanticEnvironment(catalogs),
    [catalogs],
  );
  const members = useMemo(
    () =>
      semanticEntities(environment).flatMap((entity) =>
        [...entity.members.values()]
          .filter((member) => !member.hidden)
          .map((member) => ({ entity, member })),
      ),
    [environment],
  );
  const normalizedSearch = search.trim().toLocaleLowerCase("en-US");
  const visible = members.filter(
    (item) =>
      !normalizedSearch ||
      `${title(item)} ${item.member.member_id} ${item.member.description ?? ""} ${item.member.unit ?? ""} ${item.entity.catalogId} ${item.entity.attachmentAlias} ${item.entity.entityId}`
        .toLocaleLowerCase("en-US")
        .includes(normalizedSearch),
  );
  const selectedMeasures = new Map<string, any>(
    (dataset.query.measures ?? []).map((item: any) => [
      selectionKey(item),
      item,
    ]),
  );
  const selectedDimensions = new Map<string, any>(
    (dataset.query.dimensions ?? []).map((item: any) => [
      selectionKey(item),
      item,
    ]),
  );
  const selectedEntityKeys = new Set(
    [...selectedMeasures.keys(), ...selectedDimensions.keys()].map((key) =>
      key.split("::").slice(0, 2).join("::"),
    ),
  );
  for (const binding of dataset.query.source_bindings ?? [])
    selectedEntityKeys.add(semanticEntityKey(binding.entity));
  const sourceParameters = environment.entities
    .filter((entity) =>
      selectedEntityKeys.has(`${entity.catalogId}::${entity.entityId}`),
    )
    .flatMap((entity) =>
      entity.sourceArguments.map((mapping) => ({
        entity,
        mapping,
        argument: entity.functionArguments.find(
          (argument) => argument.name === mapping.argument,
        ),
      })),
    )
    .filter(
      (item, index, all) =>
        all.findIndex(
          (candidate) => candidate.mapping.parameter === item.mapping.parameter,
        ) === index,
    );
  const selectedOutputs = [
    ...(dataset.query.dimensions ?? []),
    ...(dataset.query.measures ?? []),
    ...(dataset.query.derived_measures ?? []).map((formula: any) => ({
      alias: formula.name,
    })),
  ]
    .map((selection: any) => selection.alias || selection.member_id)
    .filter(
      (name: unknown): name is string =>
        typeof name === "string" && name.length > 0,
    );
  const order = Array.isArray(dataset.query.order) ? dataset.query.order : [];

  const measureChoices: (SemanticChoice & { fact: string })[] = (
    dataset.query.measures ?? []
  ).map((selection: any) => {
    const item = members.find(
      (candidate) => keyOf(candidate) === selectionKey(selection),
    );
    return {
      value: selection.alias || selection.member_id,
      label: `${item ? title(item) : selection.member_id} · ${selection.alias || selection.member_id}`,
      fact: semanticEntityKey(selection),
    };
  });
  const compilation = useMemo(() => {
    try {
      const values = Object.fromEntries(
        report.parameters.map((parameter) => [
          parameter.key,
          parameter.defaultValue,
        ]),
      );
      return compileSemanticQuery(
        catalogs,
        resolveReportSemanticQuery(dataset.query, report, values),
      );
    } catch (error) {
      return {
        ok: false as const,
        diagnostics: [
          {
            code: "report_input",
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  }, [catalogs, dataset.query, report]);

  // Optional controls clear properties with undefined. The semantic schema
  // distinguishes a missing property from an explicitly undefined one.
  const updateQuery = (patch: Record<string, any>) =>
    onChange({
      ...dataset,
      query: JSON.parse(JSON.stringify({ ...dataset.query, ...patch })),
      acceptedModelFingerprint: undefined,
    });
  const toggle = (item: MemberItem, kind: "measures" | "dimensions") => {
    const current = [...(dataset.query[kind] ?? [])];
    const key = keyOf(item);
    const index = current.findIndex(
      (selection) => selectionKey(selection) === key,
    );
    if (index >= 0) current.splice(index, 1);
    else {
      const used = new Set(selectedOutputs);
      const fallback = `${item.entity.entityId}_${item.member.member_id}`.replace(/[^A-Za-z0-9_]/g, '_');
      let name = item.member.member_id;
      if (used.has(name)) {
        name = fallback;
        let suffix = 2;
        while (used.has(name)) name = `${fallback}_${suffix++}`;
      }
      current.push({ ...ref(item), ...(name !== item.member.member_id ? { alias: name } : {}) });
    }
    updateQuery({ [kind]: current });
  };
  const updateGranularity = (item: MemberItem, granularity: string) => {
    const current = [...(dataset.query.dimensions ?? [])].map(
      (selection: any) =>
        selectionKey(selection) === keyOf(item)
          ? { ...selection, ...(granularity ? { granularity } : {}) }
          : selection,
    );
    if (!granularity) {
      const selected = current.find(
        (selection: any) => selectionKey(selection) === keyOf(item),
      );
      if (selected) delete selected.granularity;
    }
    updateQuery({ dimensions: current });
  };
  const updateParameter = (
    parameter: string,
    value: unknown,
    remove = false,
  ) => {
    const parameters = { ...(dataset.query.parameters ?? {}) };
    if (remove) delete parameters[parameter];
    else parameters[parameter] = value;
    updateQuery({
      parameters: Object.keys(parameters).length ? parameters : undefined,
    });
  };
  const addOrder = () => {
    const member = selectedOutputs.find(
      (name) => !order.some((item: any) => item.member === name),
    );
    if (member)
      updateQuery({ order: [...order, { member, direction: "asc" }] });
  };
  const updateOrder = (index: number, patch: Record<string, any>) =>
    updateQuery({
      order: order.map((item: any, itemIndex: number) =>
        itemIndex === index ? { ...item, ...patch } : item,
      ),
    });
  const removeOrder = (index: number) => {
    const next = order.filter(
      (_: any, itemIndex: number) => itemIndex !== index,
    );
    updateQuery({ order: next.length ? next : undefined });
  };

  const renderMember = (item: MemberItem, kind: "measures" | "dimensions") => {
    const selected = (
      kind === "measures" ? selectedMeasures : selectedDimensions
    ).get(keyOf(item));
    return (
      <div key={keyOf(item)} className={selected ? "rounded-md border border-primary/30 bg-primary/5 p-2.5" : "rounded-md border border-transparent p-2 hover:bg-muted/40"}>
        <label className="flex cursor-pointer items-start gap-2">
          <input
            type="checkbox"
            className="mt-1"
            checked={Boolean(selected)}
            onChange={() => toggle(item, kind)}
          />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium capitalize">
              {title(item)}
            </span>
            <span className="block text-[10px] text-muted-foreground">
              {item.entity.entityId}
              {item.member.unit ? ` · ${item.member.unit}` : ""}
            </span>
            {item.member.description && (
              <span className="mt-1 block text-xs text-muted-foreground">
                {item.member.description}
              </span>
            )}
          </span>
        </label>
        {selected && (
          <div className="mt-2 space-y-2 pl-6">
            <SemanticText
              label={`${title(item)} output name`}
              value={selected.alias || selected.member_id}
              onChange={(alias) =>
                updateQuery({
                  ...renameSemanticOutput(
                    dataset.query,
                    selected.alias || selected.member_id,
                    alias || selected.member_id,
                  ),
                  [kind]: dataset.query[kind].map((selection: any) =>
                    selectionKey(selection) === keyOf(item)
                      ? { ...selection, alias: alias || undefined }
                      : selection,
                  ),
                })
              }
            />
            {kind === "measures" &&
              (new Set(measureChoices.map((choice) => choice.fact)).size > 1 ||
                selected.missing_fact_value) && (
                <SemanticSelect
                  label={`${title(item)} missing fact value`}
                  value={selected.missing_fact_value}
                  empty="Unspecified"
                  options={[
                    { value: "null", label: "Null (missing stays unknown)" },
                    {
                      value: "zero",
                      label: "Zero (compiler must confirm safe)",
                    },
                  ]}
                  onChange={(missing_fact_value) =>
                    updateQuery({
                      measures: dataset.query.measures.map((selection: any) =>
                        selectionKey(selection) === keyOf(item)
                          ? {
                              ...selection,
                              missing_fact_value:
                                missing_fact_value || undefined,
                            }
                          : selection,
                      ),
                    })
                  }
                />
              )}
          </div>
        )}
        {selected &&
        item.member.kind === "time_dimension" &&
        item.member.granularities?.length ? (
          <label className="mt-2 flex items-center gap-2 pl-6 text-xs">
            <span className="text-muted-foreground">Time grain</span>
            <select
              className="h-7 rounded border bg-background px-2"
              value={selected.granularity ?? ""}
              onChange={(event) => updateGranularity(item, event.target.value)}
            >
              <option value="">Exact time</option>
              {item.member.granularities.map((granularity) => (
                <option key={granularity} value={granularity}>
                  {granularity}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
    );
  };

  return (
    <div data-testid="report-semantic-builder" className="mt-3 space-y-4">
      <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 p-3 text-xs text-emerald-950 dark:border-emerald-900 dark:bg-emerald-950/20 dark:text-emerald-100">
        <div className="flex items-center gap-2 font-medium">
          <ShieldCheck className="h-4 w-4" /> Governed metrics
        </div>
        <p className="mt-1 text-muted-foreground">
          Choose business measures and how to break them down. Cupola validates
          joins, aggregation, required filters, and units before the dataset can
          be applied.
        </p>
      </div>
      <label className="relative block">
        <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          className="pl-8"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label="Find semantic fields"
          placeholder="Search fields, entities, catalogs or units…"
        />
      </label>
      {environment.diagnostics.length > 0 && (
        <details className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs dark:border-amber-800 dark:bg-amber-950/30">
          <summary className="cursor-pointer font-medium">
            {environment.diagnostics.length} semantic model warning
            {environment.diagnostics.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-2 list-disc pl-5">
            {environment.diagnostics.slice(0, 10).map((diagnostic, index) => (
              <li key={`${diagnostic.code}-${index}`}>{diagnostic.message}</li>
            ))}
          </ul>
        </details>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{selectedMeasures.size} measures · {selectedDimensions.size} dimensions selected</span>
        <Button size="sm" variant={selectedOnly ? 'secondary' : 'outline'} aria-pressed={selectedOnly} onClick={() => setSelectedOnly(!selectedOnly)}>Selected only</Button>
      </div>
      <SemanticMemberTree
        items={selectedOnly ? visible.filter(item => selectedMeasures.has(keyOf(item)) || selectedDimensions.has(keyOf(item))) : visible}
        selected={new Set([...selectedMeasures.keys(), ...selectedDimensions.keys()])}
        searching={Boolean(normalizedSearch) || selectedOnly}
        searchKey={`${selectedOnly}:${normalizedSearch}`}
        renderMember={renderMember}
      />
      {sourceParameters.length > 0 && (
        <section className="rounded-lg border p-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Function parameters
          </h4>
          <p className="mt-1 text-xs text-muted-foreground">
            Leave a value blank to use the model-discovered default, or bind it
            to a report control.
          </p>
          <div className="mt-3 space-y-3">
            {sourceParameters.map(({ entity, mapping, argument }) => {
              const value = dataset.query.parameters?.[mapping.parameter];
              const bound =
                value &&
                typeof value === "object" &&
                "report_parameter" in value;
              return (
                <div
                  key={mapping.parameter}
                  className="grid gap-2 rounded-md bg-muted/20 p-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_150px]"
                >
                  <div>
                    <div className="text-xs font-medium">
                      {mapping.parameter.replaceAll("_", " ")}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      {entity.entityId} ·{" "}
                      {argument?.duckdbType ?? "unknown type"}
                      {argument?.defaultValue !== undefined
                        ? ` · default ${argument.defaultValue}`
                        : mapping.required
                          ? " · required"
                          : ""}
                    </div>
                    {argument?.description && (
                      <div className="mt-1 text-[10px] text-muted-foreground">
                        {argument.description}
                      </div>
                    )}
                  </div>
                  <Input
                    className="h-8 text-xs"
                    list={`semantic-choices-${mapping.parameter}`}
                    placeholder={
                      argument?.defaultValue !== undefined
                        ? `Model default: ${argument.defaultValue}`
                        : "Value"
                    }
                    value={bound ? "" : inputValue(value)}
                    disabled={Boolean(bound)}
                    onChange={(event) =>
                      updateParameter(
                        mapping.parameter,
                        typedValue(event.target.value, argument?.duckdbType),
                        event.target.value === "",
                      )
                    }
                  />
                  {argument?.choices?.length ? (
                    <datalist id={`semantic-choices-${mapping.parameter}`}>
                      {argument.choices.map((choice) => (
                        <option key={choice} value={choice} />
                      ))}
                    </datalist>
                  ) : null}
                  <select
                    aria-label={`Bind ${mapping.parameter} to report parameter`}
                    className="h-8 rounded border bg-background px-2 text-xs"
                    value={bound ? JSON.stringify(value) : ""}
                    onChange={(event) =>
                      event.target.value
                        ? updateParameter(
                            mapping.parameter,
                            JSON.parse(event.target.value),
                          )
                        : updateParameter(mapping.parameter, undefined, true)
                    }
                  >
                    <option value="">Fixed/default</option>
                    {semanticParameterOptions(report.parameters).map(
                      (option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ),
                    )}
                  </select>
                </div>
              );
            })}
          </div>
        </section>
      )}
      <SemanticSection
        title="Additional query parameters"
        open={Object.keys(dataset.query.parameters ?? {}).some(
          (name) =>
            !sourceParameters.some((item) => item.mapping.parameter === name),
        )}
      >
        {Object.entries(dataset.query.parameters ?? {})
          .filter(
            ([name]) =>
              !sourceParameters.some((item) => item.mapping.parameter === name),
          )
          .map(([name, value]) => (
            <div key={name} className="space-y-2">
              <SemanticValueEditor
                label={`Parameter ${name}`}
                value={value}
                parameters={report.parameters}
                onChange={(next) => updateParameter(name, next)}
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => updateParameter(name, undefined, true)}
              >
                Remove parameter {name}
              </Button>
            </div>
          ))}
        <SemanticText
          label="New query parameter name"
          value={newParameter}
          onChange={setNewParameter}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={
            !newParameter.trim() ||
            newParameter in (dataset.query.parameters ?? {})
          }
          onClick={() => {
            updateParameter(newParameter.trim(), "");
            setNewParameter("");
          }}
        >
          Add query parameter
        </Button>
      </SemanticSection>
      <SemanticSection title="Filters" open={Boolean(dataset.query.filters)}>
        <SemanticFilterEditor
          label="Filter"
          value={dataset.query.filters}
          members={members
            .filter((item) => item.member.kind !== "measure")
            .map((item) => ({
              value: JSON.stringify(ref(item)),
              label: `${title(item)} · ${item.entity.entityId}`,
            }))}
          parameters={report.parameters}
          onChange={(filters) => updateQuery({ filters })}
        />
      </SemanticSection>
      <SemanticSection
        title="Filters after aggregation"
        open={Boolean(dataset.query.measure_filters)}
      >
        <SemanticFilterEditor
          label="Measure filter"
          value={dataset.query.measure_filters}
          members={measureChoices.map((item) => ({
            ...item,
            value: JSON.stringify(item.value),
          }))}
          parameters={report.parameters}
          onChange={(measure_filters) => updateQuery({ measure_filters })}
        />
      </SemanticSection>
      <SemanticRelationshipEditor
        query={dataset.query}
        environment={environment}
        onChange={updateQuery}
      />
      <SemanticSection
        title="Calculated measures"
        open={Boolean(dataset.query.derived_measures?.length)}
      >
        <SemanticFormulaEditor
          formulas={dataset.query.derived_measures ?? []}
          measures={measureChoices}
          parameters={report.parameters}
          onChange={(derived_measures) => {
            let next = dataset.query;
            if (
              derived_measures.length ===
              (dataset.query.derived_measures?.length ?? 0)
            )
              derived_measures.forEach((formula, index) => {
                next = renameSemanticOutput(
                  next,
                  dataset.query.derived_measures[index].name,
                  formula.name,
                );
              });
            updateQuery({ ...next, derived_measures });
          }}
        />
      </SemanticSection>
      <SemanticInputsEditor
        query={dataset.query}
        environment={environment}
        parameters={report.parameters}
        onChange={updateQuery}
      />
      <section className="rounded-lg border p-3">
        <div className="flex items-center">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Sort results
          </h4>
          <div className="flex-1" />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={order.length >= selectedOutputs.length}
            onClick={addOrder}
          >
            Add sort
          </Button>
        </div>
        {order.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            No explicit sort order.
          </p>
        ) : (
          <div className="mt-3 space-y-2">
            {order.map((item: any, index: number) => (
              <div
                key={index}
                className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_100px_auto]"
              >
                <select
                  className="h-8 rounded border bg-background px-2 text-xs"
                  value={item.member}
                  onChange={(event) =>
                    updateOrder(index, { member: event.target.value })
                  }
                >
                  {selectedOutputs.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
                <select
                  className="h-8 rounded border bg-background px-2 text-xs"
                  value={item.direction}
                  onChange={(event) =>
                    updateOrder(index, { direction: event.target.value })
                  }
                >
                  <option value="asc">Ascending</option>
                  <option value="desc">Descending</option>
                </select>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => removeOrder(index)}
                >
                  Remove
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>
      <div
        data-testid="semantic-query-validation"
        role="status"
        className={`rounded-md border p-3 text-xs ${compilation.ok ? "bg-emerald-50/50 dark:bg-emerald-950/20" : "bg-amber-50/50 dark:bg-amber-950/20"}`}
      >
        {compilation.ok ? (
          <>
            <p className="font-medium">Model validation passed</p>
            <p>
              {compilation.plan.fact_branches.length} fact source(s) ·{" "}
              {compilation.plan.outputs?.length ?? 0} output columns. Test the
              dataset to verify live data.
            </p>
            {compilation.plan.warnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </>
        ) : (
          <>
            <p className="font-medium">Complete the query setup</p>
            <ul className="mt-1 list-disc pl-4">
              {compilation.diagnostics.map((diagnostic, index) => (
                <li key={index}>{diagnostic.message}</li>
              ))}
            </ul>
          </>
        )}
      </div>
      <label className="flex max-w-56 items-center gap-2 text-xs">
        <span className="whitespace-nowrap text-muted-foreground">
          Maximum rows
        </span>
        <Input
          type="number"
          min={1}
          max={10000}
          value={dataset.query.limit ?? 1000}
          onChange={(event) =>
            updateQuery({
              limit: Math.max(
                1,
                Math.min(10000, Number(event.target.value) || 1000),
              ),
            })
          }
        />
      </label>
    </div>
  );
}
