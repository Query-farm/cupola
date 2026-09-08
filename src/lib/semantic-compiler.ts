import { quoteIdent, quoteLiteral } from "./duckdb-query";
import {
  buildSemanticEnvironment,
  resolveEntity,
  resolveNestedType,
  type SemanticDiagnostic,
  type SemanticEntity,
  type SemanticEnvironment,
  type SemanticExpression,
  type SemanticMember,
  type SemanticMemberFilter,
  type SemanticRef,
  type SemanticRelationship,
} from "./semantic-model";
import type { CatalogData } from "./service";
import { validateSemanticValue } from "./semantic-validation";

export interface SemanticSelection extends SemanticRef {
  member_id: string;
  alias?: string;
  relationship_path?: string[];
  branch_relationship_paths?: Array<{
    root: SemanticRef;
    relationship_path: string[];
  }>;
  branch_members?: Array<{
    root: SemanticRef;
    member: SemanticRef & { member_id: string };
    relationship_path?: string[];
  }>;
  granularity?: string;
  missing_fact_value?: "null" | "zero";
}
export type SemanticFilterMember =
  | string
  | (SemanticRef & { member_id: string; relationship_path?: string[] });
export type SemanticFilter =
  | { and: SemanticFilter[] }
  | { or: SemanticFilter[] }
  | {
      member: SemanticFilterMember;
      operator: string;
      value?: unknown;
      values?: unknown[];
    };
export interface SemanticInput {
  input_id: string;
  grain: string[];
  columns: Array<{ name: string; type: string; nullable?: boolean }>;
  rows: unknown[][];
}
export type SemanticSourceArgumentBinding =
  | { parameter: string }
  | { input_column: string }
  | { member: SemanticRef & { member_id: string } };
export interface SemanticSourceBinding {
  entity: SemanticRef;
  driver:
    | { input_id: string }
    | {
        entity: SemanticRef;
        max_rows: number;
        filters?: SemanticFilter;
        order?: Array<{ member_id: string; direction: "asc" | "desc" }>;
      };
  arguments: Record<string, SemanticSourceArgumentBinding>;
  max_output_rows?: number;
}
export interface SemanticQuery {
  measures?: SemanticSelection[];
  dimensions?: SemanticSelection[];
  filters?: SemanticFilter;
  measure_filters?: SemanticFilter;
  derived_measures?: Array<{
    name: string;
    expression: SemanticExpression;
    output_type: string;
    unit?: string;
  }>;
  order?: Array<{ member: string; direction: "asc" | "desc" }>;
  limit?: number;
  compile_only?: boolean;
  root_entity?: SemanticRef;
  bindings?: Record<string, string>;
  parameters?: Record<string, unknown>;
  inputs?: SemanticInput[];
  source_bindings?: SemanticSourceBinding[];
  allow_driving_grain_reduction?: boolean;
  execution_limits?: { max_invocations?: number };
}
export interface SemanticPlan {
  fact_branches: Array<{
    root: SemanticRef;
    attachment_alias: string;
    entities: string[];
    driver?: Record<string, unknown>;
    invocations: Array<Record<string, unknown>>;
    effective_source_grain: Array<{
      source: string;
      member: string;
      output_name: string;
    }>;
    result_grain: string[];
    estimated_invocations: number;
    driving_grain_reduced: boolean;
  }>;
  stitch?: {
    strategy: "conformed_dimension_spine";
    result_grain: string[];
    branch_roots: SemanticRef[];
    measure_branches: Record<string, SemanticRef>;
    missing_fact_values: Record<string, "null" | "zero">;
    derived_measures?: Array<{ name: string; output_type: string }>;
  };
  sql: string;
  parameters: unknown[];
  validation_scope: "semantic";
  warnings: string[];
  output_units?: Record<string, string | null>;
  unit_diagnostics?: SemanticDiagnostic[];
}
export type SemanticCompileResult =
  | { ok: true; plan: SemanticPlan }
  | { ok: false; diagnostics: SemanticDiagnostic[] };

class CompileFailure extends Error {
  constructor(readonly diagnostic: SemanticDiagnostic) {
    super(diagnostic.message);
  }
}
const fail = (
  stage:
    | SemanticDiagnostic["stage"]
    | "request_validation"
    | "multi_fact_not_supported"
    | "type_check"
    | "fanout"
    | "required_filter"
    | "sql_generation",
  code: string,
  message: string,
): never => {
  throw new CompileFailure({ stage: stage as any, code, message });
};
const refKey = (value: SemanticRef) =>
  `${value.catalog_id}::${value.entity_id}`;
const entityMarker = (entity: SemanticEntity) =>
  `${entity.attachmentAlias}:${entity.key}`;
const MAX_INLINE_ROWS = 100,
  MAX_INLINE_COLUMNS = 32,
  MAX_INLINE_CELLS = 3200,
  MAX_INLINE_BYTES = 1_000_000;
const DEFAULT_MAX_INVOCATIONS = 100,
  HARD_MAX_INVOCATIONS = 1000,
  DEFAULT_MAX_STAGE_ROWS = 10_000,
  MAX_FACT_BRANCHES = 10;
type SourceArgumentRenderer = (
  entity: SemanticEntity,
  member: SemanticMember,
) => string;
function safeType(type: string): string {
  if (
    !/^[A-Za-z][A-Za-z0-9_ ]*(?:\([0-9]+(?:,[0-9]+)?\))?(?:\[\])?$/.test(type)
  ) {
    fail(
      "type_check",
      "invalid_output_type",
      `Unsafe or unsupported DuckDB type '${type}'`,
    );
  }
  return type;
}

function literalSql(value: string | number | boolean | null): string {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number")
    return Number.isFinite(value)
      ? String(value)
      : fail(
          "type_check",
          "invalid_number",
          "Expression literals must be finite numbers",
        );
  return quoteLiteral(value);
}

function resolvedSourceArguments(entity: SemanticEntity) {
  if (!entity.sourceArguments.length) return [];
  if (!entity.functionArguments.length)
    fail(
      "model_resolution",
      "missing_function_argument_metadata",
      `Table function '${entity.entityId}' requires vgi_function_arguments() metadata`,
    );
  const fieldIndexes = entity.functionArguments.flatMap((argument) =>
    argument.fieldIndex == null ? [] : [argument.fieldIndex],
  );
  if (
    entity.functionOverloadCount > 1 ||
    new Set(fieldIndexes).size !== fieldIndexes.length
  )
    fail(
      "model_resolution",
      "ambiguous_function_overload",
      `Table function '${entity.entityId}' has ambiguous overload metadata`,
    );
  if (entity.functionArguments.some((argument) => argument.isVarargs))
    fail(
      "model_resolution",
      "unsupported_function_varargs",
      `Table function '${entity.entityId}' uses unsupported varargs`,
    );
  if (entity.functionArguments.some((argument) => argument.isTableInput))
    fail(
      "model_resolution",
      "unsupported_table_input",
      `Table function '${entity.entityId}' requires an unsupported table input`,
    );
  const byName = new Map<string, typeof entity.functionArguments>();
  for (const argument of entity.functionArguments)
    byName.set(argument.name, [...(byName.get(argument.name) ?? []), argument]);
  return entity.sourceArguments.map((mapping) => {
    const matches = byName.get(mapping.argument) ?? [];
    if (!matches.length)
      fail(
        "model_resolution",
        "unknown_source_argument",
        `Source mapping references unknown function argument '${mapping.argument}'`,
      );
    if (matches.length > 1)
      fail(
        "model_resolution",
        "ambiguous_source_argument",
        `Source argument '${mapping.argument}' resolves to more than one overload`,
      );
    const argument = matches[0];
    if (Boolean(argument.named) === Boolean(argument.positional))
      fail(
        "model_resolution",
        "invalid_source_argument_kind",
        `Source argument '${mapping.argument}' is not unambiguously named or positional`,
      );
    if (argument.positional && argument.position == null)
      fail(
        "model_resolution",
        "missing_source_argument_position",
        `Positional source argument '${mapping.argument}' has no arg_position`,
      );
    return { mapping, argument };
  });
}

function sourceSql(
  entity: SemanticEntity,
  query: SemanticQuery,
  parameters: unknown[],
): string {
  const qualified = `${quoteIdent(entity.attachmentAlias)}.${quoteIdent(entity.schemaName)}.${quoteIdent(entity.sourceName)}`;
  if (entity.sourceKind === "relation") return qualified;
  const bindings = resolvedSourceArguments(entity);
  const positional = bindings
    .filter(({ argument }) => argument.positional)
    .sort((left, right) => left.argument.position! - right.argument.position!);
  const named = bindings
    .filter(({ argument }) => argument.named)
    .sort(
      (left, right) =>
        (left.argument.fieldIndex ?? Number.MAX_SAFE_INTEGER) -
          (right.argument.fieldIndex ?? Number.MAX_SAFE_INTEGER) ||
        left.argument.name.localeCompare(right.argument.name),
    );
  const supplied = query.parameters ?? {};
  const suppliedPositions = new Set(
    positional
      .filter(({ mapping }) => mapping.parameter in supplied)
      .map(({ argument }) => argument.position!),
  );
  if (suppliedPositions.size) {
    const highest = Math.max(...suppliedPositions);
    const missing = entity.functionArguments
      .filter(
        (argument) =>
          argument.positional &&
          argument.position != null &&
          argument.position < highest &&
          !suppliedPositions.has(argument.position),
      )
      .sort((left, right) => left.position! - right.position!)
      .map((argument) => argument.name);
    if (missing.length)
      fail(
        "model_resolution",
        "optional_positional_hole",
        `Cannot supply a later positional table-function argument while omitting earlier arguments ${JSON.stringify(missing)}`,
      );
  }
  const args = [...positional, ...named].flatMap(({ mapping, argument }) => {
    if (!(mapping.parameter in (query.parameters ?? {}))) {
      if (mapping.required !== false)
        fail(
          "required_filter",
          "missing_source_parameter",
          `Table function argument '${mapping.argument}' requires semantic parameter '${mapping.parameter}'`,
        );
      return [];
    }
    if (
      !valueCompatible(
        query.parameters![mapping.parameter],
        argument.duckdbType,
      )
    )
      fail(
        "type_check",
        "incompatible_parameter_type",
        `Parameter '${mapping.parameter}' is incompatible with argument '${argument.name}'`,
      );
    parameters.push(query.parameters![mapping.parameter]);
    return [argument.named ? `${quoteIdent(argument.name)} := ?` : "?"];
  });
  return `${qualified}(${args.join(", ")})`;
}

const qualifiedSource = (entity: SemanticEntity) =>
  `${quoteIdent(entity.attachmentAlias)}.${quoteIdent(entity.schemaName)}.${quoteIdent(entity.sourceName)}`;
const pathAlias = (base: string, path: string[]) =>
  base +
  path
    .map(quoteIdent)
    .map((part) => `.${part}`)
    .join("");
const memberColumnPath = (member: SemanticMember): string[] =>
  member.column_path ?? (member.column ? [member.column] : []);
const memberColumnSql = (alias: string, member: SemanticMember) =>
  [alias, ...memberColumnPath(member).map(quoteIdent)].join(".");
const memberPhysicalKey = (member: SemanticMember) =>
  memberColumnPath(member).join(".");

function normalizedType(value?: string): string {
  const raw = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
  return (
    (
      {
        STRING: "VARCHAR",
        TEXT: "VARCHAR",
        INT: "INTEGER",
        INT4: "INTEGER",
        INT8: "BIGINT",
        FLOAT: "REAL",
        FLOAT8: "DOUBLE",
        BOOL: "BOOLEAN",
      } as Record<string, string>
    )[raw] ?? raw
  );
}

function typesCompatible(source?: string, target?: string): boolean {
  const left = normalizedType(source),
    right = normalizedType(target);
  if (!left || !right || right === "ANY" || left === right) return true;
  const numeric = [
    "TINYINT",
    "SMALLINT",
    "INTEGER",
    "BIGINT",
    "HUGEINT",
    "REAL",
    "DOUBLE",
  ];
  return (
    numeric.includes(left) &&
    numeric.includes(right) &&
    numeric.indexOf(left) <= numeric.indexOf(right)
  );
}

function valueCompatible(value: unknown, target?: string): boolean {
  if (value == null || !target) return true;
  const type = normalizedType(target);
  if (type === "ANY") return true;
  if (type === "BOOLEAN") return typeof value === "boolean";
  if (/^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT)/.test(type))
    return typeof value === "number" && Number.isInteger(value);
  if (/^(REAL|DOUBLE|DECIMAL|NUMERIC)/.test(type))
    return typeof value === "number" && Number.isFinite(value);
  if (/^(VARCHAR|CHAR|TEXT|DATE|TIME|TIMESTAMP|UUID)/.test(type))
    return typeof value === "string";
  if (type.endsWith("[]")) return Array.isArray(value);
  if (/^(STRUCT|MAP|JSON)/.test(type))
    return typeof value === "object" || typeof value === "string";
  return true;
}

function memberType(
  entity: SemanticEntity,
  member: SemanticMember,
): string | undefined {
  if (member.output_type || member.data_type)
    return member.output_type ?? member.data_type;
  const path = memberColumnPath(member);
  const physicalType = entity.columns.find(
    (column) => column.name === path[0],
  )?.duckdbType;
  return path.length > 1 && physicalType
    ? (resolveNestedType(physicalType, path.slice(1)) ?? undefined)
    : physicalType;
}

