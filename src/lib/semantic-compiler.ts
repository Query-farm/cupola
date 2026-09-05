import { quoteIdent, quoteLiteral } from "./duckdb-query";
import { buildSemanticEnvironment, resolveEntity, type SemanticDiagnostic, type SemanticEntity, type SemanticEnvironment, type SemanticExpression, type SemanticMember, type SemanticRef, type SemanticRelationship } from "./semantic-model";
import type { CatalogData } from "./service";
import { validateSemanticValue } from "./semantic-validation";

export interface SemanticSelection extends SemanticRef { member_id: string; alias?: string; relationship_path?: string[]; granularity?: string }
export type SemanticFilterMember = string | (SemanticRef & { member_id: string; relationship_path?: string[] });
export type SemanticFilter = { and: SemanticFilter[] } | { or: SemanticFilter[] } | { member: SemanticFilterMember; operator: string; value?: unknown; values?: unknown[] };
export interface SemanticInput { input_id: string; grain: string[]; columns: Array<{ name: string; type: string; nullable?: boolean }>; rows: unknown[][] }
export type SemanticSourceArgumentBinding = { parameter: string } | { input_column: string } | { member: SemanticRef & { member_id: string } };
export interface SemanticSourceBinding { entity: SemanticRef; driver: { input_id: string } | { entity: SemanticRef; max_rows: number; filters?: SemanticFilter; order?: Array<{ member_id: string; direction: "asc" | "desc" }> }; arguments: Record<string, SemanticSourceArgumentBinding>; max_output_rows?: number }
export interface SemanticQuery { measures?: SemanticSelection[]; dimensions?: SemanticSelection[]; filters?: SemanticFilter; measure_filters?: SemanticFilter; order?: Array<{ member: string; direction: "asc" | "desc" }>; limit?: number; compile_only?: boolean; root_entity?: SemanticRef; bindings?: Record<string, string>; parameters?: Record<string, unknown>; inputs?: SemanticInput[]; source_bindings?: SemanticSourceBinding[]; allow_driving_grain_reduction?: boolean; execution_limits?: { max_invocations?: number } }
export interface SemanticPlan { fact_branches: Array<{ root: SemanticRef; attachment_alias: string; entities: string[]; driver?: Record<string, unknown>; invocations: Array<Record<string, unknown>>; effective_source_grain: Array<{ source: string; member: string; output_name: string }>; result_grain: string[]; estimated_invocations: number; driving_grain_reduced: boolean }>; sql: string; parameters: unknown[]; validation_scope: "semantic"; warnings: string[] }
export type SemanticCompileResult = { ok: true; plan: SemanticPlan } | { ok: false; diagnostics: SemanticDiagnostic[] };

class CompileFailure extends Error { constructor(readonly diagnostic: SemanticDiagnostic) { super(diagnostic.message); } }
const fail = (stage: SemanticDiagnostic["stage"] | "request_validation" | "multi_fact_not_supported" | "type_check" | "fanout" | "required_filter" | "sql_generation", code: string, message: string): never => { throw new CompileFailure({ stage: stage as any, code, message }); };
const refKey = (value: SemanticRef) => `${value.catalog_id}::${value.entity_id}`;
const entityMarker = (entity: SemanticEntity) => `${entity.attachmentAlias}:${entity.key}`;
const MAX_INLINE_ROWS = 100, MAX_INLINE_COLUMNS = 32, MAX_INLINE_CELLS = 3200, MAX_INLINE_BYTES = 1_000_000;
const DEFAULT_MAX_INVOCATIONS = 100, HARD_MAX_INVOCATIONS = 1000, DEFAULT_MAX_STAGE_ROWS = 10_000;
function safeType(type: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_ ]*(?:\([0-9]+(?:,[0-9]+)?\))?(?:\[\])?$/.test(type)) {
    fail("type_check", "invalid_output_type", `Unsafe or unsupported DuckDB type '${type}'`);
  }
  return type;
}

function literalSql(value: string | number | boolean | null): string {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : fail("type_check", "invalid_number", "Expression literals must be finite numbers");
  return quoteLiteral(value);
}

function resolvedSourceArguments(entity: SemanticEntity) {
  if (!entity.sourceArguments.length) return [];
  if (!entity.functionArguments.length) fail("model_resolution", "missing_function_argument_metadata", `Table function '${entity.entityId}' requires vgi_function_arguments() metadata`);
  const fieldIndexes = entity.functionArguments.flatMap((argument) => argument.fieldIndex == null ? [] : [argument.fieldIndex]);
  if (entity.functionOverloadCount > 1 || new Set(fieldIndexes).size !== fieldIndexes.length) fail("model_resolution", "ambiguous_function_overload", `Table function '${entity.entityId}' has ambiguous overload metadata`);
  if (entity.functionArguments.some((argument) => argument.isVarargs)) fail("model_resolution", "unsupported_function_varargs", `Table function '${entity.entityId}' uses unsupported varargs`);
  if (entity.functionArguments.some((argument) => argument.isTableInput)) fail("model_resolution", "unsupported_table_input", `Table function '${entity.entityId}' requires an unsupported table input`);
  const byName = new Map<string, typeof entity.functionArguments>();
  for (const argument of entity.functionArguments) byName.set(argument.name, [...(byName.get(argument.name) ?? []), argument]);
  return entity.sourceArguments.map((mapping) => {
    const matches = byName.get(mapping.argument) ?? [];
    if (!matches.length) fail("model_resolution", "unknown_source_argument", `Source mapping references unknown function argument '${mapping.argument}'`);
    if (matches.length > 1) fail("model_resolution", "ambiguous_source_argument", `Source argument '${mapping.argument}' resolves to more than one overload`);
    const argument = matches[0];
    if (Boolean(argument.named) === Boolean(argument.positional)) fail("model_resolution", "invalid_source_argument_kind", `Source argument '${mapping.argument}' is not unambiguously named or positional`);
    if (argument.positional && argument.position == null) fail("model_resolution", "missing_source_argument_position", `Positional source argument '${mapping.argument}' has no arg_position`);
    return { mapping, argument };
  });
}

