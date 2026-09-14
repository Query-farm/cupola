import { Button } from "@/components/ui/button";
import type { SemanticEnvironment } from "@/lib/semantic-model";
import type { ReportParameter } from "@/lib/reports/types";
import {
  semanticEntities,
  semanticEntityKey,
  semanticEntityRef,
} from "@/lib/reports/semantic-builder";
import { SemanticFilterEditor } from "./SemanticFilterEditor";
import {
  SemanticSelect,
  SemanticText,
  SemanticSection,
  SemanticValueEditor,
} from "./SemanticFormControls";

interface Props {
  query: Record<string, any>;
  environment: SemanticEnvironment;
  parameters: ReportParameter[];
  onChange: (patch: Record<string, any>) => void;
}

export function SemanticInputsEditor({
  query,
  environment,
  parameters,
  onChange,
}: Props) {
  const inputs: any[] = query.inputs ?? [];
  const bindings: any[] = query.source_bindings ?? [];
  const entities = semanticEntities(environment);
  const functions = entities.filter(
    (entity) => entity.sourceKind === "table_function",
  );
  const nextFunction = functions.find(
    (entity) =>
      !bindings.some(
        (binding) => semanticEntityKey(binding.entity) === entity.key,
      ),
  );
  const entityOptions = entities.map((entity) => ({
    value: entity.key,
    label: `${entity.entityId} · ${entity.catalogId}`,
  }));
  const updateInput = (index: number, patch: Record<string, any>) =>
    onChange({
      inputs: inputs.map((input, position) =>
        position === index ? { ...input, ...patch } : input,
      ),
    });
  const updateBinding = (index: number, patch: Record<string, any>) =>
    onChange({
      source_bindings: bindings.map((binding, position) =>
        position === index ? { ...binding, ...patch } : binding,
      ),
    });
  return (
    <>
      <SemanticSection title="Input tables" open={inputs.length > 0}>
        <p className="text-xs text-muted-foreground">
          Supply up to 100 rows per input to drive a function. Mark the columns
          that uniquely identify each input row. Cells can bind to report
          parameters.
        </p>
        {inputs.map((input, index) => (
          <fieldset
            key={index}
            className="min-w-0 space-y-2 rounded-md border p-3"
          >
            <legend className="px-1 text-xs">Input {index + 1}</legend>
            <SemanticText
              label={`Input ${index + 1} name`}
              value={input.input_id}
              onChange={(input_id) => {
                // Keep references coherent when an input is renamed.
                onChange({
                  inputs: inputs.map((item, position) =>
                    position === index ? { ...item, input_id } : item,
                  ),
                  source_bindings: bindings.map((binding) =>
                    binding.driver.input_id === input.input_id
                      ? { ...binding, driver: { ...binding.driver, input_id } }
                      : binding,
                  ),
                });
              }}
            />
            {input.columns.map((column: any, columnIndex: number) => (
              <div
                key={columnIndex}
                className="grid gap-2 rounded-md bg-muted/20 p-2 sm:grid-cols-2"
              >
                <SemanticText
                  label={`Input ${index + 1} column ${columnIndex + 1} name`}
                  value={column.name}
                  onChange={(name) => {
                    const nextInputs = inputs.map((item, position) =>
                      position === index
                        ? {
                            ...item,
                            columns: input.columns.map(
                              (entry: any, at: number) =>
                                at === columnIndex ? { ...entry, name } : entry,
                            ),
                            grain: input.grain.map((entry: string) =>
                              entry === column.name ? name : entry,
                            ),
                          }
                        : item,
                    );
                    const nextBindings = bindings.map((binding) =>
                      binding.driver.input_id === input.input_id
                        ? {
                            ...binding,
                            arguments: Object.fromEntries(
                              Object.entries(binding.arguments).map(
                                ([key, value]) => [
                                  key,
                                  (value as any).input_column === column.name
                                    ? { input_column: name }
                                    : value,
                                ],
                              ),
                            ),
                          }
                        : binding,
                    );
                    onChange({
                      inputs: nextInputs,
                      source_bindings: nextBindings,
                    });
                  }}
                />
                <SemanticText
                  label={`Input ${index + 1} column ${columnIndex + 1} type`}
                  value={column.type}
                  onChange={(type) =>
                    updateInput(index, {
                      columns: input.columns.map((entry: any, at: number) =>
                        at === columnIndex ? { ...entry, type } : entry,
                      ),
                    })
                  }
                />
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={input.grain.includes(column.name)}
                    onChange={(event) =>
                      updateInput(index, {
                        grain: event.target.checked
                          ? [...input.grain, column.name]
                          : input.grain.filter(
                              (name: string) => name !== column.name,
                            ),
                      })
                    }
                  />
                  Unique key: {column.name}
                </label>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={column.nullable === true}
                    onChange={(event) =>
                      updateInput(index, {
                        columns: input.columns.map((entry: any, at: number) =>
                          at === columnIndex
                            ? { ...entry, nullable: event.target.checked }
                            : entry,
                        ),
                      })
                    }
                  />
                  Allow null: {column.name}
                </label>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={input.columns.length === 1}
                  onClick={() =>
                    updateInput(index, {
                      columns: input.columns.filter(
                        (_: any, at: number) => at !== columnIndex,
                      ),
                      grain: input.grain.filter(
                        (name: string) => name !== column.name,
                      ),
                      rows: input.rows.map((row: any[]) =>
                        row.filter((_, at) => at !== columnIndex),
                      ),
                    })
                  }
                >
                  Remove column {columnIndex + 1}
                </Button>
              </div>
            ))}
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={input.columns.length >= 32}
              onClick={() => {
                let suffix = input.columns.length + 1;
                while (
                  input.columns.some(
                    (column: any) => column.name === `column_${suffix}`,
                  )
                )
                  suffix++;
                updateInput(index, {
                  columns: [
                    ...input.columns,
                    { name: `column_${suffix}`, type: "VARCHAR" },
                  ],
                  rows: input.rows.map((row: any[]) => [...row, ""]),
                });
              }}
            >
              Add input column
            </Button>
            {input.rows.map((row: any[], rowIndex: number) => (
              <fieldset
                key={rowIndex}
                className="space-y-2 rounded-md border p-2"
              >
                <legend className="px-1 text-xs">Row {rowIndex + 1}</legend>
                {input.columns.map((column: any, columnIndex: number) => (
                  <SemanticValueEditor
                    key={columnIndex}
                    label={`${input.input_id} row ${rowIndex + 1} ${column.name}`}
                    value={row[columnIndex]}
                    parameters={parameters}
                    onChange={(value) =>
                      updateInput(index, {
                        rows: input.rows.map((entry: any[], at: number) =>
                          at === rowIndex
                            ? entry.map((cell, cellIndex) =>
                                cellIndex === columnIndex ? value : cell,
                              )
                            : entry,
                        ),
                      })
                    }
                  />
                ))}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={input.rows.length === 1}
                  onClick={() =>
                    updateInput(index, {
                      rows: input.rows.filter(
                        (_: any, at: number) => at !== rowIndex,
                      ),
                    })
                  }
                >
                  Remove row {rowIndex + 1}
                </Button>
              </fieldset>
            ))}
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={input.rows.length >= 100}
                onClick={() =>
                  updateInput(index, {
                    rows: [...input.rows, input.columns.map(() => "")],
                  })
                }
              >
                Add input row
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={bindings.some(
                  (binding) => binding.driver.input_id === input.input_id,
                )}
                onClick={() =>
                  onChange({
                    inputs: inputs.filter((_, position) => position !== index),
                  })
                }
              >
                Remove input
              </Button>
            </div>
          </fieldset>
        ))}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={inputs.length >= 10}
          onClick={() => {
            let suffix = inputs.length + 1;
            while (inputs.some((input) => input.input_id === `input_${suffix}`))
              suffix++;
            onChange({
              inputs: [
                ...inputs,
                {
                  input_id: `input_${suffix}`,
                  grain: ["id"],
                  columns: [{ name: "id", type: "VARCHAR" }],
                  rows: [[""]],
                },
              ],
            });
          }}
        >
          Add input table
        </Button>
      </SemanticSection>

      <SemanticSection title="Function pipelines" open={bindings.length > 0}>
        <p className="text-xs text-muted-foreground">
          Choose a function and the input table or modeled entity that supplies
          its arguments. Entity drivers can include earlier function stages. The
          compiler checks cycles, grain, and invocation limits.
        </p>
        {bindings.map((binding, index) => {
          const target = entities.find(
            (entity) => entity.key === semanticEntityKey(binding.entity),
          );
          const driverEntity = binding.driver.entity
            ? entities.find(
                (entity) =>
                  entity.key === semanticEntityKey(binding.driver.entity),
              )
            : undefined;
          const driverInput = inputs.find(
            (input) => input.input_id === binding.driver.input_id,
          );
          const argumentNames = [
            ...new Set([
              ...(target?.sourceArguments.map((mapping) => mapping.argument) ??
                []),
              ...Object.keys(binding.arguments),
            ]),
          ];
          const driverMembers = driverEntity
            ? [...driverEntity.members.values()]
                .filter((member) => member.kind !== "measure")
                .map((member) => ({
                  value: JSON.stringify({
                    ...semanticEntityRef(driverEntity),
                    member_id: member.member_id,
                  }),
                  label: member.title || member.member_id,
                }))
            : [];
          return (
            <fieldset key={index} className="space-y-3 rounded-md border p-3">
              <legend className="px-1 text-xs">
                Function stage {index + 1}
              </legend>
              <SemanticSelect
                label={`Stage ${index + 1} function`}
                value={semanticEntityKey(binding.entity)}
                options={entityOptions.filter((option) =>
                  functions.some((entity) => entity.key === option.value),
                )}
                onChange={(key) =>
                  key &&
                  updateBinding(index, {
                    entity: semanticEntityRef(
                      entities.find((entity) => entity.key === key)!,
                    ),
                    arguments: {},
                  })
                }
              />
              <SemanticSelect
                label={`Stage ${index + 1} driver`}
                value={
                  binding.driver.input_id
                    ? `input:${binding.driver.input_id}`
                    : binding.driver.entity
                      ? `entity:${semanticEntityKey(binding.driver.entity)}`
                      : ""
                }
                options={[
                  ...inputs.map((input) => ({
                    value: `input:${input.input_id}`,
                    label: `Input: ${input.input_id}`,
                  })),
                  ...entityOptions
                    .filter(
                      (option) =>
                        option.value !== semanticEntityKey(binding.entity),
                    )
                    .map((option) => ({
                      value: `entity:${option.value}`,
                      label: `Entity: ${option.label}`,
                    })),
                ]}
                onChange={(key) =>
                  key &&
                  updateBinding(index, {
                    driver: key.startsWith("input:")
                      ? { input_id: key.slice(6) }
                      : {
                          entity: semanticEntityRef(
                            entities.find(
                              (entity) => entity.key === key.slice(7),
                            )!,
                          ),
                          max_rows: 100,
                        },
                    arguments: {},
                  })
                }
              />
              {driverEntity && (
                <>
                  <SemanticText
                    label={`Stage ${index + 1} maximum driver rows`}
                    value={binding.driver.max_rows}
                    type="number"
                    min={1}
                    max={1000}
                    onChange={(value) =>
                      updateBinding(index, {
                        driver: { ...binding.driver, max_rows: Number(value) },
                      })
                    }
                  />
                  <SemanticFilterEditor
                    label={`Stage ${index + 1} driver filter`}
                    value={binding.driver.filters}
                    members={driverMembers}
                    parameters={parameters}
                    onChange={(filters) =>
                      updateBinding(index, {
                        driver: { ...binding.driver, filters },
                      })
                    }
                  />
                  {(binding.driver.order ?? []).map(
                    (order: any, orderIndex: number) => (
                      <div
                        key={orderIndex}
                        className="grid gap-2 sm:grid-cols-2"
                      >
                        <SemanticSelect
                          label={`Stage ${index + 1} sort ${orderIndex + 1}`}
                          value={order.member_id}
                          options={[...driverEntity.members.values()].map(
                            (member) => ({
                              value: member.member_id,
                              label: member.title || member.member_id,
                            }),
                          )}
                          onChange={(member_id) =>
                            updateBinding(index, {
                              driver: {
                                ...binding.driver,
                                order: binding.driver.order.map(
                                  (item: any, at: number) =>
                                    at === orderIndex
                                      ? { ...item, member_id }
                                      : item,
                                ),
                              },
                            })
                          }
                        />
                        <SemanticSelect
                          label={`Stage ${index + 1} sort ${orderIndex + 1} direction`}
                          value={order.direction}
                          options={[
                            { value: "asc", label: "Ascending" },
                            { value: "desc", label: "Descending" },
                          ]}
                          onChange={(direction) =>
                            updateBinding(index, {
                              driver: {
                                ...binding.driver,
                                order: binding.driver.order.map(
                                  (item: any, at: number) =>
                                    at === orderIndex
                                      ? { ...item, direction }
                                      : item,
                                ),
                              },
                            })
                          }
                        />
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            updateBinding(index, {
                              driver: {
                                ...binding.driver,
                                order: binding.driver.order.filter(
                                  (_: any, at: number) => at !== orderIndex,
                                ),
                              },
                            })
                          }
                        >
                          Remove driver sort
                        </Button>
                      </div>
                    ),
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={(binding.driver.order?.length ?? 0) >= 20}
                    onClick={() =>
                      updateBinding(index, {
                        driver: {
                          ...binding.driver,
                          order: [
                            ...(binding.driver.order ?? []),
                            {
                              member_id: driverEntity.grain[0],
                              direction: "asc",
                            },
                          ],
                        },
                      })
                    }
                  >
                    Add driver sort
                  </Button>
                </>
              )}
              {argumentNames.map((argument) => (
                <SemanticSelect
                  key={argument}
                  label={`Stage ${index + 1} argument ${argument}`}
                  value={
                    binding.arguments[argument]
                      ? JSON.stringify(binding.arguments[argument])
                      : ""
                  }
                  empty="Fixed / model default"
                  options={[
                    ...Object.keys(query.parameters ?? {}).map((parameter) => ({
                      value: JSON.stringify({ parameter }),
                      label: `Parameter: ${parameter}`,
                    })),
                    ...(driverInput?.columns ?? []).map((column: any) => ({
                      value: JSON.stringify({ input_column: column.name }),
                      label: `Input column: ${column.name}`,
                    })),
                    ...driverMembers.map((member) => ({
                      value: JSON.stringify({
                        member: JSON.parse(member.value),
                      }),
                      label: `Driver member: ${member.label}`,
                    })),
                  ]}
                  onChange={(value) => {
                    const args = { ...binding.arguments };
                    if (value) args[argument] = JSON.parse(value);
                    else delete args[argument];
                    updateBinding(index, { arguments: args });
                  }}
                />
              ))}
              <SemanticText
                label={`Stage ${index + 1} maximum output rows`}
                value={binding.max_output_rows}
                type="number"
                min={1}
                max={10000}
                onChange={(value) =>
                  updateBinding(index, {
                    max_output_rows: value ? Number(value) : undefined,
                  })
                }
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() =>
                  onChange({
                    source_bindings: bindings.filter(
                      (_, position) => position !== index,
                    ),
                  })
                }
              >
                Remove stage {index + 1}
              </Button>
            </fieldset>
          );
        })}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={
            !nextFunction ||
            bindings.length >= 10 ||
            (!inputs.length && entities.length < 2)
          }
          onClick={() => {
            const target = nextFunction;
            if (target)
              onChange({
                source_bindings: [
                  ...bindings,
                  {
                    entity: semanticEntityRef(target),
                    driver: inputs[0]
                      ? { input_id: inputs[0].input_id }
                      : {
                          entity: semanticEntityRef(
                            entities.find(
                              (entity) => entity.key !== target.key,
                            ) ?? target,
                          ),
                          max_rows: 100,
                        },
                    arguments: {},
                  },
                ],
              });
          }}
        >
          Add function stage
        </Button>
        <SemanticText
          label="Maximum function invocations"
          value={query.execution_limits?.max_invocations ?? 100}
          type="number"
          min={1}
          max={1000}
          onChange={(value) =>
            onChange({
              execution_limits: {
                ...query.execution_limits,
                max_invocations: Number(value),
              },
            })
          }
        />
        <label className="flex items-start gap-2 text-xs">
          <input
            type="checkbox"
            checked={query.allow_driving_grain_reduction === true}
            onChange={(event) =>
              onChange({ allow_driving_grain_reduction: event.target.checked })
            }
          />
          Allow reduction of the driving grain when the compiler requires
          explicit consent.
        </label>
      </SemanticSection>
    </>
  );
}