function memberUnitDefinition(
  entity: SemanticEntity,
  member: SemanticMember,
  visited = new Set<string>(),
):
  | { kind: "static"; value: string }
  | { kind: "dynamic"; value: NonNullable<SemanticMember["unit_parameter"]> }
  | null {
  if (visited.has(member.member_id)) return null;
  if (member.unit !== undefined) return { kind: "static", value: member.unit };
  if (member.unit_parameter)
    return { kind: "dynamic", value: member.unit_parameter };
  if (
    member.kind === "measure" &&
    ["sum", "min", "max", "avg"].includes(member.aggregation ?? "") &&
    member.member
  ) {
    const source = entity.members.get(member.member);
    if (source)
      return memberUnitDefinition(
        entity,
        source,
        new Set([...visited, member.member_id]),
      );
  }
  return null;
}

function memberUsesSourceArgument(
  entity: SemanticEntity,
  member: SemanticMember,
  visited = new Set<string>(),
): boolean {
  if (visited.has(member.member_id)) return false;
  if (member.source_argument) return true;
  const nextVisited = new Set([...visited, member.member_id]);
  const visitExpression = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(visitExpression);
    if (!value || typeof value !== "object") return false;
    const expression = value as Record<string, unknown>;
    if (expression.op === "member" && typeof expression.member === "string") {
      const dependency = entity.members.get(expression.member);
      if (
        dependency &&
        memberUsesSourceArgument(entity, dependency, nextVisited)
      )
        return true;
    }
    return Object.values(expression).some(visitExpression);
  };
  return visitExpression(member.expression);
}

function sourceBindingArgument(
  entity: SemanticEntity,
  query: SemanticQuery,
  argumentName: string,
): SemanticSourceArgumentBinding | undefined {
  return query.source_bindings?.find(
    (binding) => refKey(binding.entity) === entity.key,
  )?.arguments[argumentName];
}

function resolveOutputUnit(
  entity: SemanticEntity,
  member: SemanticMember,
  outputName: string,
  query: SemanticQuery,
): { declared: boolean; unit: string | null; diagnostic?: SemanticDiagnostic } {
  const definition = memberUnitDefinition(entity, member);
  if (!definition) return { declared: false, unit: null };
  if (definition.kind === "static")
    return { declared: true, unit: definition.value };
  const argumentName = definition.value.argument;
  const argumentsFound = entity.functionArguments.filter(
    (argument) => argument.name === argumentName,
  );
  if (argumentsFound.length !== 1)
    fail(
      "unit_resolution",
      "unit_parameter_argument_unavailable",
      `Cannot resolve unit argument '${argumentName}' for output '${outputName}'`,
    );
  const mapping = entity.sourceArguments.find(
    (candidate) => candidate.argument === argumentName,
  );
  if (!mapping)
    fail(
      "unit_resolution",
      "unit_parameter_source_unmapped",
      `Unit argument '${argumentName}' is not exposed by the semantic source`,
    );
  const binding = sourceBindingArgument(entity, query, argumentName);
  const correlated = Boolean(
    binding && ("input_column" in binding || "member" in binding),
  );
  const parameterName =
    binding && "parameter" in binding ? binding.parameter : mapping!.parameter;
  const supplied = query.parameters ?? {};
  let effective = Object.prototype.hasOwnProperty.call(supplied, parameterName)
    ? supplied[parameterName]
    : undefined;
  if (correlated) effective = undefined;
  if (effective === undefined && !correlated)
    effective = argumentsFound[0].defaultValue;
  const path = `${entity.key}::${member.member_id}`;
  if (effective === undefined) {
    return {
      declared: true,
      unit: null,
      diagnostic: {
        stage: "unit_resolution",
        code: "unit_parameter_value_unresolved",
        message: `Unit for output '${outputName}' depends on argument '${argumentName}', whose effective value is unavailable`,
        path,
      },
    };
  }
  const key =
    typeof effective === "string" ? effective : JSON.stringify(effective);
  if (!(key in definition.value.values))
    fail(
      "unit_resolution",
      "unit_parameter_value_unmapped",
      `Unit argument '${argumentName}' has unmapped effective value '${key}'`,
    );
  return { declared: true, unit: definition.value.values[key] };
}

function validateInputs(query: SemanticQuery): Map<string, SemanticInput> {
  const inputs = new Map<string, SemanticInput>();
  let cells = 0,
    bytes = 0;
  for (const input of query.inputs ?? []) {
    if (inputs.has(input.input_id))
      fail(
        "source_binding",
        "duplicate_input",
        `Duplicate input_id '${input.input_id}'`,
      );
    if (
      input.columns.length > MAX_INLINE_COLUMNS ||
      input.rows.length > MAX_INLINE_ROWS
    )
      fail(
        "execution_limit",
        "inline_input_limit",
        `Input '${input.input_id}' exceeds inline limits`,
      );
    const names = input.columns.map((column) => column.name);
    if (new Set(names).size !== names.length)
      fail(
        "source_binding",
        "duplicate_input_column",
        `Input '${input.input_id}' has duplicate columns`,
      );
    const missingGrain = input.grain.filter((name) => !names.includes(name));
    if (missingGrain.length)
      fail(
        "source_binding",
        "unknown_input_grain",
        `Input '${input.input_id}' grain references ${JSON.stringify(missingGrain)}`,
      );
    const grainIndexes = input.grain.map((name) => names.indexOf(name));
    const grainValues = new Set<string>();
    input.rows.forEach((row, rowIndex) => {
      if (row.length !== input.columns.length)
        fail(
          "source_binding",
          "input_row_width",
          `Input '${input.input_id}' row ${rowIndex} has the wrong width`,
        );
      row.forEach((value, index) => {
        if (value == null && input.columns[index].nullable !== true)
          fail(
            "type_check",
            "null_input_value",
            `Input '${input.input_id}' column '${names[index]}' is not nullable`,
          );
        if (value != null && !valueCompatible(value, input.columns[index].type))
          fail(
            "type_check",
            "incompatible_input_value",
            `Input '${input.input_id}' row ${rowIndex} column '${names[index]}' does not match '${input.columns[index].type}'`,
          );
      });
      const keyValues = grainIndexes.map((index) => row[index]);
      if (keyValues.some((value) => value == null))
        fail(
          "source_binding",
          "null_input_grain",
          `Input '${input.input_id}' grain cannot contain NULL`,
        );
      const key = JSON.stringify(keyValues);
      if (grainValues.has(key))
        fail(
          "source_binding",
          "duplicate_input_grain",
          `Input '${input.input_id}' grain is not unique`,
        );
      grainValues.add(key);
    });
    cells += input.columns.length * input.rows.length;
    bytes += new TextEncoder().encode(JSON.stringify(input.rows)).byteLength;
    inputs.set(input.input_id, input);
  }
  if (cells > MAX_INLINE_CELLS || bytes > MAX_INLINE_BYTES)
    fail(
      "execution_limit",
      "inline_input_payload_limit",
      "Inline inputs exceed the request payload limit",
    );
  return inputs;
}

type InvocationBinding = {
  entity: SemanticEntity;
  driverEntity?: SemanticEntity;
  inputId?: string;
  definition: SemanticSourceBinding;
};

function resolveOrFail(
  environment: SemanticEnvironment,
  ref: SemanticRef,
  bindings: Record<string, string>,
): SemanticEntity {
  const entity = resolveEntity(environment, ref, bindings);
  if ("stage" in entity) throw new CompileFailure(entity);
  return entity;
}

function resolveInvocationChain(
  environment: SemanticEnvironment,
  root: SemanticEntity,
  query: SemanticQuery,
  inputs: Map<string, SemanticInput>,
): InvocationBinding[] {
  const byTarget = new Map<string, InvocationBinding>();
  for (const definition of query.source_bindings ?? []) {
    const entity = resolveOrFail(
      environment,
      definition.entity,
      query.bindings ?? {},
    );
    const marker = entityMarker(entity);
    if (byTarget.has(marker))
      fail(
        "source_binding",
        "duplicate_source_binding",
        `Entity '${entity.entityId}' has multiple source bindings`,
      );
    if (entity.sourceKind !== "table_function")
      fail(
        "source_binding",
        "binding_target_not_function",
        `Entity '${entity.entityId}' is not a table function`,
      );
    if ("input_id" in definition.driver) {
      if (!inputs.has(definition.driver.input_id))
        fail(
          "source_binding",
          "unknown_input",
          `Unknown input_id '${definition.driver.input_id}'`,
        );
      byTarget.set(marker, {
        entity,
        inputId: definition.driver.input_id,
        definition,
      });
    } else {
      byTarget.set(marker, {
        entity,
        driverEntity: resolveOrFail(
          environment,
          definition.driver.entity,
          query.bindings ?? {},
        ),
        definition,
      });
    }
  }
  const chain: InvocationBinding[] = [],
    visiting = new Set<string>(),
    used = new Set<string>();
  const visit = (entity: SemanticEntity) => {
    const marker = entityMarker(entity),
      binding = byTarget.get(marker);
    if (!binding) return;
    if (visiting.has(marker))
      fail(
        "source_binding",
        "correlation_cycle",
        `Correlation cycle includes '${entity.entityId}'`,
      );
    visiting.add(marker);
    if (binding.driverEntity) visit(binding.driverEntity);
    visiting.delete(marker);
    used.add(marker);
    chain.push(binding);
  };
  visit(root);
  const unused = [...byTarget.keys()]
    .filter((marker) => !used.has(marker))
    .sort();
  if (unused.length)
    fail(
      "source_binding",
      "unused_source_binding",
      `Source bindings are not on the root invocation path: ${JSON.stringify(unused)}`,
    );
  const usedInputs = new Set(
    chain.flatMap((item) => (item.inputId ? [item.inputId] : [])),
  );
  const unusedInputs = [...inputs.keys()]
    .filter((id) => !usedInputs.has(id))
    .sort();
  if (unusedInputs.length)
    fail(
      "source_binding",
      "unused_input",
      `Inputs are not used by the root invocation path: ${JSON.stringify(unusedInputs)}`,
    );
  if (usedInputs.size > 1)
    fail(
      "source_binding",
      "multiple_driving_inputs",
      "One invocation path may use only one inline input",
    );
  return chain;
}