function sourceSql(entity: SemanticEntity, query: SemanticQuery, parameters: unknown[]): string {
  const qualified = `${quoteIdent(entity.attachmentAlias)}.${quoteIdent(entity.schemaName)}.${quoteIdent(entity.sourceName)}`;
  if (entity.sourceKind === "relation") return qualified;
  const bindings = resolvedSourceArguments(entity);
  const positional = bindings.filter(({ argument }) => argument.positional).sort((left, right) => left.argument.position! - right.argument.position!);
  const named = bindings.filter(({ argument }) => argument.named).sort((left, right) => (left.argument.fieldIndex ?? Number.MAX_SAFE_INTEGER) - (right.argument.fieldIndex ?? Number.MAX_SAFE_INTEGER) || left.argument.name.localeCompare(right.argument.name));
  const supplied = query.parameters ?? {};
  const suppliedPositions = new Set(positional.filter(({ mapping }) => mapping.parameter in supplied).map(({ argument }) => argument.position!));
  if (suppliedPositions.size) {
    const highest = Math.max(...suppliedPositions);
    const missing = entity.functionArguments
      .filter((argument) => argument.positional && argument.position != null && argument.position < highest && !suppliedPositions.has(argument.position))
      .sort((left, right) => left.position! - right.position!)
      .map((argument) => argument.name);
    if (missing.length) fail("model_resolution", "optional_positional_hole", `Cannot supply a later positional table-function argument while omitting earlier arguments ${JSON.stringify(missing)}`);
  }
  const args = [...positional, ...named].flatMap(({ mapping, argument }) => {
    if (!(mapping.parameter in (query.parameters ?? {}))) {
      if (mapping.required !== false) fail("required_filter", "missing_source_parameter", `Table function argument '${mapping.argument}' requires semantic parameter '${mapping.parameter}'`);
      return [];
    }
    if (!valueCompatible(query.parameters![mapping.parameter], argument.duckdbType)) fail("type_check", "incompatible_parameter_type", `Parameter '${mapping.parameter}' is incompatible with argument '${argument.name}'`);
    parameters.push(query.parameters![mapping.parameter]);
    return [argument.named ? `${quoteIdent(argument.name)} := ?` : "?"];
  });
  return `${qualified}(${args.join(", ")})`;
}

const qualifiedSource = (entity: SemanticEntity) => `${quoteIdent(entity.attachmentAlias)}.${quoteIdent(entity.schemaName)}.${quoteIdent(entity.sourceName)}`;
const pathAlias = (base: string, path: string[]) => base + path.map(quoteIdent).map((part) => `.${part}`).join("");

function normalizedType(value?: string): string {
  const raw = String(value ?? "").trim().toUpperCase().replace(/\s+/g, " ");
  return ({ STRING: "VARCHAR", TEXT: "VARCHAR", INT: "INTEGER", INT4: "INTEGER", INT8: "BIGINT", FLOAT: "REAL", FLOAT8: "DOUBLE", BOOL: "BOOLEAN" } as Record<string, string>)[raw] ?? raw;
}

function typesCompatible(source?: string, target?: string): boolean {
  const left = normalizedType(source), right = normalizedType(target);
  if (!left || !right || right === "ANY" || left === right) return true;
  const numeric = ["TINYINT", "SMALLINT", "INTEGER", "BIGINT", "HUGEINT", "REAL", "DOUBLE"];
  return numeric.includes(left) && numeric.includes(right) && numeric.indexOf(left) <= numeric.indexOf(right);
}

function valueCompatible(value: unknown, target?: string): boolean {
  if (value == null || !target) return true;
  const type = normalizedType(target);
  if (type === "ANY") return true;
  if (type === "BOOLEAN") return typeof value === "boolean";
  if (/^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT)/.test(type)) return typeof value === "number" && Number.isInteger(value);
  if (/^(REAL|DOUBLE|DECIMAL|NUMERIC)/.test(type)) return typeof value === "number" && Number.isFinite(value);
  if (/^(VARCHAR|CHAR|TEXT|DATE|TIME|TIMESTAMP|UUID)/.test(type)) return typeof value === "string";
  if (type.endsWith("[]")) return Array.isArray(value);
  if (/^(STRUCT|MAP|JSON)/.test(type)) return typeof value === "object" || typeof value === "string";
  return true;
}

function memberType(entity: SemanticEntity, member: SemanticMember): string | undefined {
  if (member.output_type || member.data_type) return member.output_type ?? member.data_type;
  return entity.columns.find((column) => column.name === member.column)?.duckdbType;
}

function validateInputs(query: SemanticQuery): Map<string, SemanticInput> {
  const inputs = new Map<string, SemanticInput>();
  let cells = 0, bytes = 0;
  for (const input of query.inputs ?? []) {
    if (inputs.has(input.input_id)) fail("source_binding", "duplicate_input", `Duplicate input_id '${input.input_id}'`);
    if (input.columns.length > MAX_INLINE_COLUMNS || input.rows.length > MAX_INLINE_ROWS) fail("execution_limit", "inline_input_limit", `Input '${input.input_id}' exceeds inline limits`);
    const names = input.columns.map((column) => column.name);
    if (new Set(names).size !== names.length) fail("source_binding", "duplicate_input_column", `Input '${input.input_id}' has duplicate columns`);
    const missingGrain = input.grain.filter((name) => !names.includes(name));
    if (missingGrain.length) fail("source_binding", "unknown_input_grain", `Input '${input.input_id}' grain references ${JSON.stringify(missingGrain)}`);
    const grainIndexes = input.grain.map((name) => names.indexOf(name));
    const grainValues = new Set<string>();
    input.rows.forEach((row, rowIndex) => {
      if (row.length !== input.columns.length) fail("source_binding", "input_row_width", `Input '${input.input_id}' row ${rowIndex} has the wrong width`);
      row.forEach((value, index) => {
        if (value == null && input.columns[index].nullable !== true) fail("type_check", "null_input_value", `Input '${input.input_id}' column '${names[index]}' is not nullable`);
        if (value != null && !valueCompatible(value, input.columns[index].type)) fail("type_check", "incompatible_input_value", `Input '${input.input_id}' row ${rowIndex} column '${names[index]}' does not match '${input.columns[index].type}'`);
      });
      const keyValues = grainIndexes.map((index) => row[index]);
      if (keyValues.some((value) => value == null)) fail("source_binding", "null_input_grain", `Input '${input.input_id}' grain cannot contain NULL`);
      const key = JSON.stringify(keyValues);
      if (grainValues.has(key)) fail("source_binding", "duplicate_input_grain", `Input '${input.input_id}' grain is not unique`);
      grainValues.add(key);
    });
    cells += input.columns.length * input.rows.length;
    bytes += new TextEncoder().encode(JSON.stringify(input.rows)).byteLength;
    inputs.set(input.input_id, input);
  }
  if (cells > MAX_INLINE_CELLS || bytes > MAX_INLINE_BYTES) fail("execution_limit", "inline_input_payload_limit", "Inline inputs exceed the request payload limit");
  return inputs;
}

type InvocationBinding = { entity: SemanticEntity; driverEntity?: SemanticEntity; inputId?: string; definition: SemanticSourceBinding };

function resolveOrFail(environment: SemanticEnvironment, ref: SemanticRef, bindings: Record<string, string>): SemanticEntity {
  const entity = resolveEntity(environment, ref, bindings);
  if ("stage" in entity) throw new CompileFailure(entity);
  return entity;
}