function correlatedCallSql(
  binding: InvocationBinding,
  query: SemanticQuery,
  parameters: unknown[],
  driverAlias: string,
  driverPaths: Map<string, string[]>,
  inputColumns: Map<string, SemanticInput["columns"][number]>,
): { sql: string; plan: Array<Record<string, unknown>> } {
  const entity = binding.entity;
  const mappings = new Map(
    resolvedSourceArguments(entity).map(({ mapping }) => [
      mapping.argument,
      mapping,
    ]),
  );
  const argumentsByName = new Map(
    entity.functionArguments.map((argument) => [argument.name, argument]),
  );
  const unknown = Object.keys(binding.definition.arguments)
    .filter((name) => !argumentsByName.has(name))
    .sort();
  if (unknown.length)
    fail(
      "source_binding",
      "unknown_bound_argument",
      `Bindings reference unknown arguments ${JSON.stringify(unknown)}`,
    );
  const supplied = query.parameters ?? {};
  const rendered = new Map<
    string,
    { sql: string; detail: Record<string, unknown>; value?: unknown }
  >();
  let correlated = false;
  for (const argument of entity.functionArguments) {
    const override = binding.definition.arguments[argument.name];
    if (override && ("input_column" in override || "member" in override)) {
      correlated = true;
      if (entity.inputFromArgs === null)
        fail(
          "source_binding",
          "correlated_input_capability_unknown",
          `Function '${entity.entityId}' was loaded without input_from_args capability metadata; upgrade the VGI extension/runtime`,
        );
      if (entity.inputFromArgs === false)
        fail(
          "source_binding",
          "correlated_input_not_supported",
          `Function '${entity.entityId}' does not advertise input_from_args`,
        );
      if (!argument.positional || argument.position == null || argument.isConst)
        fail(
          "source_binding",
          "invalid_correlated_argument",
          `Argument '${argument.name}' cannot be column-bound`,
        );
      if ("input_column" in override) {
        if (!binding.inputId)
          fail(
            "source_binding",
            "input_binding_wrong_driver",
            `Argument '${argument.name}' requires an inline-input driver`,
          );
        const column = inputColumns.get(override.input_column);
        if (!column)
          fail(
            "source_binding",
            "unknown_input_column",
            `Unknown input column '${override.input_column}'`,
          );
        if (!typesCompatible(column!.type, argument.duckdbType))
          fail(
            "type_check",
            "incompatible_argument_type",
            `Input column '${override.input_column}' is incompatible with argument '${argument.name}'`,
          );
        rendered.set(argument.name, {
          sql: `${driverAlias}.${quoteIdent(override.input_column)}`,
          detail: {
            argument: argument.name,
            kind: "input_column",
            source: override.input_column,
          },
        });
      } else {
        const driverEntity = binding.driverEntity;
        if (!driverEntity)
          fail(
            "source_binding",
            "member_binding_wrong_driver",
            `Argument '${argument.name}' requires an entity driver`,
          );
        if (refKey(override.member) !== driverEntity!.key)
          fail(
            "source_binding",
            "member_not_on_driver",
            `Argument '${argument.name}' references a member outside its driver`,
          );
        const member = driverEntity!.members.get(override.member.member_id);
        if (!member)
          fail(
            "source_binding",
            "unknown_driver_member",
            `Unknown driver member '${override.member.member_id}'`,
          );
        if (!member!.column)
          fail(
            "source_binding",
            "derived_driver_member",
            `Driver member '${member!.member_id}' must be column-backed`,
          );
        if (
          !typesCompatible(
            memberType(driverEntity!, member!),
            argument.duckdbType,
          )
        )
          fail(
            "type_check",
            "incompatible_argument_type",
            `Driver member '${member!.member_id}' is incompatible with argument '${argument.name}'`,
          );
        const path = driverPaths.get(entityMarker(driverEntity!));
        if (!path)
          return fail(
            "source_binding",
            "driver_not_in_path",
            `Driver '${driverEntity!.entityId}' is not available`,
          );
        rendered.set(argument.name, {
          sql: memberSql(driverEntity!, member!, pathAlias(driverAlias, path!)),
          detail: {
            argument: argument.name,
            kind: "member",
            source: override.member,
          },
        });
      }
      continue;
    }
    const mapping = mappings.get(argument.name);
    const parameter =
      override && "parameter" in override
        ? override.parameter
        : mapping?.parameter;
    if (parameter && parameter in supplied) {
      if (!valueCompatible(supplied[parameter], argument.duckdbType))
        fail(
          "type_check",
          "incompatible_parameter_type",
          `Parameter '${parameter}' is incompatible with argument '${argument.name}'`,
        );
      rendered.set(argument.name, {
        sql: "?",
        value: supplied[parameter],
        detail: {
          argument: argument.name,
          kind: "parameter",
          source: parameter,
        },
      });
    } else if (
      argument.defaultValue === undefined &&
      mapping?.required !== false
    )
      fail(
        "required_filter",
        "missing_source_parameter",
        `Table function argument '${argument.name}' requires semantic parameter '${parameter ?? ""}'`,
      );
  }
  if (!correlated)
    fail(
      "source_binding",
      "missing_correlated_argument",
      `Source binding for '${entity.entityId}' has no column-driven argument`,
    );
  const positions = new Set(
    [...rendered].flatMap(([name]) => {
      const argument = argumentsByName.get(name)!;
      return argument.positional && argument.position != null
        ? [argument.position]
        : [];
    }),
  );
  if (positions.size) {
    const highest = Math.max(...positions);
    const holes = entity.functionArguments
      .filter(
        (argument) =>
          argument.positional &&
          argument.position != null &&
          argument.position < highest &&
          !positions.has(argument.position),
      )
      .sort((a, b) => a.position! - b.position!)
      .map((argument) => argument.name);
    if (holes.length)
      fail(
        "source_binding",
        "optional_positional_hole",
        `Cannot omit earlier positional arguments ${JSON.stringify(holes)}`,
      );
  }
  const ordered = [...rendered]
    .map(([name, value]) => ({
      argument: argumentsByName.get(name)!,
      ...value,
    }))
    .sort((left, right) =>
      left.argument.positional !== right.argument.positional
        ? left.argument.positional
          ? -1
          : 1
        : (left.argument.position ?? left.argument.fieldIndex ?? 0) -
          (right.argument.position ?? right.argument.fieldIndex ?? 0),
    );
  for (const item of ordered)
    if (item.detail.kind === "parameter") parameters.push(item.value);
  return {
    sql: `${qualifiedSource(entity)}(${ordered.map((item) => (item.argument.positional ? item.sql : `${quoteIdent(item.argument.name)} := ${item.sql}`)).join(", ")})`,
    plan: ordered.map((item) => item.detail),
  };
}

type InvocationSource = {
  withSql: string;
  source: string;
  rootAlias: string;
  paths: Map<string, string[]>;
  entities: Map<string, SemanticEntity>;
  invocationEntities: SemanticEntity[];
  prevalidatedRequiredEntities: Set<string>;
  drivingGrain: Array<{
    source: string;
    member: string;
    path: string[];
    entity?: SemanticEntity;
  }>;
  effectiveGrain: Array<{
    source: string;
    member: string;
    path: string[];
    entity?: SemanticEntity;
  }>;
  invocations: Array<Record<string, unknown>>;
  estimatedInvocations: number;
};

function compileInvocationSource(
  environment: SemanticEnvironment,
  root: SemanticEntity,
  query: SemanticQuery,
  parameters: unknown[],
): InvocationSource | null {
  const inputs = validateInputs(query),
    chain = resolveInvocationChain(environment, root, query, inputs);
  if (!chain.length) {
    if (inputs.size || (query.source_bindings?.length ?? 0))
      fail(
        "source_binding",
        "missing_root_source_binding",
        "Inputs and source bindings must drive the root entity",
      );
    return null;
  }
  const maxInvocations = Math.min(
    HARD_MAX_INVOCATIONS,
    query.execution_limits?.max_invocations ?? DEFAULT_MAX_INVOCATIONS,
  );
  const ctes: string[] = [],
    invocations: Array<Record<string, unknown>> = [];
  const prevalidatedRequiredEntities = new Set<string>();
  let paths = new Map<string, string[]>(),
    previousStage: string | undefined,
    totalInvocations = 0;
  chain.forEach((binding, index) => {
    const driver = binding.definition.driver;
    let driverSource: string,
      driverPaths: Map<string, string[]>,
      driverCount: number,
      driverKind: string,
      driverLabel: string;
    let inputColumns = new Map<string, SemanticInput["columns"][number]>();
    if (binding.inputId) {
      if (index !== 0)
        fail(
          "source_binding",
          "inline_driver_not_leaf",
          "An inline input may only begin an invocation path",
        );
      const input = inputs.get(binding.inputId)!;
      const inputAlias = `_input${index}`;
      const rowSql = input.rows.map(
        (row) =>
          `(${row
            .map((value, columnIndex) => {
              parameters.push(value);
              return `CAST(? AS ${safeType(input.columns[columnIndex].type)})`;
            })
            .join(", ")})`,
      );
      ctes.push(
        `${quoteIdent(inputAlias)}(${input.columns.map((column) => quoteIdent(column.name)).join(", ")}) AS (VALUES ${rowSql.join(", ")})`,
      );
      driverSource = quoteIdent(inputAlias);
      driverPaths = new Map([[`input:${binding.inputId}`, []]]);
      driverCount = input.rows.length;
      driverKind = "inline_input";
      driverLabel = binding.inputId;
      inputColumns = new Map(
        input.columns.map((column) => [column.name, column]),
      );
    } else {
      const driverEntity = binding.driverEntity!;
      const entityDriver = driver as Extract<
        SemanticSourceBinding["driver"],
        { entity: SemanticRef }
      >;
      driverCount = entityDriver.max_rows;
      let baseSource: string;
      if (!previousStage) {
        if (driverEntity.sourceKind !== "relation")
          fail(
            "source_binding",
            "unbound_function_driver",
            `Function driver '${driverEntity.entityId}' needs its own source binding`,
          );
        baseSource = qualifiedSource(driverEntity);
        driverPaths = new Map([[entityMarker(driverEntity), []]]);
      } else {
        baseSource = quoteIdent(previousStage);
        driverPaths = paths;
      }
      const sourceAlias = quoteIdent("_source"),
        memberAlias = pathAlias(
          sourceAlias,
          driverPaths.get(entityMarker(driverEntity))!,
        );
      const driverLookup = new Map<
        string,
        { entity: SemanticEntity; member: SemanticMember; alias: string }
      >();
      for (const [memberId, member] of driverEntity.members) {
        const found = { entity: driverEntity, member, alias: memberAlias };
        driverLookup.set(memberId, found);
        driverLookup.set(`${driverEntity.key}::${memberId}`, found);
      }
      const filterSql = compileFilter(
        entityDriver.filters,
        driverLookup,
        parameters,
      );
      const filteredIds = new Set(
        filterMembers(entityDriver.filters).map((ref) =>
          typeof ref === "string" ? ref : ref.member_id,
        ),
      );
      for (const group of driverEntity.sourceKind === "relation"
        ? driverEntity.requiredFilters
        : []) {
        const satisfied = group.some((column) =>
          [...driverEntity.members].some(
            ([memberId, member]) =>
              filteredIds.has(memberId) && memberPhysicalKey(member) === column,
          ),
        );
        if (!satisfied)
          fail(
            "required_filter",
            "driver_required_filter_missing",
            `Driver '${driverEntity.entityId}' requires a pre-invocation filter on one of: ${group.join(", ")}`,
          );
      }
      if (
        driverEntity.sourceKind === "relation" &&
        driverEntity.requiredFilters.length
      )
        prevalidatedRequiredEntities.add(entityMarker(driverEntity));
      const orderSql = (entityDriver.order ?? []).map((item) => {
        const member = driverEntity.members.get(item.member_id);
        if (!member)
          fail(
            "source_binding",
            "unknown_driver_order_member",
            `Unknown driver order member '${item.member_id}'`,
          );
        return `${memberSql(driverEntity, member!, memberAlias)} ${item.direction.toUpperCase()}`;
      });
      driverSource = [
        `(SELECT * FROM ${baseSource} AS ${sourceAlias}`,
        filterSql ? `WHERE ${filterSql}` : "",
        orderSql.length ? `ORDER BY ${orderSql.join(", ")}` : "",
        `LIMIT ${driverCount})`,
      ]
        .filter(Boolean)
        .join(" ");
      driverKind = "entity";
      driverLabel = driverEntity.key;
    }
    totalInvocations += driverCount;
    if (totalInvocations > maxInvocations)
      fail(
        "execution_limit",
        "invocation_limit",
        `Invocation path may execute ${totalInvocations} function rows, above limit ${maxInvocations}`,
      );
    const call = correlatedCallSql(
      binding,
      query,
      parameters,
      quoteIdent("_driver"),
      driverPaths,
      inputColumns,
    );
    const stage = `_stage${index}`,
      stageLimit = Math.min(
        DEFAULT_MAX_STAGE_ROWS,
        binding.definition.max_output_rows ?? DEFAULT_MAX_STAGE_ROWS,
      );
    ctes.push(
      `${quoteIdent(stage)} AS (SELECT "_driver" AS "driver", "_fn" AS "entity" FROM ${driverSource} AS "_driver" CROSS JOIN LATERAL ${call.sql} AS "_fn" LIMIT ${stageLimit})`,
    );
    paths = new Map(
      [...driverPaths].map(([marker, path]) => [marker, ["driver", ...path]]),
    );
    paths.set(entityMarker(binding.entity), ["entity"]);
    invocations.push({
      entity: {
        catalog_id: binding.entity.catalogId,
        entity_id: binding.entity.entityId,
      },
      driver_kind: driverKind,
      driver: driverLabel,
      argument_bindings: call.plan,
      estimated_invocations: driverCount,
    });
    previousStage = stage;
  });
  const drivingGrain: InvocationSource["drivingGrain"] = [];
  for (const [marker, path] of paths) {
    if (marker === entityMarker(root)) continue;
    if (marker.startsWith("input:")) {
      const inputId = marker.slice(6);
      for (const member of inputs.get(inputId)!.grain)
        drivingGrain.push({ source: inputId, member, path });
    } else {
      const entity = chain
        .flatMap((item) => (item.driverEntity ? [item.driverEntity] : []))
        .find((item) => entityMarker(item) === marker);
      if (entity)
        for (const member of entity.grain)
          drivingGrain.push({ source: entity.key, member, path, entity });
    }
  }
  const rootPath = paths.get(entityMarker(root))!;
  const effectiveGrain = [
    ...drivingGrain,
    ...root.grain.map((member) => ({
      source: root.key,
      member,
      path: rootPath,
      entity: root,
    })),
  ];
  const entities = new Map<string, SemanticEntity>();
  for (const item of chain) {
    entities.set(entityMarker(item.entity), item.entity);
    if (item.driverEntity)
      entities.set(entityMarker(item.driverEntity), item.driverEntity);
  }
  return {
    withSql: `WITH ${ctes.join(", ")}`,
    source: quoteIdent(previousStage!),
    rootAlias: pathAlias("_e0", rootPath),
    paths,
    entities,
    invocationEntities: chain.map((item) => item.entity),
    prevalidatedRequiredEntities,
    drivingGrain,
    effectiveGrain,
    invocations,
    estimatedInvocations: totalInvocations,
  };
}

function memberSql(
  entity: SemanticEntity,
  member: SemanticMember,
  alias: string,
  stack: string[] = [],
  sourceArgumentRenderer?: SourceArgumentRenderer,
): string {
  if (stack.includes(member.member_id))
    fail(
      "type_check",
      "expression_cycle",
      `Cyclic semantic expression at '${member.member_id}'`,
    );
  const sql = memberColumnPath(member).length
    ? memberColumnSql(alias, member)
    : member.source_argument
      ? sourceArgumentRenderer
        ? sourceArgumentRenderer(entity, member)
        : fail(
            "source_binding",
            "source_argument_value_unavailable",
            `Source-argument member '${member.member_id}' is unavailable in this query context`,
          )
      : member.expression
        ? expressionSql(
            entity,
            member.expression,
            alias,
            [...stack, member.member_id],
            sourceArgumentRenderer,
          )
        : fail(
            "type_check",
            "missing_member_source",
            `Member '${member.member_id}' has no column or expression`,
          );
  return member.output_type
    ? `CAST(${sql} AS ${safeType(member.output_type)})`
    : sql;
}

function listElementSql(valueSql: string, path: string[]): string {
  if (!path.length) return valueSql;
  return `list_transform(${valueSql}, _item -> ${["_item", ...path.map(quoteIdent)].join(".")})`;
}

type RelationshipEdge = {
  relationship: SemanticRelationship;
  from: SemanticEntity;
  to: SemanticEntity;
  forward: boolean;
};

function relationshipPredicateSql(
  edge: RelationshipEdge,
  pair: SemanticRelationship["predicate"][number],
  sourceAlias: string,
  targetAlias: string,
): string {
  const fromEntity = edge.forward ? edge.from : edge.to;
  const toEntity = edge.forward ? edge.to : edge.from;
  const fromAlias = edge.forward ? sourceAlias : targetAlias;
  const toAlias = edge.forward ? targetAlias : sourceAlias;
  const fromMember = fromEntity.members.get(pair.from_member);
  const toMember = toEntity.members.get(pair.to_member);
  if (!fromMember || !toMember) {
    fail(
      "relationship_resolution",
      "unresolved_relationship_member",
      `Relationship '${edge.relationship.relationshipId}' references an unknown member`,
    );
  }
  const fromSql = memberSql(fromEntity, fromMember!, fromAlias);
  const toSql = memberSql(toEntity, toMember!, toAlias);
  switch (pair.operator ?? "equal") {
    case "equal":
      return `${fromSql} ${pair.nulls === "equal" ? "IS NOT DISTINCT FROM" : "="} ${toSql}`;
    case "spatial_contains":
      return `ST_Contains(${fromSql}, ${toSql})`;
    case "spatial_within":
      return `ST_Within(${fromSql}, ${toSql})`;
    case "spatial_intersects":
      return `ST_Intersects(${fromSql}, ${toSql})`;
    case "list_contains":
      return pair.from_element_path
        ? `list_contains(${listElementSql(fromSql, pair.from_element_path)}, ${toSql})`
        : `list_contains(${listElementSql(toSql, pair.to_element_path!)}, ${fromSql})`;
  }
}

function relationshipConditionSql(
  edge: RelationshipEdge,
  condition: SemanticRelationship["conditions"][number],
  sourceAlias: string,
  targetAlias: string,
  parameters: unknown[],
): string {
  const fromEntity = edge.forward ? edge.from : edge.to;
  const toEntity = edge.forward ? edge.to : edge.from;
  const fromAlias = edge.forward ? sourceAlias : targetAlias;
  const toAlias = edge.forward ? targetAlias : sourceAlias;
  const entity = condition.side === "from" ? fromEntity : toEntity;
  const alias = condition.side === "from" ? fromAlias : toAlias;
  const member = entity.members.get(condition.member);
  if (!member) {
    fail(
      "relationship_resolution",
      "unresolved_relationship_condition_member",
      `Relationship '${edge.relationship.relationshipId}' condition references an unknown member`,
    );
  }
  if (!valueCompatible(condition.value, memberType(entity, member!))) {
    fail(
      "type_check",
      "incompatible_relationship_condition_value",
      `Relationship '${edge.relationship.relationshipId}' condition value is incompatible with member '${member!.member_id}'`,
    );
  }
  parameters.push(condition.value);
  return `${memberSql(entity, member!, alias)} IS NOT DISTINCT FROM ?`;
}

function expressionSql(
  entity: SemanticEntity,
  expression: SemanticExpression,
  alias: string,
  stack: string[],
  sourceArgumentRenderer?: SourceArgumentRenderer,
): string {
  if (expression.op === "member") {
    const member = entity.members.get(expression.member);
    if (!member)
      throw new CompileFailure({
        stage: "type_check" as any,
        code: "unknown_expression_member",
        message: `Unknown member '${expression.member}'`,
      });
    return memberSql(entity, member, alias, stack, sourceArgumentRenderer);
  }
  if (expression.op === "literal") return literalSql(expression.value);
  if (
    ["add", "subtract", "multiply", "divide", "safe_divide"].includes(
      expression.op,
    )
  ) {
    const binary = expression as any;
    const left = expressionSql(
      entity,
      binary.left,
      alias,
      stack,
      sourceArgumentRenderer,
    );
    const right = expressionSql(
      entity,
      binary.right,
      alias,
      stack,
      sourceArgumentRenderer,
    );
    if (expression.op === "safe_divide")
      return `(${left} / NULLIF(${right}, 0))`;
    const operator = { add: "+", subtract: "-", multiply: "*", divide: "/" }[
      expression.op as "add"
    ];
    return `(${left} ${operator} ${right})`;
  }
  if (expression.op === "coalesce")
    return `COALESCE(${expression.args.map((arg) => expressionSql(entity, arg, alias, stack, sourceArgumentRenderer)).join(", ")})`;
  if (expression.op === "nullif")
    return `NULLIF(${expressionSql(entity, expression.value, alias, stack, sourceArgumentRenderer)}, ${expressionSql(entity, expression.other ?? { op: "literal", value: 0 }, alias, stack, sourceArgumentRenderer)})`;
  if (expression.op === "cast")
    return `CAST(${expressionSql(entity, expression.value, alias, stack, sourceArgumentRenderer)} AS ${safeType(expression.type)})`;
  if (expression.op === "case")
    return `CASE WHEN ${expressionSql(entity, expression.when, alias, stack, sourceArgumentRenderer)} THEN ${expressionSql(entity, expression.then, alias, stack, sourceArgumentRenderer)}${expression.else ? ` ELSE ${expressionSql(entity, expression.else, alias, stack, sourceArgumentRenderer)}` : ""} END`;
  return fail(
    "sql_generation",
    "unsupported_expression",
    "Unsupported semantic expression",
  );
}

function aggregateSql(
  entity: SemanticEntity,
  member: SemanticMember,
  alias: string,
  stack: string[] = [],
  sourceArgumentRenderer?: SourceArgumentRenderer,
  parameters?: unknown[],
): string {
  if (stack.includes(member.member_id))
    fail(
      "type_check",
      "measure_cycle",
      `Cyclic derived measure at '${member.member_id}'`,
    );
  if (member.expression) {
    const sql = measureExpressionSql(
      entity,
      member.expression,
      alias,
      [...stack, member.member_id],
      sourceArgumentRenderer,
      parameters,
    );
    return member.output_type
      ? `CAST(${sql} AS ${safeType(member.output_type)})`
      : sql;
  }
  const aggregation = member.aggregation;
  if (!aggregation)
    throw new CompileFailure({
      stage: "type_check" as any,
      code: "invalid_measure",
      message: `Measure '${member.member_id}' has no aggregation or expression`,
    });
  let aggregate: string;
  if (aggregation === "count_rows") aggregate = "COUNT(*)";
  else {
    const input = entity.members.get(String(member.member));
    if (!input)
      throw new CompileFailure({
        stage: "type_check" as any,
        code: "unknown_measure_input",
        message: `Measure '${member.member_id}' has unknown input '${member.member}'`,
      });
    const sql = memberSql(entity, input, alias, [], sourceArgumentRenderer);
    const fn =
      aggregation === "count_distinct"
        ? "COUNT(DISTINCT"
        : aggregation.toUpperCase() + "(";
    aggregate =
      aggregation === "count_distinct" ? `${fn} ${sql})` : `${fn}${sql})`;
  }
  if (member.filter)
    aggregate += ` FILTER (WHERE ${compileModelMeasureFilter(entity, member.filter, alias, parameters, sourceArgumentRenderer)})`;
  return member.output_type
    ? `CAST(${aggregate} AS ${safeType(member.output_type)})`
    : aggregate;
}

function measureExpressionSql(
  entity: SemanticEntity,
  expression: SemanticExpression,
  alias: string,
  stack: string[],
  sourceArgumentRenderer?: SourceArgumentRenderer,
  parameters?: unknown[],
): string {
  if (expression.op === "member") {
    const member = entity.members.get(expression.member);
    if (!member)
      throw new CompileFailure({
        stage: "type_check" as any,
        code: "unknown_expression_member",
        message: `Unknown member '${expression.member}'`,
      });
    return member.kind === "measure"
      ? aggregateSql(entity, member, alias, stack, sourceArgumentRenderer, parameters)
      : memberSql(entity, member, alias, stack, sourceArgumentRenderer);
  }
  if (expression.op === "literal") return literalSql(expression.value);
  if (
    ["add", "subtract", "multiply", "divide", "safe_divide"].includes(
      expression.op,
    )
  ) {
    const binary = expression as any;
    const left = measureExpressionSql(
      entity,
      binary.left,
      alias,
      stack,
      sourceArgumentRenderer,
      parameters,
    );
    const right = measureExpressionSql(
      entity,
      binary.right,
      alias,
      stack,
      sourceArgumentRenderer,
      parameters,
    );
    if (expression.op === "safe_divide")
      return `(${left} / NULLIF(${right}, 0))`;
    const operator = { add: "+", subtract: "-", multiply: "*", divide: "/" }[
      expression.op as "add"
    ];
    return `(${left} ${operator} ${right})`;
  }
  if (expression.op === "coalesce")
    return `COALESCE(${expression.args.map((arg) => measureExpressionSql(entity, arg, alias, stack, sourceArgumentRenderer, parameters)).join(", ")})`;
  if (expression.op === "nullif")
    return `NULLIF(${measureExpressionSql(entity, expression.value, alias, stack, sourceArgumentRenderer, parameters)}, ${measureExpressionSql(entity, expression.other ?? { op: "literal", value: 0 }, alias, stack, sourceArgumentRenderer, parameters)})`;
  if (expression.op === "cast")
    return `CAST(${measureExpressionSql(entity, expression.value, alias, stack, sourceArgumentRenderer, parameters)} AS ${safeType(expression.type)})`;
  if (expression.op === "case")
    return `CASE WHEN ${measureExpressionSql(entity, expression.when, alias, stack, sourceArgumentRenderer, parameters)} THEN ${measureExpressionSql(entity, expression.then, alias, stack, sourceArgumentRenderer, parameters)}${expression.else ? ` ELSE ${measureExpressionSql(entity, expression.else, alias, stack, sourceArgumentRenderer, parameters)}` : ""} END`;
  return fail(
    "sql_generation",
    "unsupported_expression",
    "Unsupported derived-measure expression",
  );
}

function compileModelMeasureFilter(
  entity: SemanticEntity,
  filter: SemanticMemberFilter,
  alias: string,
  parameters?: unknown[],
  sourceArgumentRenderer?: SourceArgumentRenderer,
): string {
  if (!parameters)
    return fail(
      "sql_generation",
      "measure_filter_parameters_unavailable",
      "A model-owned measure filter requires a parameter collector",
    );
  if ("and" in filter)
    return `(${filter.and.map((item) => compileModelMeasureFilter(entity, item, alias, parameters, sourceArgumentRenderer)).join(" AND ")})`;
  if ("or" in filter)
    return `(${filter.or.map((item) => compileModelMeasureFilter(entity, item, alias, parameters, sourceArgumentRenderer)).join(" OR ")})`;
  const member = entity.members.get(filter.member);
  if (!member || member.kind === "measure")
    return fail(
      "model_resolution",
      "invalid_measure_filter_member",
      `Measure filter member '${filter.member}' must identify a local non-measure member`,
    );
  const lhs = memberSql(entity, member, alias, [], sourceArgumentRenderer);
  if (filter.operator === "is_null") return `${lhs} IS NULL`;
  if (filter.operator === "is_not_null") return `${lhs} IS NOT NULL`;
  const values = filter.values ?? [filter.value];
  values.forEach((value) => parameters.push(value));
  if (["in", "not_in"].includes(filter.operator))
    return `${lhs} ${filter.operator === "in" ? "IN" : "NOT IN"} (${values.map(() => "?").join(", ")})`;
  if (filter.operator === "between") return `${lhs} BETWEEN ? AND ?`;
  const operator = {
    eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=",
  }[filter.operator];
  if (!operator)
    return fail(
      "model_resolution",
      "invalid_measure_filter_operator",
      `Unknown measure filter operator '${filter.operator}'`,
    );
  return `${lhs} ${operator} ?`;
}

function findPath(
  environment: SemanticEnvironment,
  root: SemanticEntity,
  target: SemanticEntity,
  requested?: string[],
  bindings: Record<string, string> = {},
): RelationshipEdge[] {
  if (
    root.key === target.key &&
    root.attachmentAlias === target.attachmentAlias
  )
    return [];
  const chosen = requested?.length
    ? environment.relationships.filter((relationship) =>
        requested.includes(relationship.relationshipId),
      )
    : environment.relationships;
  type State = { entity: SemanticEntity; path: ReturnType<typeof findPath> };
  const queue: State[] = [{ entity: root, path: [] }];
  const found: State[] = [];
  const seen = new Set<string>();
  while (queue.length) {
    const state = queue.shift()!;
    const marker = `${state.entity.attachmentAlias}:${state.entity.key}:${state.path.length}`;
    if (seen.has(marker)) continue;
    seen.add(marker);
    if (
      state.entity.key === target.key &&
      state.entity.attachmentAlias === target.attachmentAlias
    ) {
      found.push(state);
      continue;
    }
    if (state.path.length >= 8) continue;
    for (const relationship of chosen) {
      if (
        !["resolved", "ambiguous"].includes(relationship.resolutionStatus) ||
        state.path.some(
          (edge) =>
            edge.relationship.relationshipId === relationship.relationshipId,
        )
      )
        continue;
      const forward = refKey(relationship.from) === state.entity.key;
      const backward = refKey(relationship.to) === state.entity.key;
      if (!forward && !backward) continue;
      const nextRef = forward ? relationship.to : relationship.from;
      const resolved = resolveEntity(
        environment,
        nextRef,
        bindings,
        relationship.hostAliases.includes(state.entity.attachmentAlias)
          ? state.entity.attachmentAlias
          : undefined,
      );
      if ("stage" in resolved) continue;
      queue.push({
        entity: resolved,
        path: [
          ...state.path,
          { relationship, from: state.entity, to: resolved, forward },
        ],
      });
    }
  }
  const exact = requested?.length
    ? found.filter(
        (candidate) =>
          candidate.path
            .map((edge) => edge.relationship.relationshipId)
            .join("/") === requested.join("/"),
      )
    : found;
  if (exact.length !== 1)
    fail(
      "relationship_resolution",
      exact.length
        ? "ambiguous_relationship_path"
        : "relationship_path_not_found",
      exact.length
        ? `Multiple relationship paths reach '${target.entityId}'; specify relationship_path`
        : `No relationship path reaches '${target.entityId}'`,
    );
  return exact[0].path;
}