function resolveInvocationChain(environment: SemanticEnvironment, root: SemanticEntity, query: SemanticQuery, inputs: Map<string, SemanticInput>): InvocationBinding[] {
  const byTarget = new Map<string, InvocationBinding>();
  for (const definition of query.source_bindings ?? []) {
    const entity = resolveOrFail(environment, definition.entity, query.bindings ?? {});
    const marker = entityMarker(entity);
    if (byTarget.has(marker)) fail("source_binding", "duplicate_source_binding", `Entity '${entity.entityId}' has multiple source bindings`);
    if (entity.sourceKind !== "table_function") fail("source_binding", "binding_target_not_function", `Entity '${entity.entityId}' is not a table function`);
    if ("input_id" in definition.driver) {
      if (!inputs.has(definition.driver.input_id)) fail("source_binding", "unknown_input", `Unknown input_id '${definition.driver.input_id}'`);
      byTarget.set(marker, { entity, inputId: definition.driver.input_id, definition });
    } else {
      byTarget.set(marker, { entity, driverEntity: resolveOrFail(environment, definition.driver.entity, query.bindings ?? {}), definition });
    }
  }
  const chain: InvocationBinding[] = [], visiting = new Set<string>(), used = new Set<string>();
  const visit = (entity: SemanticEntity) => {
    const marker = entityMarker(entity), binding = byTarget.get(marker);
    if (!binding) return;
    if (visiting.has(marker)) fail("source_binding", "correlation_cycle", `Correlation cycle includes '${entity.entityId}'`);
    visiting.add(marker);
    if (binding.driverEntity) visit(binding.driverEntity);
    visiting.delete(marker); used.add(marker); chain.push(binding);
  };
  visit(root);
  const unused = [...byTarget.keys()].filter((marker) => !used.has(marker)).sort();
  if (unused.length) fail("source_binding", "unused_source_binding", `Source bindings are not on the root invocation path: ${JSON.stringify(unused)}`);
  const usedInputs = new Set(chain.flatMap((item) => item.inputId ? [item.inputId] : []));
  const unusedInputs = [...inputs.keys()].filter((id) => !usedInputs.has(id)).sort();
  if (unusedInputs.length) fail("source_binding", "unused_input", `Inputs are not used by the root invocation path: ${JSON.stringify(unusedInputs)}`);
  if (usedInputs.size > 1) fail("source_binding", "multiple_driving_inputs", "One invocation path may use only one inline input");
  return chain;
}

function correlatedCallSql(binding: InvocationBinding, query: SemanticQuery, parameters: unknown[], driverAlias: string, driverPaths: Map<string, string[]>, inputColumns: Map<string, SemanticInput["columns"][number]>): { sql: string; plan: Array<Record<string, unknown>> } {
  const entity = binding.entity;
  const mappings = new Map(resolvedSourceArguments(entity).map(({ mapping }) => [mapping.argument, mapping]));
  const argumentsByName = new Map(entity.functionArguments.map((argument) => [argument.name, argument]));
  const unknown = Object.keys(binding.definition.arguments).filter((name) => !argumentsByName.has(name)).sort();
  if (unknown.length) fail("source_binding", "unknown_bound_argument", `Bindings reference unknown arguments ${JSON.stringify(unknown)}`);
  const supplied = query.parameters ?? {};
  const rendered = new Map<string, { sql: string; detail: Record<string, unknown>; value?: unknown }>();
  let correlated = false;
  for (const argument of entity.functionArguments) {
    const override = binding.definition.arguments[argument.name];
    if (override && ("input_column" in override || "member" in override)) {
      correlated = true;
      if (!entity.inputFromArgs) fail("source_binding", "correlated_input_not_supported", `Function '${entity.entityId}' does not advertise input_from_args`);
      if (!argument.positional || argument.position == null || argument.isConst) fail("source_binding", "invalid_correlated_argument", `Argument '${argument.name}' cannot be column-bound`);
      if ("input_column" in override) {
        if (!binding.inputId) fail("source_binding", "input_binding_wrong_driver", `Argument '${argument.name}' requires an inline-input driver`);
        const column = inputColumns.get(override.input_column);
        if (!column) fail("source_binding", "unknown_input_column", `Unknown input column '${override.input_column}'`);
        if (!typesCompatible(column!.type, argument.duckdbType)) fail("type_check", "incompatible_argument_type", `Input column '${override.input_column}' is incompatible with argument '${argument.name}'`);
        rendered.set(argument.name, { sql: `${driverAlias}.${quoteIdent(override.input_column)}`, detail: { argument: argument.name, kind: "input_column", source: override.input_column } });
      } else {
        const driverEntity = binding.driverEntity;
        if (!driverEntity) fail("source_binding", "member_binding_wrong_driver", `Argument '${argument.name}' requires an entity driver`);
        if (refKey(override.member) !== driverEntity!.key) fail("source_binding", "member_not_on_driver", `Argument '${argument.name}' references a member outside its driver`);
        const member = driverEntity!.members.get(override.member.member_id);
        if (!member) fail("source_binding", "unknown_driver_member", `Unknown driver member '${override.member.member_id}'`);
        if (!member!.column) fail("source_binding", "derived_driver_member", `Driver member '${member!.member_id}' must be column-backed`);
        if (!typesCompatible(memberType(driverEntity!, member!), argument.duckdbType)) fail("type_check", "incompatible_argument_type", `Driver member '${member!.member_id}' is incompatible with argument '${argument.name}'`);
        const path = driverPaths.get(entityMarker(driverEntity!));
        if (!path) fail("source_binding", "driver_not_in_path", `Driver '${driverEntity!.entityId}' is not available`);
        rendered.set(argument.name, { sql: memberSql(driverEntity!, member!, pathAlias(driverAlias, path!)), detail: { argument: argument.name, kind: "member", source: override.member } });
      }
      continue;
    }
    const mapping = mappings.get(argument.name);
    const parameter = override && "parameter" in override ? override.parameter : mapping?.parameter;
    if (parameter && parameter in supplied) {
      if (!valueCompatible(supplied[parameter], argument.duckdbType)) fail("type_check", "incompatible_parameter_type", `Parameter '${parameter}' is incompatible with argument '${argument.name}'`);
      rendered.set(argument.name, { sql: "?", value: supplied[parameter], detail: { argument: argument.name, kind: "parameter", source: parameter } });
    }
    else if (argument.defaultValue === undefined && mapping?.required !== false) fail("required_filter", "missing_source_parameter", `Table function argument '${argument.name}' requires semantic parameter '${parameter ?? ""}'`);
  }
  if (!correlated) fail("source_binding", "missing_correlated_argument", `Source binding for '${entity.entityId}' has no column-driven argument`);
  const positions = new Set([...rendered].flatMap(([name]) => { const argument = argumentsByName.get(name)!; return argument.positional && argument.position != null ? [argument.position] : []; }));
  if (positions.size) {
    const highest = Math.max(...positions);
    const holes = entity.functionArguments.filter((argument) => argument.positional && argument.position != null && argument.position < highest && !positions.has(argument.position)).sort((a, b) => a.position! - b.position!).map((argument) => argument.name);
    if (holes.length) fail("source_binding", "optional_positional_hole", `Cannot omit earlier positional arguments ${JSON.stringify(holes)}`);
  }
  const ordered = [...rendered].map(([name, value]) => ({ argument: argumentsByName.get(name)!, ...value })).sort((left, right) => left.argument.positional !== right.argument.positional ? (left.argument.positional ? -1 : 1) : (left.argument.position ?? left.argument.fieldIndex ?? 0) - (right.argument.position ?? right.argument.fieldIndex ?? 0));
  for (const item of ordered) if (item.detail.kind === "parameter") parameters.push(item.value);
  return { sql: `${qualifiedSource(entity)}(${ordered.map((item) => item.argument.positional ? item.sql : `${quoteIdent(item.argument.name)} := ${item.sql}`).join(", ")})`, plan: ordered.map((item) => item.detail) };
}