const filterMemberKey = (member: SemanticFilterMember) =>
  typeof member === "string"
    ? member
    : `${refKey(member)}::${member.member_id}`;

function compileFilter(
  filter: SemanticFilter | undefined,
  members: Map<
    string,
    { entity: SemanticEntity; member: SemanticMember; alias: string }
  >,
  parameters: unknown[],
  sourceArgumentRenderer?: SourceArgumentRenderer,
): string | null {
  if (!filter) return null;
  if ("and" in filter) {
    const parts = filter.and
      .map((part: SemanticFilter) =>
        compileFilter(part, members, parameters, sourceArgumentRenderer),
      )
      .filter(Boolean);
    return `(${parts.join(" AND ")})`;
  }
  if ("or" in filter) {
    const parts = filter.or
      .map((part: SemanticFilter) =>
        compileFilter(part, members, parameters, sourceArgumentRenderer),
      )
      .filter(Boolean);
    return `(${parts.join(" OR ")})`;
  }
  const found = members.get(filterMemberKey(filter.member));
  if (!found)
    throw new CompileFailure({
      stage: "type_check" as any,
      code: "unknown_filter_member",
      message: `Unknown or ambiguous filter member '${typeof filter.member === "string" ? filter.member : filter.member.member_id}'`,
    });
  const lhs =
    found.member.kind === "measure"
      ? aggregateSql(
          found.entity,
          found.member,
          found.alias,
          [],
          sourceArgumentRenderer,
          parameters,
        )
      : memberSql(
          found.entity,
          found.member,
          found.alias,
          [],
          sourceArgumentRenderer,
        );
  if (filter.operator === "is_null") return `${lhs} IS NULL`;
  if (filter.operator === "is_not_null") return `${lhs} IS NOT NULL`;
  const values =
    filter.values ??
    (filter.operator === "between" && Array.isArray(filter.value)
      ? filter.value
      : [filter.value]);
  if (["in", "not_in"].includes(filter.operator) && values.length === 0)
    fail(
      "request_validation",
      "empty_filter_values",
      `${filter.operator} requires at least one value`,
    );
  if (filter.operator === "between" && values.length !== 2)
    fail(
      "request_validation",
      "invalid_between",
      "between requires exactly two values",
    );
  for (const value of values) parameters.push(value);
  if (["in", "not_in"].includes(filter.operator))
    return `${lhs} ${filter.operator === "in" ? "IN" : "NOT IN"} (${values.map(() => "?").join(", ")})`;
  if (filter.operator === "between") return `${lhs} BETWEEN ? AND ?`;
  const op = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" }[
    filter.operator
  ];
  if (!op)
    fail(
      "request_validation",
      "invalid_filter_operator",
      `Unknown filter operator '${filter.operator}'`,
    );
  return `${lhs} ${op} ?`;
}

function filterMembers(
  filter: SemanticFilter | undefined,
  depth = 0,
): SemanticFilterMember[] {
  if (!filter) return [];
  if (depth >= 8)
    fail(
      "request_validation",
      "filter_depth",
      "Filter nesting may not exceed 8 levels",
    );
  if ("and" in filter)
    return filter.and.flatMap((part) => filterMembers(part, depth + 1));
  if ("or" in filter)
    return filter.or.flatMap((part) => filterMembers(part, depth + 1));
  return [filter.member];
}

function orderedMeasureRoots(measures: SemanticSelection[]): SemanticRef[] {
  const seen = new Set<string>();
  const roots: SemanticRef[] = [];
  for (const measure of measures) {
    const key = refKey(measure);
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push({
      catalog_id: measure.catalog_id,
      entity_id: measure.entity_id,
    });
  }
  return roots;
}

function validateMultiFactOutputNames(query: SemanticQuery): void {
  const names = new Set<string>();
  for (const selection of [
    ...(query.dimensions ?? []),
    ...(query.measures ?? []),
  ]) {
    const name = selection.alias ?? selection.member_id;
    if (names.has(name))
      fail(
        "request_validation",
        "duplicate_output",
        `Duplicate output name '${name}'`,
      );
    names.add(name);
  }
  for (const derived of query.derived_measures ?? []) {
    if (names.has(derived.name))
      fail(
        "request_validation",
        "duplicate_output",
        `Duplicate output name '${derived.name}'`,
      );
    names.add(derived.name);
  }
}

function dimensionForBranch(
  selection: SemanticSelection,
  root: SemanticRef,
): SemanticSelection {
  const override = selection.branch_relationship_paths?.find(
    (item) => refKey(item.root) === refKey(root),
  );
  const memberOverride = selection.branch_members?.find(
    (item) => refKey(item.root) === refKey(root),
  );
  const {
    branch_relationship_paths: _ignored,
    branch_members: _ignoredMembers,
    ...dimension
  } = selection;
  return {
    ...dimension,
    ...(override ? { relationship_path: [...override.relationship_path] } : {}),
    ...(memberOverride
      ? {
          ...memberOverride.member,
          ...(memberOverride.relationship_path
            ? { relationship_path: [...memberOverride.relationship_path] }
            : {}),
        }
      : {}),
    };
}

function validateBranchMembers(
  environment: SemanticEnvironment,
  dimensions: SemanticSelection[],
  roots: SemanticRef[],
  bindings: Record<string, string>,
): void {
  const rootKeys = new Set(roots.map(refKey));
  for (const dimension of dimensions) {
    if (!dimension.branch_members?.length) continue;
    const canonicalEntity = resolveOrFail(environment, dimension, bindings);
    const canonical = canonicalEntity.members.get(dimension.member_id);
    if (!canonical || canonical.kind === "measure")
      fail(
        "model_resolution",
        "invalid_conformed_dimension",
        "The canonical conformed member must identify a non-measure member",
      );
    const canonicalMember = canonical!;
    if (!canonicalMember.conformance_id)
      fail(
        "model_resolution",
        "conformance_id_required",
        `Canonical member '${canonicalMember.member_id}' needs conformance_id`,
      );
    const seen = new Set<string>();
    for (const override of dimension.branch_members) {
      const rootKey = refKey(override.root);
      if (!rootKeys.has(rootKey))
        fail(
          "request_validation",
          "invalid_branch_member_root",
          `Conformed member override targets non-fact root '${rootKey}'`,
        );
      if (seen.has(rootKey))
        fail(
          "request_validation",
          "duplicate_branch_member",
          `Conformed dimension '${dimension.member_id}' has multiple member overrides for one fact root`,
        );
      seen.add(rootKey);
      const entity = resolveOrFail(environment, override.member, bindings);
      const member = entity.members.get(override.member.member_id);
      if (!member || member.kind === "measure")
        fail(
          "model_resolution",
          "invalid_conformed_dimension",
          "A conformed branch member must identify a non-measure member",
        );
      const branchMember = member!;
      if (branchMember.conformance_id !== canonicalMember.conformance_id)
        fail(
          "type_check",
          "conformance_id_mismatch",
          `Member '${branchMember.member_id}' does not declare conformance_id '${canonicalMember.conformance_id}'`,
        );
      const canonicalType = normalizedType(memberType(canonicalEntity, canonicalMember));
      const branchType = normalizedType(memberType(entity, branchMember));
      if (!canonicalType || !branchType)
        fail(
          "type_check",
          "conformed_member_type_unknown",
          "Conformed members must declare or expose a discoverable type",
        );
      if (branchType !== canonicalType)
        fail(
          "type_check",
          "conformed_member_type_mismatch",
          `Conformed members '${canonicalMember.member_id}' and '${branchMember.member_id}' must have the same type`,
        );
      if ((canonicalMember.kind === "time_dimension") !== (branchMember.kind === "time_dimension"))
        fail(
          "type_check",
          "conformed_member_kind_mismatch",
          "Time dimensions may only be conformed with other time dimensions",
        );
      if (canonicalMember.kind === "time_dimension") {
        if (canonicalMember.timezone !== branchMember.timezone || (canonicalMember.week_start ?? "monday") !== (branchMember.week_start ?? "monday"))
          fail(
            "type_check",
            "conformed_time_semantics_mismatch",
            "Conformed time dimensions must use the same timezone and week start",
          );
        if (dimension.granularity && !branchMember.granularities?.includes(dimension.granularity))
          fail(
            "type_check",
            "conformed_granularity_unsupported",
            `Branch member '${branchMember.member_id}' does not support granularity '${dimension.granularity}'`,
          );
      }
    }
  }
}

function validateBranchRelationshipPaths(
  dimensions: SemanticSelection[],
  roots: SemanticRef[],
): void {
  const rootKeys = new Set(roots.map(refKey));
  for (const dimension of dimensions) {
    const seen = new Set<string>();
    for (const item of dimension.branch_relationship_paths ?? []) {
      const key = refKey(item.root);
      if (!rootKeys.has(key))
        fail(
          "request_validation",
          "invalid_branch_relationship_root",
          `Dimension '${dimension.member_id}' specifies a path for non-fact root '${key}'`,
        );
      if (seen.has(key))
        fail(
          "request_validation",
          "duplicate_branch_relationship_path",
          `Dimension '${dimension.member_id}' specifies multiple paths for root '${key}'`,
        );
      seen.add(key);
    }
  }
}

function validateMultiFactPopulationFilters(
  environment: SemanticEnvironment,
  query: SemanticQuery,
): void {
  for (const ref of filterMembers(query.filters)) {
    let member: SemanticMember | undefined;
    if (typeof ref === "string") {
      const logicalMatches = new Set(
        environment.entities
          .filter((entity) => entity.members.has(ref))
          .map((entity) => entity.key),
      );
      if (logicalMatches.size !== 1)
        fail(
          "request_validation",
          "multi_fact_filter_ambiguous",
          `Population filter member '${ref}' must identify one semantic member; use a qualified member reference`,
        );
      const key = [...logicalMatches][0];
      const [catalog_id, entity_id] = key.split("::");
      member = resolveOrFail(
        environment,
        { catalog_id, entity_id },
        query.bindings ?? {},
      ).members.get(ref);
    } else {
      member = resolveOrFail(
        environment,
        ref,
        query.bindings ?? {},
      ).members.get(ref.member_id);
    }
    if (!member)
      fail(
        "model_resolution",
        "unknown_filter_member",
        "Unknown population filter member",
      );
    if (member?.kind === "measure")
      fail(
        "request_validation",
        "multi_fact_population_filter_measure",
        "Pre-stitch population filters may not reference measures; use measure_filters for selected measures",
      );
  }
}

function partitionMultiFactSources(
  query: SemanticQuery,
  roots: SemanticRef[],
): Array<{
  source_bindings: SemanticSourceBinding[];
  inputs: SemanticInput[];
}> {
  const inputs = validateInputs(query);
  const definitions = query.source_bindings ?? [];
  const byTarget = new Map<string, number>();
  definitions.forEach((definition, index) => {
    const key = refKey(definition.entity);
    if (byTarget.has(key))
      fail(
        "source_binding",
        "duplicate_source_binding",
        `Entity '${key}' has multiple source bindings`,
      );
    byTarget.set(key, index);
  });
  const usedDefinitions = new Set<number>();
  const usedInputs = new Set<string>();
  const partitions = roots.map((root) => {
    const indexes: number[] = [];
    const inputIds = new Set<string>();
    const visited = new Set<string>();
    let current = refKey(root);
    while (byTarget.has(current)) {
      const index = byTarget.get(current)!;
      if (visited.has(current)) break;
      visited.add(current);
      indexes.push(index);
      const driver = definitions[index].driver;
      if ("input_id" in driver) {
        inputIds.add(driver.input_id);
        break;
      }
      current = refKey(driver.entity);
    }
    indexes.forEach((index) => usedDefinitions.add(index));
    inputIds.forEach((inputId) => usedInputs.add(inputId));
    return {
      source_bindings: [...indexes]
        .sort((a, b) => a - b)
        .map((index) => definitions[index]),
      inputs: (query.inputs ?? []).filter((input) =>
        inputIds.has(input.input_id),
      ),
    };
  });
  const unusedDefinitions = definitions.filter(
    (_definition, index) => !usedDefinitions.has(index),
  );
  if (unusedDefinitions.length)
    fail(
      "source_binding",
      "unused_source_binding",
      "Source bindings are not on any fact invocation path",
    );
  const unusedInputs = [...inputs.keys()].filter(
    (inputId) => !usedInputs.has(inputId),
  );
  if (unusedInputs.length)
    fail(
      "source_binding",
      "unused_input",
      `Inputs are not used by any fact invocation path: ${JSON.stringify(unusedInputs)}`,
    );
  return partitions;
}