type InvocationSource = { withSql: string; source: string; rootAlias: string; paths: Map<string, string[]>; entities: Map<string, SemanticEntity>; invocationEntities: SemanticEntity[]; prevalidatedRequiredEntities: Set<string>; drivingGrain: Array<{ source: string; member: string; path: string[]; entity?: SemanticEntity }>; effectiveGrain: Array<{ source: string; member: string; path: string[]; entity?: SemanticEntity }>; invocations: Array<Record<string, unknown>>; estimatedInvocations: number };

function compileInvocationSource(environment: SemanticEnvironment, root: SemanticEntity, query: SemanticQuery, parameters: unknown[]): InvocationSource | null {
  const inputs = validateInputs(query), chain = resolveInvocationChain(environment, root, query, inputs);
  if (!chain.length) {
    if (inputs.size || (query.source_bindings?.length ?? 0)) fail("source_binding", "missing_root_source_binding", "Inputs and source bindings must drive the root entity");
    return null;
  }
  const maxInvocations = Math.min(HARD_MAX_INVOCATIONS, query.execution_limits?.max_invocations ?? DEFAULT_MAX_INVOCATIONS);
  const ctes: string[] = [], invocations: Array<Record<string, unknown>> = [];
  const prevalidatedRequiredEntities = new Set<string>();
  let paths = new Map<string, string[]>(), previousStage: string | undefined, totalInvocations = 0;
  chain.forEach((binding, index) => {
    const driver = binding.definition.driver;
    let driverSource: string, driverPaths: Map<string, string[]>, driverCount: number, driverKind: string, driverLabel: string;
    let inputColumns = new Map<string, SemanticInput["columns"][number]>();
    if (binding.inputId) {
      if (index !== 0) fail("source_binding", "inline_driver_not_leaf", "An inline input may only begin an invocation path");
      const input = inputs.get(binding.inputId)!;
      const inputAlias = `_input${index}`;
      const rowSql = input.rows.map((row) => `(${row.map((value, columnIndex) => { parameters.push(value); return `CAST(? AS ${safeType(input.columns[columnIndex].type)})`; }).join(", ")})`);
      ctes.push(`${quoteIdent(inputAlias)}(${input.columns.map((column) => quoteIdent(column.name)).join(", ")}) AS (VALUES ${rowSql.join(", ")})`);
      driverSource = quoteIdent(inputAlias); driverPaths = new Map([[`input:${binding.inputId}`, []]]); driverCount = input.rows.length; driverKind = "inline_input"; driverLabel = binding.inputId;
      inputColumns = new Map(input.columns.map((column) => [column.name, column]));
    } else {
      const driverEntity = binding.driverEntity!;
      const entityDriver = driver as Extract<SemanticSourceBinding["driver"], { entity: SemanticRef }>;
      driverCount = entityDriver.max_rows;
      let baseSource: string;
      if (!previousStage) {
        if (driverEntity.sourceKind !== "relation") fail("source_binding", "unbound_function_driver", `Function driver '${driverEntity.entityId}' needs its own source binding`);
        baseSource = qualifiedSource(driverEntity); driverPaths = new Map([[entityMarker(driverEntity), []]]);
      } else {
        baseSource = quoteIdent(previousStage); driverPaths = paths;
      }
      const sourceAlias = quoteIdent("_source"), memberAlias = pathAlias(sourceAlias, driverPaths.get(entityMarker(driverEntity))!);
      const driverLookup = new Map<string, { entity: SemanticEntity; member: SemanticMember; alias: string }>();
      for (const [memberId, member] of driverEntity.members) {
        const found = { entity: driverEntity, member, alias: memberAlias };
        driverLookup.set(memberId, found); driverLookup.set(`${driverEntity.key}::${memberId}`, found);
      }
      const filterSql = compileFilter(entityDriver.filters, driverLookup, parameters);
      const filteredIds = new Set(filterMembers(entityDriver.filters).map((ref) => typeof ref === "string" ? ref : ref.member_id));
      for (const group of driverEntity.sourceKind === "relation" ? driverEntity.requiredFilters : []) {
        const satisfied = group.some((column) => [...driverEntity.members].some(([memberId, member]) => filteredIds.has(memberId) && member.column === column));
        if (!satisfied) fail("required_filter", "driver_required_filter_missing", `Driver '${driverEntity.entityId}' requires a pre-invocation filter on one of: ${group.join(", ")}`);
      }
      if (driverEntity.sourceKind === "relation" && driverEntity.requiredFilters.length) prevalidatedRequiredEntities.add(entityMarker(driverEntity));
      const orderSql = (entityDriver.order ?? []).map((item) => {
        const member = driverEntity.members.get(item.member_id);
        if (!member) fail("source_binding", "unknown_driver_order_member", `Unknown driver order member '${item.member_id}'`);
        return `${memberSql(driverEntity, member!, memberAlias)} ${item.direction.toUpperCase()}`;
      });
      driverSource = [`(SELECT * FROM ${baseSource} AS ${sourceAlias}`, filterSql ? `WHERE ${filterSql}` : "", orderSql.length ? `ORDER BY ${orderSql.join(", ")}` : "", `LIMIT ${driverCount})`].filter(Boolean).join(" ");
      driverKind = "entity"; driverLabel = driverEntity.key;
    }
    totalInvocations += driverCount;
    if (totalInvocations > maxInvocations) fail("execution_limit", "invocation_limit", `Invocation path may execute ${totalInvocations} function rows, above limit ${maxInvocations}`);
    const call = correlatedCallSql(binding, query, parameters, quoteIdent("_driver"), driverPaths, inputColumns);
    const stage = `_stage${index}`, stageLimit = Math.min(DEFAULT_MAX_STAGE_ROWS, binding.definition.max_output_rows ?? DEFAULT_MAX_STAGE_ROWS);
    ctes.push(`${quoteIdent(stage)} AS (SELECT "_driver" AS "driver", "_fn" AS "entity" FROM ${driverSource} AS "_driver" CROSS JOIN LATERAL ${call.sql} AS "_fn" LIMIT ${stageLimit})`);
    paths = new Map([...driverPaths].map(([marker, path]) => [marker, ["driver", ...path]])); paths.set(entityMarker(binding.entity), ["entity"]);
    invocations.push({ entity: { catalog_id: binding.entity.catalogId, entity_id: binding.entity.entityId }, driver_kind: driverKind, driver: driverLabel, argument_bindings: call.plan, estimated_invocations: driverCount });
    previousStage = stage;
  });
  const drivingGrain: InvocationSource["drivingGrain"] = [];
  for (const [marker, path] of paths) {
    if (marker === entityMarker(root)) continue;
    if (marker.startsWith("input:")) {
      const inputId = marker.slice(6); for (const member of inputs.get(inputId)!.grain) drivingGrain.push({ source: inputId, member, path });
    } else {
      const entity = chain.flatMap((item) => item.driverEntity ? [item.driverEntity] : []).find((item) => entityMarker(item) === marker);
      if (entity) for (const member of entity.grain) drivingGrain.push({ source: entity.key, member, path, entity });
    }
  }
  const rootPath = paths.get(entityMarker(root))!;
  const effectiveGrain = [...drivingGrain, ...root.grain.map((member) => ({ source: root.key, member, path: rootPath, entity: root }))];
  const entities = new Map<string, SemanticEntity>();
  for (const item of chain) { entities.set(entityMarker(item.entity), item.entity); if (item.driverEntity) entities.set(entityMarker(item.driverEntity), item.driverEntity); }
  return { withSql: `WITH ${ctes.join(", ")}`, source: quoteIdent(previousStage!), rootAlias: pathAlias("_e0", rootPath), paths, entities, invocationEntities: chain.map((item) => item.entity), prevalidatedRequiredEntities, drivingGrain, effectiveGrain, invocations, estimatedInvocations: totalInvocations };
}

function memberSql(entity: SemanticEntity, member: SemanticMember, alias: string, stack: string[] = []): string {
  if (stack.includes(member.member_id)) fail("type_check", "expression_cycle", `Cyclic semantic expression at '${member.member_id}'`);
  const sql = member.column
    ? `${alias}.${quoteIdent(member.column)}`
    : member.expression
      ? expressionSql(entity, member.expression, alias, [...stack, member.member_id])
      : fail("type_check", "missing_member_source", `Member '${member.member_id}' has no column or expression`);
  return member.output_type ? `CAST(${sql} AS ${safeType(member.output_type)})` : sql;
}

function expressionSql(entity: SemanticEntity, expression: SemanticExpression, alias: string, stack: string[]): string {
  if (expression.op === "member") {
    const member = entity.members.get(expression.member);
    if (!member) throw new CompileFailure({ stage: "type_check" as any, code: "unknown_expression_member", message: `Unknown member '${expression.member}'` });
    return memberSql(entity, member, alias, stack);
  }
  if (expression.op === "literal") return literalSql(expression.value);
  if (["add", "subtract", "multiply", "divide", "safe_divide"].includes(expression.op)) {
    const binary = expression as any; const left = expressionSql(entity, binary.left, alias, stack); const right = expressionSql(entity, binary.right, alias, stack);
    if (expression.op === "safe_divide") return `(${left} / NULLIF(${right}, 0))`;
    const operator = { add: "+", subtract: "-", multiply: "*", divide: "/" }[expression.op as "add"];
    return `(${left} ${operator} ${right})`;
  }
  if (expression.op === "coalesce") return `COALESCE(${expression.args.map((arg) => expressionSql(entity, arg, alias, stack)).join(", ")})`;
  if (expression.op === "nullif") return `NULLIF(${expressionSql(entity, expression.value, alias, stack)}, ${expressionSql(entity, expression.other ?? { op: "literal", value: 0 }, alias, stack)})`;
  if (expression.op === "cast") return `CAST(${expressionSql(entity, expression.value, alias, stack)} AS ${safeType(expression.type)})`;
  if (expression.op === "case") return `CASE WHEN ${expressionSql(entity, expression.when, alias, stack)} THEN ${expressionSql(entity, expression.then, alias, stack)}${expression.else ? ` ELSE ${expressionSql(entity, expression.else, alias, stack)}` : ""} END`;
  return fail("sql_generation", "unsupported_expression", "Unsupported semantic expression");
}

function aggregateSql(entity: SemanticEntity, member: SemanticMember, alias: string, stack: string[] = []): string {
  if (stack.includes(member.member_id)) fail("type_check", "measure_cycle", `Cyclic derived measure at '${member.member_id}'`);
  if (member.expression) {
    const sql = measureExpressionSql(entity, member.expression, alias, [...stack, member.member_id]);
    return member.output_type ? `CAST(${sql} AS ${safeType(member.output_type)})` : sql;
  }
  const aggregation = member.aggregation;
  if (!aggregation) throw new CompileFailure({ stage: "type_check" as any, code: "invalid_measure", message: `Measure '${member.member_id}' has no aggregation or expression` });
  if (aggregation === "count_rows") return member.output_type ? `CAST(COUNT(*) AS ${safeType(member.output_type)})` : "COUNT(*)";
  const input = entity.members.get(String(member.member));
  if (!input) throw new CompileFailure({ stage: "type_check" as any, code: "unknown_measure_input", message: `Measure '${member.member_id}' has unknown input '${member.member}'` });
  const sql = memberSql(entity, input, alias);
  const fn = aggregation === "count_distinct" ? "COUNT(DISTINCT" : aggregation.toUpperCase() + "(";
  const aggregate = aggregation === "count_distinct" ? `${fn} ${sql})` : `${fn}${sql})`;
  return member.output_type ? `CAST(${aggregate} AS ${safeType(member.output_type)})` : aggregate;
}