function measureZeroType(
  environment: SemanticEnvironment,
  selection: SemanticSelection,
  bindings: Record<string, string>,
): string {
  const entity = resolveOrFail(environment, selection, bindings);
  const member = entity.members.get(selection.member_id);
  if (!member || member.kind !== "measure")
    return fail(
      "type_check",
      "zero_fill_not_safe",
      `Output '${selection.member_id}' is not a measure eligible for zero filling`,
    );
  if (member.additivity !== "additive")
    return fail(
      "type_check",
      "zero_fill_not_safe",
      `Measure '${member.member_id}' must be additive to use a zero missing value`,
    );
  let resultType = member.output_type ?? "";
  if (!resultType && ["count_rows", "count"].includes(member.aggregation ?? ""))
    resultType = "BIGINT";
  if (!resultType && member.aggregation === "sum" && member.member) {
    const source = entity.members.get(member.member);
    if (source) resultType = memberType(entity, source) ?? "";
  }
  if (
    !/^(?:U?(?:TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT)|REAL|FLOAT|DOUBLE|DECIMAL(?:\([0-9]+(?:,[0-9]+)?\))?|NUMERIC(?:\([0-9]+(?:,[0-9]+)?\))?)$/.test(
      normalizedType(resultType),
    )
  )
    return fail(
      "type_check",
      "zero_fill_not_safe",
      `Measure '${member.member_id}' has no provable numeric result type`,
    );
  return safeType(resultType);
}

function selectedMeasureExpression(
  ref: SemanticFilterMember,
  measures: SemanticSelection[],
  expressions: Map<string, string>,
): string {
  const matches = measures.filter((measure) =>
    typeof ref === "string"
      ? [measure.member_id, measure.alias].includes(ref)
      : refKey(measure) === refKey(ref) && measure.member_id === ref.member_id,
  );
  if (!matches.length)
    return fail(
      "request_validation",
      "multi_fact_measure_filter_not_selected",
      "Multi-fact measure filters must reference a selected measure",
    );
  if (matches.length !== 1)
    return fail(
      "request_validation",
      "multi_fact_measure_filter_ambiguous",
      "Multi-fact measure filter reference is ambiguous; use a unique selected alias",
    );
  return expressions.get(matches[0].alias ?? matches[0].member_id)!;
}

function compileStitchedMeasureFilter(
  filter: SemanticFilter | undefined,
  measures: SemanticSelection[],
  expressions: Map<string, string>,
  parameters: unknown[],
  depth = 0,
): string | null {
  if (!filter) return null;
  if (depth >= 8)
    return fail(
      "request_validation",
      "filter_depth",
      "Filter nesting may not exceed 8 levels",
    );
  if ("and" in filter)
    return `(${filter.and.map((item) => compileStitchedMeasureFilter(item, measures, expressions, parameters, depth + 1)).join(" AND ")})`;
  if ("or" in filter)
    return `(${filter.or.map((item) => compileStitchedMeasureFilter(item, measures, expressions, parameters, depth + 1)).join(" OR ")})`;
  const lhs = selectedMeasureExpression(filter.member, measures, expressions);
  if (filter.operator === "is_null") return `${lhs} IS NULL`;
  if (filter.operator === "is_not_null") return `${lhs} IS NOT NULL`;
  const values = filter.values ?? [filter.value];
  values.forEach((value) => parameters.push(value));
  if (["in", "not_in"].includes(filter.operator))
    return `${lhs} ${filter.operator === "in" ? "IN" : "NOT IN"} (${values.map(() => "?").join(", ")})`;
  if (filter.operator === "between") return `${lhs} BETWEEN ? AND ?`;
  const operator = {
    eq: "=",
    neq: "<>",
    gt: ">",
    gte: ">=",
    lt: "<",
    lte: "<=",
  }[filter.operator];
  if (!operator)
    return fail(
      "request_validation",
      "invalid_filter_operator",
      `Unknown filter operator '${filter.operator}'`,
    );
  return `${lhs} ${operator} ?`;
}

function derivedMemberRefs(expression: SemanticExpression): Set<string> {
  if (expression.op === "member") return new Set([expression.member]);
  const refs = new Set<string>();
  for (const child of Object.values(expression)) {
    if (Array.isArray(child))
      child.forEach((item) => {
        if (item && typeof item === "object")
          derivedMemberRefs(item as SemanticExpression).forEach((ref) => refs.add(ref));
      });
    else if (child && typeof child === "object")
      derivedMemberRefs(child as SemanticExpression).forEach((ref) => refs.add(ref));
  }
  return refs;
}

function selectedMeasureType(
  environment: SemanticEnvironment,
  selection: SemanticSelection,
  bindings: Record<string, string>,
): string | undefined {
  const entity = resolveOrFail(environment, selection, bindings);
  const member = entity.members.get(selection.member_id);
  if (!member || member.kind !== "measure") return undefined;
  if (member.output_type) return member.output_type;
  if (["count", "count_rows", "count_distinct"].includes(member.aggregation ?? ""))
    return "BIGINT";
  const source = member.member ? entity.members.get(member.member) : undefined;
  return source ? memberType(entity, source) : undefined;
}

function compileDerivedExpression(
  expression: SemanticExpression,
  selectedTypes: Map<string, string>,
  parameters: unknown[],
): { sql: string; type: string } {
  if (expression.op === "member") {
    const type = selectedTypes.get(expression.member);
    if (!type)
      return fail(
        "request_validation",
        "derived_measure_member_not_selected",
        `Derived measure references unselected or ambiguous output '${expression.member}'`,
      );
    return { sql: `"_stitched".${quoteIdent(expression.member)}`, type };
  }
  if (expression.op === "literal") {
    parameters.push(expression.value);
    return {
      sql: "?",
      type:
        typeof expression.value === "boolean"
          ? "BOOLEAN"
          : typeof expression.value === "number"
            ? Number.isInteger(expression.value)
              ? "BIGINT"
              : "DOUBLE"
            : typeof expression.value === "string"
              ? "VARCHAR"
              : "ANY",
    };
  }
  if (["add", "subtract", "multiply", "divide", "safe_divide"].includes(expression.op)) {
    const binary = expression as Extract<SemanticExpression, { left: SemanticExpression }>;
    const left = compileDerivedExpression(binary.left, selectedTypes, parameters);
    const right = compileDerivedExpression(binary.right, selectedTypes, parameters);
    for (const operand of [left, right])
      if (!/^(?:U?(?:TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT)|REAL|FLOAT|DOUBLE|DECIMAL(?:\([0-9]+(?:,[0-9]+)?\))?|NUMERIC(?:\([0-9]+(?:,[0-9]+)?\))?)$/.test(normalizedType(operand.type)))
        return fail(
          "type_check",
          "derived_measure_requires_numeric_operand",
          `Operator '${expression.op}' requires numeric operands`,
        );
    const operator = { add: "+", subtract: "-", multiply: "*", divide: "/" } as const;
    return {
      sql:
        expression.op === "safe_divide"
          ? `(${left.sql} / NULLIF(${right.sql}, 0))`
          : `(${left.sql} ${operator[expression.op as keyof typeof operator]} ${right.sql})`,
      type: ["divide", "safe_divide"].includes(expression.op) ? "DOUBLE" : left.type,
    };
  }
  if (expression.op === "coalesce") {
    const values = expression.args.map((item) => compileDerivedExpression(item, selectedTypes, parameters));
    return { sql: `COALESCE(${values.map((item) => item.sql).join(", ")})`, type: values[0].type };
  }
  if (expression.op === "nullif") {
    const value = compileDerivedExpression(expression.value, selectedTypes, parameters);
    const other = compileDerivedExpression(expression.other ?? { op: "literal", value: 0 }, selectedTypes, parameters);
    return { sql: `NULLIF(${value.sql}, ${other.sql})`, type: value.type };
  }
  if (expression.op === "cast") {
    const value = compileDerivedExpression(expression.value, selectedTypes, parameters);
    const type = safeType(expression.type);
    return { sql: `CAST(${value.sql} AS ${type})`, type };
  }
  return fail(
    "type_check",
    "unsupported_cross_fact_expression",
    `Expression operator '${expression.op}' is not supported for cross-fact measures`,
  );
}

function compileMultiFactQuery(
  catalogs: readonly CatalogData[],
  environment: SemanticEnvironment,
  query: SemanticQuery,
  roots: SemanticRef[],
): SemanticCompileResult {
  if (roots.length > MAX_FACT_BRANCHES)
    fail(
      "request_validation",
      "fact_branch_limit",
      `At most ${MAX_FACT_BRANCHES} fact roots may be selected`,
    );
  const measures = query.measures ?? [];
  const dimensions = query.dimensions ?? [];
  validateMultiFactOutputNames(query);
  validateBranchRelationshipPaths(dimensions, roots);
  validateBranchMembers(environment, dimensions, roots, query.bindings ?? {});
  validateMultiFactPopulationFilters(environment, query);
  const partitions = partitionMultiFactSources(query, roots);
  const branchPlans: SemanticPlan[] = [];
  const branchMeasureNames: string[][] = [];
  roots.forEach((root, index) => {
    const branchMeasures = measures
      .filter((measure) => refKey(measure) === refKey(root))
      .map(({ missing_fact_value: _ignored, ...measure }) => ({ ...measure }));
    const branchQuery: SemanticQuery = {
      ...query,
      measures: branchMeasures,
      dimensions: dimensions.map((dimension) =>
        dimensionForBranch(dimension, root),
      ),
      source_bindings: partitions[index].source_bindings,
      inputs: partitions[index].inputs,
    };
    delete branchQuery.measure_filters;
    delete branchQuery.derived_measures;
    delete branchQuery.order;
    delete branchQuery.limit;
    const compiled = compileSemanticQueryInternal(catalogs, branchQuery, true);
    if (!compiled.ok) throw new CompileFailure(compiled.diagnostics[0]);
    branchPlans.push(compiled.plan);
    branchMeasureNames.push(
      branchMeasures.map((measure) => measure.alias ?? measure.member_id),
    );
  });

  const commonGrain = [...branchPlans[0].fact_branches[0].result_grain];
  const explicitGrain = dimensions.map(
    (dimension) => dimension.alias ?? dimension.member_id,
  );
  const implicitGrain = commonGrain.filter(
    (member) => !explicitGrain.includes(member),
  );
  const implicitSources = (plan: SemanticPlan) =>
    plan.fact_branches[0].effective_source_grain
      .filter((item) => implicitGrain.includes(item.output_name))
      .map((item) => [item.output_name, `${item.source}::${item.member}`])
      .sort(([left], [right]) => left.localeCompare(right));
  const firstImplicitSources = implicitSources(branchPlans[0]);
  branchPlans.slice(1).forEach((plan, index) => {
    const grain = plan.fact_branches[0].result_grain;
    if (JSON.stringify(grain) !== JSON.stringify(commonGrain))
      fail(
        "type_check",
        "incompatible_branch_grain",
        `Fact branch ${index + 2} has result grain ${JSON.stringify(grain)}; expected ${JSON.stringify(commonGrain)}`,
      );
    if (
      JSON.stringify(implicitSources(plan)) !==
      JSON.stringify(firstImplicitSources)
    )
      fail(
        "type_check",
        "incompatible_branch_grain",
        "Correlated fact branches must expose the same driving grain members",
      );
  });

  const totalInvocations = branchPlans.reduce(
    (total, plan) =>
      total +
      plan.fact_branches.reduce(
        (branchTotal, branch) =>
          branchTotal + (branch.estimated_invocations ?? 0),
        0,
      ),
    0,
  );
  const maxInvocations = Math.min(
    HARD_MAX_INVOCATIONS,
    query.execution_limits?.max_invocations ?? DEFAULT_MAX_INVOCATIONS,
  );
  if (totalInvocations > maxInvocations)
    fail(
      "execution_limit",
      "invocation_limit",
      `Fact branches may execute ${totalInvocations} function rows, above limit ${maxInvocations}`,
    );

  const measureBranches: Record<string, SemanticRef> = {};
  const missingFactValues: Record<string, "null" | "zero"> = {};
  const measureExpressions = new Map<string, string>();
  let selectItems = commonGrain.map((name) => `"_keys".${quoteIdent(name)}`);
  roots.forEach((root, branchIndex) => {
    const selected = measures.filter(
      (measure) => refKey(measure) === refKey(root),
    );
    selected.forEach((selection, measureIndex) => {
      const name = branchMeasureNames[branchIndex][measureIndex];
      const policy = selection.missing_fact_value ?? "null";
      let expression = `"_f${branchIndex}".${quoteIdent(name)}`;
      if (policy === "zero")
        expression = `COALESCE(${expression}, CAST(0 AS ${measureZeroType(environment, selection, query.bindings ?? {})}))`;
      selectItems.push(`${expression} AS ${quoteIdent(name)}`);
      measureExpressions.set(name, expression);
      measureBranches[name] = root;
      missingFactValues[name] = policy;
    });
  });

  const ctes = branchPlans.map(
    (plan, index) => `"_f${index}" AS (\n${plan.sql}\n)`,
  );
  let fromLines: string[];
  if (commonGrain.length) {
    const keys = branchPlans.map(
      (_plan, index) =>
        `SELECT ${commonGrain.map(quoteIdent).join(", ")} FROM "_f${index}"`,
    );
    ctes.push(`"_keys" AS (\n${keys.join("\nUNION\n")}\n)`);
    fromLines = ['FROM "_keys"'];
    branchPlans.forEach((_plan, index) => {
      const predicates = commonGrain
        .map(
          (name) =>
            `"_keys".${quoteIdent(name)} IS NOT DISTINCT FROM "_f${index}".${quoteIdent(name)}`,
        )
        .join(" AND ");
      fromLines.push(`LEFT JOIN "_f${index}" ON ${predicates}`);
    });
  } else {
    selectItems = selectItems.slice(commonGrain.length);
    fromLines = [
      'FROM "_f0"',
      ...branchPlans
        .slice(1)
        .map((_plan, index) => `CROSS JOIN "_f${index + 1}"`),
    ];
  }

  const parameters = branchPlans.flatMap((plan) => plan.parameters);
  const derivedDefinitions = query.derived_measures ?? [];
  const selectedByName = new Map(
    measures.map((measure) => [measure.alias ?? measure.member_id, measure]),
  );
  const selectedTypes = new Map<string, string>();
  if (derivedDefinitions.length)
    for (const [name, selection] of selectedByName) {
      const type = selectedMeasureType(environment, selection, query.bindings ?? {});
      if (!type)
        fail(
          "type_check",
          "derived_measure_input_type_unknown",
          `Selected measure '${name}' has no provable result type`,
        );
      selectedTypes.set(name, type!);
    }
  const derivedSelects: string[] = [];
  for (const derived of derivedDefinitions) {
    const refs = derivedMemberRefs(derived.expression);
    const unknown = [...refs].filter((ref) => !selectedByName.has(ref)).sort();
    if (unknown.length)
      fail(
        "request_validation",
        "derived_measure_member_not_selected",
        `Derived measure '${derived.name}' references unselected outputs ${JSON.stringify(unknown)}`,
      );
    const referencedRoots = new Set(
      [...refs].map((ref) => refKey(selectedByName.get(ref)!)),
    );
    if (referencedRoots.size < 2)
      fail(
        "request_validation",
        "derived_measure_requires_multiple_facts",
        `Derived measure '${derived.name}' must reference measures from at least two facts`,
      );
    const unspecified = [...refs]
      .filter((ref) => selectedByName.get(ref)?.missing_fact_value == null)
      .sort();
    if (unspecified.length)
      fail(
        "request_validation",
        "derived_measure_missing_value_policy_required",
        `Derived measure '${derived.name}' requires explicit missing_fact_value for ${JSON.stringify(unspecified)}`,
      );
    const compiled = compileDerivedExpression(
      derived.expression,
      selectedTypes,
      parameters,
    );
    const outputType = safeType(derived.output_type);
    derivedSelects.push(
      `CAST(${compiled.sql} AS ${outputType}) AS ${quoteIdent(derived.name)}`,
    );
    selectedTypes.set(derived.name, outputType);
  }
  const filterSelections = [...measures];
  let filterExpressions = measureExpressions;
  if (derivedDefinitions.length) {
    for (const derived of derivedDefinitions)
      filterSelections.push({
        catalog_id: "query",
        entity_id: "derived",
        member_id: derived.name,
        alias: derived.name,
      });
    filterExpressions = new Map(
      [...selectedTypes].map(([name]) => [name, `"_projected".${quoteIdent(name)}`]),
    );
  }
  const outerFilter = compileStitchedMeasureFilter(
    query.measure_filters,
    filterSelections,
    filterExpressions,
    parameters,
  );
  const outputNames = new Set([
    ...commonGrain,
    ...measureExpressions.keys(),
    ...selectedTypes.keys(),
  ]);
  const order = (query.order ?? []).map((item) => {
    if (!outputNames.has(item.member))
      return fail(
        "request_validation",
        "invalid_order_member",
        `ORDER BY '${item.member}' is not a selected output`,
      );
    return `${quoteIdent(item.member)} ${item.direction.toUpperCase()}`;
  });
  const limit = Math.min(10_000, Math.max(1, query.limit ?? 1000));
  let sql: string;
  if (derivedDefinitions.length) {
    ctes.push(
      `"_stitched" AS (\nSELECT ${selectItems.join(", ")}\n${fromLines.join("\n")}\n)`,
    );
    ctes.push(
      `"_projected" AS (\nSELECT "_stitched".*, ${derivedSelects.join(", ")}\nFROM "_stitched"\n)`,
    );
    sql = [
      `WITH ${ctes.join(",\n")}`,
      'SELECT * FROM "_projected"',
      outerFilter ? `WHERE ${outerFilter}` : "",
      order.length ? `ORDER BY ${order.join(", ")}` : "",
      `LIMIT ${limit}`,
    ].filter(Boolean).join("\n");
  } else {
    sql = [
      `WITH ${ctes.join(",\n")}`,
      `SELECT ${selectItems.join(", ")}`,
      ...fromLines,
      outerFilter ? `WHERE ${outerFilter}` : "",
      order.length ? `ORDER BY ${order.join(", ")}` : "",
      `LIMIT ${limit}`,
    ].filter(Boolean).join("\n");
  }

  const outputUnits: Record<string, string | null> = {};
  const unitDiagnostics: SemanticDiagnostic[] = [];
  const warnings: string[] = [];
  for (const plan of branchPlans) {
    for (const [name, unit] of Object.entries(plan.output_units ?? {})) {
      if (name in outputUnits && outputUnits[name] !== unit)
        fail(
          "unit_resolution",
          "incompatible_branch_unit",
          `Conformed output '${name}' resolves to different units across fact branches`,
        );
      outputUnits[name] = unit;
    }
    for (const diagnostic of plan.unit_diagnostics ?? [])
      if (
        !unitDiagnostics.some(
          (existing) => JSON.stringify(existing) === JSON.stringify(diagnostic),
        )
      )
        unitDiagnostics.push(diagnostic);
    for (const warning of plan.warnings)
      if (!warnings.includes(warning)) warnings.push(warning);
  }
  for (const derived of derivedDefinitions)
    if (derived.unit) outputUnits[derived.name] = derived.unit;
  return {
    ok: true,
    plan: {
      fact_branches: branchPlans.flatMap((plan) => plan.fact_branches),
      stitch: {
        strategy: "conformed_dimension_spine",
        result_grain: commonGrain,
        branch_roots: roots,
        measure_branches: measureBranches,
        missing_fact_values: missingFactValues,
        ...(derivedDefinitions.length
          ? {
              derived_measures: derivedDefinitions.map((item) => ({
                name: item.name,
                output_type: item.output_type,
              })),
            }
          : {}),
      },
      sql,
      parameters,
      validation_scope: "semantic",
      warnings,
      ...(Object.keys(outputUnits).length ? { output_units: outputUnits } : {}),
      ...(unitDiagnostics.length ? { unit_diagnostics: unitDiagnostics } : {}),
    },
  };
}