function measureExpressionSql(entity: SemanticEntity, expression: SemanticExpression, alias: string, stack: string[]): string {
  if (expression.op === "member") {
    const member = entity.members.get(expression.member);
    if (!member) throw new CompileFailure({ stage: "type_check" as any, code: "unknown_expression_member", message: `Unknown member '${expression.member}'` });
    return member.kind === "measure" ? aggregateSql(entity, member, alias, stack) : memberSql(entity, member, alias, stack);
  }
  if (expression.op === "literal") return literalSql(expression.value);
  if (["add", "subtract", "multiply", "divide", "safe_divide"].includes(expression.op)) {
    const binary = expression as any;
    const left = measureExpressionSql(entity, binary.left, alias, stack);
    const right = measureExpressionSql(entity, binary.right, alias, stack);
    if (expression.op === "safe_divide") return `(${left} / NULLIF(${right}, 0))`;
    const operator = { add: "+", subtract: "-", multiply: "*", divide: "/" }[expression.op as "add"];
    return `(${left} ${operator} ${right})`;
  }
  if (expression.op === "coalesce") return `COALESCE(${expression.args.map((arg) => measureExpressionSql(entity, arg, alias, stack)).join(", ")})`;
  if (expression.op === "nullif") return `NULLIF(${measureExpressionSql(entity, expression.value, alias, stack)}, ${measureExpressionSql(entity, expression.other ?? { op: "literal", value: 0 }, alias, stack)})`;
  if (expression.op === "cast") return `CAST(${measureExpressionSql(entity, expression.value, alias, stack)} AS ${safeType(expression.type)})`;
  if (expression.op === "case") return `CASE WHEN ${measureExpressionSql(entity, expression.when, alias, stack)} THEN ${measureExpressionSql(entity, expression.then, alias, stack)}${expression.else ? ` ELSE ${measureExpressionSql(entity, expression.else, alias, stack)}` : ""} END`;
  return fail("sql_generation", "unsupported_expression", "Unsupported derived-measure expression");
}

function findPath(environment: SemanticEnvironment, root: SemanticEntity, target: SemanticEntity, requested?: string[], bindings: Record<string, string> = {}): Array<{ relationship: SemanticRelationship; from: SemanticEntity; to: SemanticEntity; forward: boolean }> {
  if (root.key === target.key && root.attachmentAlias === target.attachmentAlias) return [];
  const chosen = requested?.length ? environment.relationships.filter((relationship) => requested.includes(relationship.relationshipId)) : environment.relationships;
  type State = { entity: SemanticEntity; path: ReturnType<typeof findPath> };
  const queue: State[] = [{ entity: root, path: [] }]; const found: State[] = []; const seen = new Set<string>();
  while (queue.length) {
    const state = queue.shift()!; const marker = `${state.entity.attachmentAlias}:${state.entity.key}:${state.path.length}`;
    if (seen.has(marker)) continue; seen.add(marker);
    if (state.entity.key === target.key && state.entity.attachmentAlias === target.attachmentAlias) { found.push(state); continue; }
    if (state.path.length >= 8) continue;
    for (const relationship of chosen) {
      if (!["resolved", "ambiguous"].includes(relationship.resolutionStatus) || state.path.some((edge) => edge.relationship.relationshipId === relationship.relationshipId)) continue;
      const forward = refKey(relationship.from) === state.entity.key;
      const backward = refKey(relationship.to) === state.entity.key;
      if (!forward && !backward) continue;
      const nextRef = forward ? relationship.to : relationship.from;
      const resolved = resolveEntity(environment, nextRef, bindings, relationship.hostAliases.includes(state.entity.attachmentAlias) ? state.entity.attachmentAlias : undefined);
      if ("stage" in resolved) continue;
      queue.push({ entity: resolved, path: [...state.path, { relationship, from: state.entity, to: resolved, forward }] });
    }
  }
  const exact = requested?.length ? found.filter((candidate) => candidate.path.map((edge) => edge.relationship.relationshipId).join("/") === requested.join("/")) : found;
  if (exact.length !== 1) fail("relationship_resolution", exact.length ? "ambiguous_relationship_path" : "relationship_path_not_found", exact.length ? `Multiple relationship paths reach '${target.entityId}'; specify relationship_path` : `No relationship path reaches '${target.entityId}'`);
  return exact[0].path;
}

const filterMemberKey = (member: SemanticFilterMember) => typeof member === "string"
  ? member
  : `${refKey(member)}::${member.member_id}`;

function compileFilter(filter: SemanticFilter | undefined, members: Map<string, { entity: SemanticEntity; member: SemanticMember; alias: string }>, parameters: unknown[]): string | null {
  if (!filter) return null;
  if ("and" in filter) { const parts = filter.and.map((part: SemanticFilter) => compileFilter(part, members, parameters)).filter(Boolean); return `(${parts.join(" AND ")})`; }
  if ("or" in filter) { const parts = filter.or.map((part: SemanticFilter) => compileFilter(part, members, parameters)).filter(Boolean); return `(${parts.join(" OR ")})`; }
  const found = members.get(filterMemberKey(filter.member)); if (!found) throw new CompileFailure({ stage: "type_check" as any, code: "unknown_filter_member", message: `Unknown or ambiguous filter member '${typeof filter.member === "string" ? filter.member : filter.member.member_id}'` });
  const lhs = found.member.kind === "measure" ? aggregateSql(found.entity, found.member, found.alias) : memberSql(found.entity, found.member, found.alias);
  if (filter.operator === "is_null") return `${lhs} IS NULL`; if (filter.operator === "is_not_null") return `${lhs} IS NOT NULL`;
  const values = filter.values ?? (filter.operator === "between" && Array.isArray(filter.value) ? filter.value : [filter.value]);
  if (["in", "not_in"].includes(filter.operator) && values.length === 0) fail("request_validation", "empty_filter_values", `${filter.operator} requires at least one value`);
  if (filter.operator === "between" && values.length !== 2) fail("request_validation", "invalid_between", "between requires exactly two values");
  for (const value of values) parameters.push(value);
  if (["in", "not_in"].includes(filter.operator)) return `${lhs} ${filter.operator === "in" ? "IN" : "NOT IN"} (${values.map(() => "?").join(", ")})`;
  if (filter.operator === "between") return `${lhs} BETWEEN ? AND ?`;
  const op = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" }[filter.operator]; if (!op) fail("request_validation", "invalid_filter_operator", `Unknown filter operator '${filter.operator}'`);
  return `${lhs} ${op} ?`;
}

function filterMembers(filter: SemanticFilter | undefined, depth = 0): SemanticFilterMember[] {
  if (!filter) return [];
  if (depth >= 8) fail("request_validation", "filter_depth", "Filter nesting may not exceed 8 levels");
  if ("and" in filter) return filter.and.flatMap((part) => filterMembers(part, depth + 1));
  if ("or" in filter) return filter.or.flatMap((part) => filterMembers(part, depth + 1));
  return [filter.member];
}

export function compileSemanticQuery(catalogs: readonly CatalogData[], query: SemanticQuery): SemanticCompileResult {
  try {
    const requestErrors = validateSemanticValue("query", query);
    if (requestErrors.length) return { ok: false, diagnostics: requestErrors.map((message) => ({ stage: "request_validation", code: "query_schema", message })) };
    const environment = buildSemanticEnvironment(catalogs);
    const blockingModelDiagnostics = environment.diagnostics.filter((diagnostic) => diagnostic.code !== "duplicate_relationship_candidate");
    if (blockingModelDiagnostics.length) return { ok: false, diagnostics: blockingModelDiagnostics };
    const measures = query.measures ?? []; const dimensions = query.dimensions ?? [];
    if (!measures.length && !dimensions.length) fail("request_validation", "empty_selection", "Select at least one measure or dimension");
    if (measures.length > 50 || dimensions.length > 50) fail("request_validation", "selection_limit", "At most 50 measures and 50 dimensions may be selected");
    const allFilterMembers = [...filterMembers(query.filters), ...filterMembers(query.measure_filters)];
    if (allFilterMembers.length > 100) fail("request_validation", "filter_node_limit", "At most 100 filter predicates are allowed");
    const roots = measures.map((selection) => refKey(selection));
    if (new Set(roots).size > 1) fail("multi_fact_not_supported", "multi_fact_not_supported", "Measures from multiple root entities are not supported yet");
    const rootRef = measures[0] ?? query.root_entity;
    if (!rootRef) fail("request_validation", "root_entity_required", "Dimension-only queries require root_entity");
    const resolvedRoot = resolveEntity(environment, rootRef, query.bindings ?? {}); if ("stage" in resolvedRoot) throw new CompileFailure(resolvedRoot);
    const root = resolvedRoot; const parameters: unknown[] = [];
    const invocation = compileInvocationSource(environment, root, query, parameters);
    const aliasByEntity = invocation
      ? new Map([...invocation.paths].flatMap(([marker, path]) => marker.startsWith("input:") ? [] : [[marker, pathAlias("_e0", path)]]))
      : new Map<string, string>([[entityMarker(root), "_e0"]]);
    const joins: Array<{ edge: ReturnType<typeof findPath>[number]; alias: string }> = []; const selected = [...dimensions, ...measures];
    const addEntityPath = (entity: SemanticEntity, relationshipPath?: string[]) => {
      if (aliasByEntity.has(entityMarker(entity))) return;
      const path = findPath(environment, root, entity, relationshipPath, query.bindings ?? {});
      for (const edge of path) {
        const max = edge.forward ? edge.relationship.toCardinality.max : edge.relationship.fromCardinality.max;
        if (max === "many") fail("fanout", "fanout_unsafe", `Relationship '${edge.relationship.relationshipId}' traverses into a many side`);
        if (edge.to.sourceKind === "table_function" && edge.to.sourceArguments.length) fail("relationship_resolution", "parameterized_joined_function", `Joined table function '${edge.to.entityId}' must be zero-argument`);
        const marker = entityMarker(edge.to);
        if (!aliasByEntity.has(marker)) { const alias = `_e${aliasByEntity.size}`; aliasByEntity.set(marker, alias); joins.push({ edge, alias }); }
      }
    };
    const resolvedSelections = selected.map((selection) => {
      const entity = resolveEntity(environment, selection, query.bindings ?? {}); if ("stage" in entity) throw new CompileFailure(entity);
      addEntityPath(entity, selection.relationship_path);
      const member = entity.members.get(selection.member_id); if (!member) throw new CompileFailure({ stage: "model_resolution", code: "unknown_member", message: `Unknown member '${selection.member_id}' on '${entity.entityId}'` });
      return { selection, entity, member, alias: aliasByEntity.get(entityMarker(entity))! };
    });
    for (const memberRef of [...filterMembers(query.filters), ...filterMembers(query.measure_filters)]) {
      if (typeof memberRef === "string") continue;
      const entity = resolveEntity(environment, memberRef, query.bindings ?? {}); if ("stage" in entity) throw new CompileFailure(entity);
      addEntityPath(entity, memberRef.relationship_path);
    }
    const dimensionSelections = resolvedSelections.slice(0, dimensions.length); const measureSelections = resolvedSelections.slice(dimensions.length);
    const memberLookup = new Map<string, { entity: SemanticEntity; member: SemanticMember; alias: string }>();
    const ambiguousMembers = new Set<string>();
    const participatingEntities = [...new Map([root, ...(invocation ? [...invocation.entities.values()] : []), ...joins.map((join) => join.edge.to)].map((entity) => [entityMarker(entity), entity])).values()];
    for (const entity of participatingEntities) for (const [id, member] of entity.members) {
      const resolved = { entity, member, alias: aliasByEntity.get(entityMarker(entity))! };
      memberLookup.set(`${entity.key}::${id}`, resolved);
      if (memberLookup.has(id) || ambiguousMembers.has(id)) { memberLookup.delete(id); ambiguousMembers.add(id); }
      else memberLookup.set(id, resolved);
    }
    const selects: string[] = []; const groups: string[] = []; const outputNames = new Set<string>(); const resultGrain: string[] = []; const drivingPlanGrain: Array<{ source: string; member: string; output_name: string }> = [];
    if (invocation && !query.allow_driving_grain_reduction) {
      const selectedRefs = new Set(dimensions.map((item) => `${refKey(item)}::${item.member_id}`));
      for (const grain of invocation.drivingGrain) {
        let sql: string;
        if (grain.entity) {
          if (selectedRefs.has(`${grain.entity.key}::${grain.member}`)) continue;
          const member = grain.entity.members.get(grain.member);
          if (!member) fail("source_binding", "unknown_driver_grain", `Driver grain member '${grain.member}' does not exist`);
          sql = memberSql(grain.entity, member!, pathAlias("_e0", grain.path));
        } else sql = `${pathAlias("_e0", grain.path)}.${quoteIdent(grain.member)}`;
        let name = grain.member;
        if (outputNames.has(name) || dimensions.some((item) => (item.alias ?? item.member_id) === name)) name = `${grain.source.split("::").at(-1)}__${grain.member}`;
        if (outputNames.has(name)) fail("source_binding", "driving_grain_name_collision", `Driving grain output '${name}' is ambiguous`);
        outputNames.add(name); selects.push(`${sql} AS ${quoteIdent(name)}`); groups.push(sql); resultGrain.push(name); drivingPlanGrain.push({ source: grain.source, member: grain.member, output_name: name });
      }
    }
    for (const item of dimensionSelections) { if (item.member.kind === "measure") fail("type_check", "not_a_dimension", `'${item.member.member_id}' is a measure, not a dimension`); let sql = memberSql(item.entity, item.member, item.alias); if (item.selection.granularity) { if (item.member.kind !== "time_dimension" || !item.member.granularities?.includes(item.selection.granularity)) fail("type_check", "invalid_time_granularity", `Granularity '${item.selection.granularity}' is not allowed for '${item.member.member_id}'`); sql = `date_trunc(${quoteLiteral(item.selection.granularity)}, ${sql} AT TIME ZONE ${quoteLiteral(item.member.timezone ?? "UTC")})`; } const name = item.selection.alias ?? item.member.member_id; if (outputNames.has(name)) fail("request_validation", "duplicate_output", `Duplicate output name '${name}'`); outputNames.add(name); selects.push(`${sql} AS ${quoteIdent(name)}`); groups.push(sql); resultGrain.push(name); }
    const selectedDimensionIds = new Set(dimensionSelections.map((item) => item.member.member_id));
    for (const item of measureSelections) { if (item.member.kind !== "measure") fail("type_check", "not_a_measure", `'${item.member.member_id}' is not a measure`); if (typeof item.member.additivity === "object") { const prohibited = item.member.additivity.prohibited_dimensions.filter((id) => selectedDimensionIds.has(id)); if (prohibited.length) fail("type_check", "semi_additive_dimension", `Measure '${item.member.member_id}' cannot be grouped by ${prohibited.join(", ")}`); } const name = item.selection.alias ?? item.member.member_id; if (outputNames.has(name)) fail("request_validation", "duplicate_output", `Duplicate output name '${name}'`); outputNames.add(name); selects.push(`${aggregateSql(item.entity, item.member, item.alias)} AS ${quoteIdent(name)}`); }
    const from = `FROM ${invocation?.source ?? sourceSql(root, query, parameters)} AS _e0`;
    const joinSql = joins.map(({ edge, alias }) => { const leftAlias = aliasByEntity.get(entityMarker(edge.from))!; const pairs = edge.relationship.predicate.map((pair) => { const leftId = edge.forward ? pair.from_member : pair.to_member; const rightId = edge.forward ? pair.to_member : pair.from_member; const left = edge.from.members.get(leftId); const right = edge.to.members.get(rightId); if (!left || !right) throw new CompileFailure({ stage: "relationship_resolution", code: "unresolved_relationship_member", message: `Relationship '${edge.relationship.relationshipId}' references an unknown member` }); return `${memberSql(edge.from, left, leftAlias)} ${pair.nulls === "equal" ? "IS NOT DISTINCT FROM" : "="} ${memberSql(edge.to, right, alias)}`; }); const cardinality = edge.forward ? edge.relationship.toCardinality : edge.relationship.fromCardinality; return `${cardinality.min === 1 ? "INNER" : "LEFT"} JOIN ${sourceSql(edge.to, query, parameters)} AS ${alias} ON ${pairs.join(" AND ")}`; }).join("\n");
    const where = compileFilter(query.filters, memberLookup, parameters); const having = compileFilter(query.measure_filters, memberLookup, parameters);
    const whereMembers = filterMembers(query.filters).map((member) => memberLookup.get(filterMemberKey(member))).filter(Boolean);
    const requiredEntities = [...new Map([root, ...(invocation?.invocationEntities ?? []), ...joins.map((join) => join.edge.to)].map((entity) => [entityMarker(entity), entity])).values()];
    for (const entity of requiredEntities) {
      if (invocation?.prevalidatedRequiredEntities.has(entityMarker(entity))) continue;
      for (const group of entity.requiredFilters) {
        const filteredLocally = group.some((column) => [...entity.members.values()].some((member) =>
          member.column === column
          && whereMembers.some((filtered) => filtered?.member === member && filtered.entity === entity)));
        const suppliedAsSourceArgument = group.some((column) => entity.sourceArguments.some((mapping) =>
          mapping.argument === column && mapping.parameter in (query.parameters ?? {})));
        const suppliedAsCorrelatedArgument = group.some((column) => (query.source_bindings ?? []).some((binding) => {
          if (refKey(binding.entity) !== entity.key) return false;
          const bound = binding.arguments[column];
          return Boolean(bound && (("input_column" in bound) || ("member" in bound) || ("parameter" in bound && bound.parameter in (query.parameters ?? {}))));
        }));
        if (!filteredLocally && !suppliedAsSourceArgument && !suppliedAsCorrelatedArgument) {
          fail("required_filter", "required_filter_missing", `Entity '${entity.entityId}' requires a source-local filter on one of: ${group.join(", ")}`);
        }
      }
    }
    const order = (query.order ?? []).map((item) => { if (!outputNames.has(item.member)) fail("request_validation", "invalid_order_member", `ORDER BY '${item.member}' is not a selected output`); return `${quoteIdent(item.member)} ${item.direction.toUpperCase()}`; });
    const limit = Math.min(10000, Math.max(1, Math.floor(query.limit ?? 1000)));
    const sql = [invocation?.withSql ?? "", `SELECT ${selects.join(", ")}`, from, joinSql, where ? `WHERE ${where}` : "", groups.length ? `GROUP BY ${groups.join(", ")}` : "", having ? `HAVING ${having}` : "", order.length ? `ORDER BY ${order.join(", ")}` : "", `LIMIT ${limit}`].filter(Boolean).join("\n");
    const effective = invocation?.effectiveGrain ?? root.grain.map((member) => ({ source: root.key, member }));
    const effectivePlan = effective.map((grain) => ({ source: grain.source, member: grain.member, output_name: drivingPlanGrain.find((item) => item.source === grain.source && item.member === grain.member)?.output_name ?? grain.member }));
    const invocationEntities = invocation ? [...invocation.paths.keys()].filter((marker) => !marker.startsWith("input:")) : [];
    return { ok: true, plan: { fact_branches: [{ root: { catalog_id: root.catalogId, entity_id: root.entityId }, attachment_alias: root.attachmentAlias, entities: [...new Set([...invocationEntities, ...aliasByEntity.keys()])], ...(invocation ? { driver: { kind: invocation.invocations[0].driver_kind, source: invocation.invocations[0].driver } } : {}), invocations: invocation?.invocations ?? [], effective_source_grain: effectivePlan, result_grain: resultGrain, estimated_invocations: invocation?.estimatedInvocations ?? 0, driving_grain_reduced: Boolean(invocation && query.allow_driving_grain_reduction) }], sql, parameters, validation_scope: "semantic", warnings: environment.diagnostics.filter((item) => item.code === "duplicate_relationship_candidate").map((item) => item.message) } };
  } catch (error) { if (error instanceof CompileFailure) return { ok: false, diagnostics: [error.diagnostic] }; return { ok: false, diagnostics: [{ stage: "sql_generation", code: "internal_compiler_error", message: error instanceof Error ? error.message : String(error) } as any] }; }
}

export { buildSemanticEnvironment };