function compileSemanticQueryInternal(
  catalogs: readonly CatalogData[],
  query: SemanticQuery,
  branchMode = false,
): SemanticCompileResult {
  try {
    const requestErrors = validateSemanticValue("query", query);
    if (requestErrors.length)
      return {
        ok: false,
        diagnostics: requestErrors.map((message) => ({
          stage: "request_validation",
          code: "query_schema",
          message,
        })),
      };
    const environment = buildSemanticEnvironment(catalogs);
    const blockingModelDiagnostics = environment.diagnostics.filter(
      (diagnostic) => diagnostic.code !== "duplicate_relationship_candidate",
    );
    if (blockingModelDiagnostics.length)
      return { ok: false, diagnostics: blockingModelDiagnostics };
    const measures = query.measures ?? [];
    const dimensions = query.dimensions ?? [];
    if (!measures.length && !dimensions.length)
      fail(
        "request_validation",
        "empty_selection",
        "Select at least one measure or dimension",
      );
    if (measures.length > 50 || dimensions.length > 50)
      fail(
        "request_validation",
        "selection_limit",
        "At most 50 measures and 50 dimensions may be selected",
      );
    const allFilterMembers = [
      ...filterMembers(query.filters),
      ...filterMembers(query.measure_filters),
    ];
    if (allFilterMembers.length > 100)
      fail(
        "request_validation",
        "filter_node_limit",
        "At most 100 filter predicates are allowed",
      );
    const roots = orderedMeasureRoots(measures);
    if (roots.length > 1) {
      if (branchMode)
        fail(
          "sql_generation",
          "nested_multi_fact",
          "A fact branch must contain measures from exactly one root",
        );
      return compileMultiFactQuery(catalogs, environment, query, roots);
    }
    if (
      measures.length &&
      measures.some((measure) => measure.missing_fact_value !== undefined)
    )
      fail(
        "request_validation",
        "missing_fact_value_requires_multi_fact",
        "missing_fact_value is only meaningful when stitching multiple fact roots",
      );
    if (
      dimensions.some(
        (dimension) => (dimension.branch_relationship_paths?.length ?? 0) > 0,
      )
    )
      fail(
        "request_validation",
        "branch_relationship_paths_require_multi_fact",
        "branch_relationship_paths is only meaningful with multiple fact roots",
      );
    if (dimensions.some((dimension) => (dimension.branch_members?.length ?? 0) > 0))
      fail(
        "request_validation",
        "branch_members_require_multi_fact",
        "branch_members is only meaningful with multiple fact roots",
      );
    if (query.derived_measures?.length)
      fail(
        "request_validation",
        "derived_measures_require_multi_fact",
        "Query-level derived measures require multiple fact roots",
      );
    const rootRef = measures[0] ?? query.root_entity;
    if (!rootRef)
      fail(
        "request_validation",
        "root_entity_required",
        "Dimension-only queries require root_entity",
      );
    const resolvedRoot = resolveEntity(
      environment,
      rootRef,
      query.bindings ?? {},
    );
    if ("stage" in resolvedRoot) throw new CompileFailure(resolvedRoot);
    const root = resolvedRoot;
    const parameters: unknown[] = [];
    const invocation = compileInvocationSource(
      environment,
      root,
      query,
      parameters,
    );
    const renderSourceArgumentMember: SourceArgumentRenderer = (
      entity,
      member,
    ) => {
      const argumentName = member.source_argument ?? "";
      const physical = entity.functionArguments.filter(
        (argument) => argument.name === argumentName,
      );
      const mappings = entity.sourceArguments.filter(
        (mapping) => mapping.argument === argumentName,
      );
      if (physical.length !== 1 || mappings.length !== 1)
        fail(
          "model_resolution",
          "source_argument_member_unresolved",
          `Cannot resolve source argument '${argumentName}' for member '${member.member_id}'`,
        );
      const argument = physical[0];
      const mapping = mappings[0];
      const sourceBinding = query.source_bindings?.find(
        (binding) => refKey(binding.entity) === entity.key,
      );
      const override = sourceBinding?.arguments[argumentName];
      if (override && "input_column" in override) {
        const inputId =
          sourceBinding && "input_id" in sourceBinding.driver
            ? sourceBinding.driver.input_id
            : "";
        const path = invocation?.paths.get(`input:${inputId}`);
        if (!path)
          return fail(
            "source_binding",
            "source_argument_value_unavailable",
            `Input driver '${inputId}' is unavailable for member '${member.member_id}'`,
          );
        return `${pathAlias("_e0", path)}.${quoteIdent(override.input_column)}`;
      }
      if (override && "member" in override) {
        const driver = resolveEntity(
          environment,
          override.member,
          query.bindings ?? {},
        );
        if ("stage" in driver) throw new CompileFailure(driver);
        const driverMember = driver.members.get(override.member.member_id);
        const path = invocation?.paths.get(entityMarker(driver));
        if (!driverMember || !path)
          return fail(
            "source_binding",
            "source_argument_value_unavailable",
            `Entity driver value is unavailable for member '${member.member_id}'`,
          );
        return memberSql(driver, driverMember, pathAlias("_e0", path));
      }
      const parameterName =
        override && "parameter" in override
          ? override.parameter
          : mapping.parameter;
      let value = Object.prototype.hasOwnProperty.call(
        query.parameters ?? {},
        parameterName,
      )
        ? query.parameters?.[parameterName]
        : undefined;
      if (value === undefined) value = argument.defaultValue;
      if (value === undefined)
        fail(
          mapping.required === false ? "source_binding" : "required_filter",
          mapping.required === false
            ? "source_argument_value_unavailable"
            : "missing_source_parameter",
          `Source argument '${argumentName}' has no effective value for member '${member.member_id}'`,
        );
      if (!valueCompatible(value, argument.duckdbType))
        fail(
          "type_check",
          "incompatible_parameter_type",
          `Parameter '${parameterName}' is incompatible with argument '${argumentName}'`,
        );
      parameters.push(value);
      return `CAST(? AS ${safeType(member.data_type ?? member.output_type!)})`;
    };
    const aliasByEntity = invocation
      ? new Map(
          [...invocation.paths].flatMap(([marker, path]) =>
            marker.startsWith("input:")
              ? []
              : [[marker, pathAlias("_e0", path)]],
          ),
        )
      : new Map<string, string>([[entityMarker(root), "_e0"]]);
    const joins: Array<{
      edge: ReturnType<typeof findPath>[number];
      alias: string;
    }> = [];
    const selected = [...dimensions, ...measures];
    const addEntityPath = (
      entity: SemanticEntity,
      relationshipPath?: string[],
    ) => {
      if (aliasByEntity.has(entityMarker(entity))) return;
      const path = findPath(
        environment,
        root,
        entity,
        relationshipPath,
        query.bindings ?? {},
      );
      for (const edge of path) {
        const max = edge.forward
          ? edge.relationship.toCardinality.max
          : edge.relationship.fromCardinality.max;
        if (max === "many")
          fail(
            "fanout",
            "fanout_unsafe",
            `Relationship '${edge.relationship.relationshipId}' traverses into a many side`,
          );
        if (
          edge.to.sourceKind === "table_function" &&
          edge.to.sourceArguments.length
        )
          fail(
            "relationship_resolution",
            "parameterized_joined_function",
            `Joined table function '${edge.to.entityId}' must be zero-argument`,
          );
        const marker = entityMarker(edge.to);
        if (!aliasByEntity.has(marker)) {
          const alias = `_e${aliasByEntity.size}`;
          aliasByEntity.set(marker, alias);
          joins.push({ edge, alias });
        }
      }
    };
    const resolvedSelections = selected.map((selection) => {
      const entity = resolveEntity(
        environment,
        selection,
        query.bindings ?? {},
      );
      if ("stage" in entity) throw new CompileFailure(entity);
      addEntityPath(entity, selection.relationship_path);
      const member = entity.members.get(selection.member_id);
      if (!member)
        throw new CompileFailure({
          stage: "model_resolution",
          code: "unknown_member",
          message: `Unknown member '${selection.member_id}' on '${entity.entityId}'`,
        });
      return {
        selection,
        entity,
        member,
        alias: aliasByEntity.get(entityMarker(entity))!,
      };
    });
    for (const memberRef of [
      ...filterMembers(query.filters),
      ...filterMembers(query.measure_filters),
    ]) {
      if (typeof memberRef === "string") continue;
      const entity = resolveEntity(
        environment,
        memberRef,
        query.bindings ?? {},
      );
      if ("stage" in entity) throw new CompileFailure(entity);
      addEntityPath(entity, memberRef.relationship_path);
    }
    const dimensionSelections = resolvedSelections.slice(0, dimensions.length);
    const measureSelections = resolvedSelections.slice(dimensions.length);
    const memberLookup = new Map<
      string,
      { entity: SemanticEntity; member: SemanticMember; alias: string }
    >();
    const ambiguousMembers = new Set<string>();
    const participatingEntities = [
      ...new Map(
        [
          root,
          ...(invocation ? [...invocation.entities.values()] : []),
          ...joins.map((join) => join.edge.to),
        ].map((entity) => [entityMarker(entity), entity]),
      ).values(),
    ];
    for (const entity of participatingEntities)
      for (const [id, member] of entity.members) {
        const resolved = {
          entity,
          member,
          alias: aliasByEntity.get(entityMarker(entity))!,
        };
        memberLookup.set(`${entity.key}::${id}`, resolved);
        if (memberLookup.has(id) || ambiguousMembers.has(id)) {
          memberLookup.delete(id);
          ambiguousMembers.add(id);
        } else memberLookup.set(id, resolved);
      }
    const selects: string[] = [];
    const groups: string[] = [];
    const outputNames = new Set<string>();
    const resultGrain: string[] = [];
    const drivingPlanGrain: Array<{
      source: string;
      member: string;
      output_name: string;
    }> = [];
    const outputUnits: Record<string, string | null> = {};
    const unitDiagnostics: SemanticDiagnostic[] = [];
    const recordUnit = (
      item: (typeof resolvedSelections)[number],
      outputName: string,
    ) => {
      const resolved = resolveOutputUnit(
        item.entity,
        item.member,
        outputName,
        query,
      );
      if (resolved.declared) outputUnits[outputName] = resolved.unit;
      if (resolved.diagnostic) unitDiagnostics.push(resolved.diagnostic);
    };
    if (invocation && !query.allow_driving_grain_reduction) {
      const selectedRefs = new Set(
        dimensions.map((item) => `${refKey(item)}::${item.member_id}`),
      );
      for (const grain of invocation.drivingGrain) {
        let sql: string;
        if (grain.entity) {
          if (selectedRefs.has(`${grain.entity.key}::${grain.member}`))
            continue;
          const member = grain.entity.members.get(grain.member);
          if (!member)
            fail(
              "source_binding",
              "unknown_driver_grain",
              `Driver grain member '${grain.member}' does not exist`,
            );
          sql = memberSql(grain.entity, member!, pathAlias("_e0", grain.path));
        } else
          sql = `${pathAlias("_e0", grain.path)}.${quoteIdent(grain.member)}`;
        let name = grain.member;
        if (
          outputNames.has(name) ||
          dimensions.some((item) => (item.alias ?? item.member_id) === name)
        )
          name = `${grain.source.split("::").at(-1)}__${grain.member}`;
        if (outputNames.has(name))
          fail(
            "source_binding",
            "driving_grain_name_collision",
            `Driving grain output '${name}' is ambiguous`,
          );
        outputNames.add(name);
        selects.push(`${sql} AS ${quoteIdent(name)}`);
        groups.push(sql);
        resultGrain.push(name);
        drivingPlanGrain.push({
          source: grain.source,
          member: grain.member,
          output_name: name,
        });
      }
    }
    for (const item of dimensionSelections) {
      if (item.member.kind === "measure")
        fail(
          "type_check",
          "not_a_dimension",
          `'${item.member.member_id}' is a measure, not a dimension`,
        );
      let sql = memberSql(
        item.entity,
        item.member,
        item.alias,
        [],
        renderSourceArgumentMember,
      );
      if (item.selection.granularity) {
        if (
          item.member.kind !== "time_dimension" ||
          !item.member.granularities?.includes(item.selection.granularity)
        )
          fail(
            "type_check",
            "invalid_time_granularity",
            `Granularity '${item.selection.granularity}' is not allowed for '${item.member.member_id}'`,
          );
        sql = `date_trunc(${quoteLiteral(item.selection.granularity)}, ${sql} AT TIME ZONE ${quoteLiteral(item.member.timezone ?? "UTC")})`;
      }
      const name = item.selection.alias ?? item.member.member_id;
      if (outputNames.has(name))
        fail(
          "request_validation",
          "duplicate_output",
          `Duplicate output name '${name}'`,
        );
      outputNames.add(name);
      selects.push(`${sql} AS ${quoteIdent(name)}`);
      groups.push(
        memberUsesSourceArgument(item.entity, item.member)
          ? String(selects.length)
          : sql,
      );
      resultGrain.push(name);
      recordUnit(item, name);
    }
    const selectedDimensionIds = new Set(
      dimensionSelections.map((item) => item.member.member_id),
    );
    for (const item of measureSelections) {
      if (item.member.kind !== "measure")
        fail(
          "type_check",
          "not_a_measure",
          `'${item.member.member_id}' is not a measure`,
        );
      if (typeof item.member.additivity === "object") {
        const prohibited = item.member.additivity.prohibited_dimensions.filter(
          (id) => selectedDimensionIds.has(id),
        );
        if (prohibited.length)
          fail(
            "type_check",
            "semi_additive_dimension",
            `Measure '${item.member.member_id}' cannot be grouped by ${prohibited.join(", ")}`,
          );
      }
      const name = item.selection.alias ?? item.member.member_id;
      if (outputNames.has(name))
        fail(
          "request_validation",
          "duplicate_output",
          `Duplicate output name '${name}'`,
        );
      outputNames.add(name);
      selects.push(
        `${aggregateSql(item.entity, item.member, item.alias, [], renderSourceArgumentMember, parameters)} AS ${quoteIdent(name)}`,
      );
      recordUnit(item, name);
    }
    const from = `FROM ${invocation?.source ?? sourceSql(root, query, parameters)} AS _e0`;
    const joinSql = joins
      .map(({ edge, alias }) => {
        const leftAlias = aliasByEntity.get(entityMarker(edge.from))!;
        const targetSource = sourceSql(edge.to, query, parameters);
        const pairs = edge.relationship.predicate.map((pair) =>
          relationshipPredicateSql(edge, pair, leftAlias, alias),
        );
        pairs.push(
          ...edge.relationship.conditions.map((condition) =>
            relationshipConditionSql(
              edge,
              condition,
              leftAlias,
              alias,
              parameters,
            ),
          ),
        );
        const cardinality = edge.forward
          ? edge.relationship.toCardinality
          : edge.relationship.fromCardinality;
        return `${cardinality.min === 1 ? "INNER" : "LEFT"} JOIN ${targetSource} AS ${alias} ON ${pairs.join(" AND ")}`;
      })
      .join("\n");
    const where = compileFilter(
      query.filters,
      memberLookup,
      parameters,
      renderSourceArgumentMember,
    );
    const having = compileFilter(
      query.measure_filters,
      memberLookup,
      parameters,
      renderSourceArgumentMember,
    );
    const whereMembers = filterMembers(query.filters)
      .map((member) => memberLookup.get(filterMemberKey(member)))
      .filter(Boolean);
    const requiredEntities = [
      ...new Map(
        [
          root,
          ...(invocation?.invocationEntities ?? []),
          ...joins.map((join) => join.edge.to),
        ].map((entity) => [entityMarker(entity), entity]),
      ).values(),
    ];
    for (const entity of requiredEntities) {
      if (invocation?.prevalidatedRequiredEntities.has(entityMarker(entity)))
        continue;
      for (const group of entity.requiredFilters) {
        const filteredLocally = group.some((column) =>
          [...entity.members.values()].some(
            (member) =>
              memberPhysicalKey(member) === column &&
              whereMembers.some(
                (filtered) =>
                  filtered?.member === member && filtered.entity === entity,
              ),
          ),
        );
        const suppliedAsSourceArgument = group.some((column) =>
          entity.sourceArguments.some(
            (mapping) =>
              mapping.argument === column &&
              mapping.parameter in (query.parameters ?? {}),
          ),
        );
        const suppliedAsCorrelatedArgument = group.some((column) =>
          (query.source_bindings ?? []).some((binding) => {
            if (refKey(binding.entity) !== entity.key) return false;
            const bound = binding.arguments[column];
            return Boolean(
              bound &&
              ("input_column" in bound ||
                "member" in bound ||
                ("parameter" in bound &&
                  bound.parameter in (query.parameters ?? {}))),
            );
          }),
        );
        if (
          !filteredLocally &&
          !suppliedAsSourceArgument &&
          !suppliedAsCorrelatedArgument
        ) {
          fail(
            "required_filter",
            "required_filter_missing",
            `Entity '${entity.entityId}' requires a source-local filter on one of: ${group.join(", ")}`,
          );
        }
      }
    }
    const order = (query.order ?? []).map((item) => {
      if (!outputNames.has(item.member))
        fail(
          "request_validation",
          "invalid_order_member",
          `ORDER BY '${item.member}' is not a selected output`,
        );
      return `${quoteIdent(item.member)} ${item.direction.toUpperCase()}`;
    });
    const limit = Math.min(10000, Math.max(1, Math.floor(query.limit ?? 1000)));
    const sql = [
      invocation?.withSql ?? "",
      `SELECT ${selects.join(", ")}`,
      from,
      joinSql,
      where ? `WHERE ${where}` : "",
      groups.length ? `GROUP BY ${groups.join(", ")}` : "",
      having ? `HAVING ${having}` : "",
      order.length && !branchMode ? `ORDER BY ${order.join(", ")}` : "",
      !branchMode ? `LIMIT ${limit}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const effective =
      invocation?.effectiveGrain ??
      root.grain.map((member) => ({ source: root.key, member }));
    const effectivePlan = effective.map((grain) => ({
      source: grain.source,
      member: grain.member,
      output_name:
        drivingPlanGrain.find(
          (item) =>
            item.source === grain.source && item.member === grain.member,
        )?.output_name ?? grain.member,
    }));
    const invocationEntities = invocation
      ? [...invocation.paths.keys()].filter(
          (marker) => !marker.startsWith("input:"),
        )
      : [];
    return {
      ok: true,
      plan: {
        fact_branches: [
          {
            root: { catalog_id: root.catalogId, entity_id: root.entityId },
            attachment_alias: root.attachmentAlias,
            entities: [
              ...new Set([...invocationEntities, ...aliasByEntity.keys()]),
            ],
            ...(invocation
              ? {
                  driver: {
                    kind: invocation.invocations[0].driver_kind,
                    source: invocation.invocations[0].driver,
                  },
                }
              : {}),
            invocations: invocation?.invocations ?? [],
            effective_source_grain: effectivePlan,
            result_grain: resultGrain,
            estimated_invocations: invocation?.estimatedInvocations ?? 0,
            driving_grain_reduced: Boolean(
              invocation && query.allow_driving_grain_reduction,
            ),
          },
        ],
        sql,
        parameters,
        validation_scope: "semantic",
        warnings: environment.diagnostics
          .filter((item) => item.code === "duplicate_relationship_candidate")
          .map((item) => item.message),
        ...(Object.keys(outputUnits).length
          ? { output_units: outputUnits }
          : {}),
        ...(unitDiagnostics.length
          ? { unit_diagnostics: unitDiagnostics }
          : {}),
      },
    };
  } catch (error) {
    if (error instanceof CompileFailure)
      return { ok: false, diagnostics: [error.diagnostic] };
    return {
      ok: false,
      diagnostics: [
        {
          stage: "sql_generation",
          code: "internal_compiler_error",
          message: error instanceof Error ? error.message : String(error),
        } as any,
      ],
    };
  }
}

export function compileSemanticQuery(
  catalogs: readonly CatalogData[],
  query: SemanticQuery,
): SemanticCompileResult {
  return compileSemanticQueryInternal(catalogs, query);
}

export { buildSemanticEnvironment };
