import type { CatalogData, ColumnInfo, FunctionArg } from "./service";
import { getColumns, getFunctionArgs } from "./service";
import {
  getTag,
  parseJsonTag,
  parseRequiredFilters,
  TAG_SEMANTIC_CATALOG,
  TAG_SEMANTIC_ENTITY,
  TAG_SEMANTIC_MEMBER,
  TAG_SEMANTIC_MEMBERS,
  TAG_SEMANTIC_RELATIONSHIPS,
} from "./tags";
import {
  validateSemanticValue,
  type SemanticSchemaName,
} from "./semantic-validation";

export type SemanticMemberKind =
  | "identifier"
  | "dimension"
  | "time_dimension"
  | "measure";
export type SemanticRef = { catalog_id: string; entity_id: string };
export type ResolutionStatus =
  | "resolved"
  | "unresolved"
  | "ambiguous"
  | "conflicted"
  | "unavailable";
export type Attestation = "unilateral" | "corroborated" | "third_party";

export interface SemanticDiagnostic {
  stage:
    | "request_validation"
    | "model_resolution"
    | "multi_fact_not_supported"
    | "catalog_binding"
    | "relationship_resolution"
    | "source_binding"
    | "unit_resolution"
    | "execution_limit"
    | "type_check"
    | "fanout"
    | "required_filter"
    | "sql_generation"
    | "duckdb_execution";
  code: string;
  message: string;
  path?: string;
  details?: Record<string, unknown>;
}

export interface SemanticCatalogIdentity {
  catalog_id: string;
  catalog_instance_id?: string;
  binding_key?: string;
  title?: string;
  description?: string;
  default_timezone?: string;
}

export type SemanticMemberFilter =
  | { and: SemanticMemberFilter[] }
  | { or: SemanticMemberFilter[] }
  | {
      member: string;
      operator: string;
      value?: unknown;
      values?: unknown[];
    };

export interface SemanticMember {
  member_id: string;
  kind: SemanticMemberKind;
  title?: string;
  description?: string;
  column?: string;
  column_path?: string[];
  source_argument?: string;
  expression?: SemanticExpression;
  data_type?: string;
  output_type?: string;
  conformance_id?: string;
  aggregation?:
    | "count_rows"
    | "count"
    | "count_distinct"
    | "sum"
    | "min"
    | "max"
    | "avg";
  member?: string;
  additivity?:
    | "additive"
    | "non_additive"
    | { kind: "semi_additive"; prohibited_dimensions: string[] };
  timezone?: string;
  granularities?: string[];
  week_start?: "monday";
  hidden?: boolean;
  unit?: string;
  unit_parameter?: { argument: string; values: Record<string, string> };
  filter?: SemanticMemberFilter;
}

export type SemanticExpression =
  | { op: "member"; member: string }
  | { op: "literal"; value: string | number | boolean | null }
  | {
      op: "add" | "subtract" | "multiply" | "divide" | "safe_divide";
      left: SemanticExpression;
      right: SemanticExpression;
    }
  | { op: "coalesce"; args: SemanticExpression[] }
  | { op: "nullif"; value: SemanticExpression; other?: SemanticExpression }
  | { op: "cast"; value: SemanticExpression; type: string }
  | {
      op: "case";
      when: SemanticExpression;
      then: SemanticExpression;
      else?: SemanticExpression;
    };

export interface SemanticEntity {
  key: string;
  catalogId: string;
  catalogInstanceId?: string;
  bindingKey: string;
  attachmentAlias: string;
  entityId: string;
  schemaName: string;
  sourceName: string;
  sourceKind: "relation" | "table_function";
  sourceArguments: Array<{
    argument: string;
    parameter: string;
    required?: boolean;
  }>;
  functionArguments: FunctionArg[];
  functionParameters: string[];
  functionOverloadCount: number;
  inputFromArgs: boolean | null;
  grain: string[];
  defaultTimeDimension?: string;
  members: Map<string, SemanticMember>;
  columns: ColumnInfo[];
  requiredFilters: string[][];
}

export interface SemanticRelationship {
  relationshipId: string;
  from: SemanticRef;
  to: SemanticRef;
  fromCardinality: { min: 0 | 1; max: 1 | "many"; roles?: string[] };
  toCardinality: { min: 0 | 1; max: 1 | "many"; roles?: string[] };
  predicate: Array<{
    from_member: string;
    to_member: string;
    operator?:
      | "equal"
      | "spatial_contains"
      | "spatial_within"
      | "spatial_intersects"
      | "list_contains";
    nulls?: "not_equal" | "equal";
    from_element_path?: string[];
    to_element_path?: string[];
  }>;
  conditions: Array<{
    side: "from" | "to";
    member: string;
    operator?: "equal";
    value: string | number | boolean | null;
  }>;
  hostAliases: string[];
  resolutionStatus: ResolutionStatus;
  attestation: Attestation;
}

export interface SemanticEnvironment {
  catalogs: Array<{
    attachmentAlias: string;
    identity: SemanticCatalogIdentity;
  }>;
  entities: SemanticEntity[];
  relationships: SemanticRelationship[];
  diagnostics: SemanticDiagnostic[];
}

const entityKey = (catalogId: string, entityId: string) =>
  `${catalogId}::${entityId}`;

function canonicalRelationship(value: Record<string, any>): string {
  const cardinality = (raw: any) =>
    raw && typeof raw === "object"
      ? {
          ...raw,
          ...(Array.isArray(raw.roles) ? { roles: [...raw.roles].sort() } : {}),
        }
      : raw;
  const predicate = asArray(value.predicate)
    .map((pair) => ({
      from_member: pair.from_member,
      to_member: pair.to_member,
      operator: pair.operator ?? "equal",
      nulls: pair.nulls ?? "not_equal",
      ...(pair.from_element_path
        ? { from_element_path: pair.from_element_path }
        : {}),
      ...(pair.to_element_path
        ? { to_element_path: pair.to_element_path }
        : {}),
    }))
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  const clean = {
    from: value.from,
    to: value.to,
    from_cardinality: cardinality(value.from_cardinality),
    to_cardinality: cardinality(value.to_cardinality),
    predicate,
    conditions: asArray(value.conditions)
      .map((condition) => ({
        side: condition.side,
        member: condition.member,
        operator: condition.operator ?? "equal",
        value: condition.value,
      }))
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      ),
  };
  const reversed = {
    from: clean.to,
    to: clean.from,
    from_cardinality: clean.to_cardinality,
    to_cardinality: clean.from_cardinality,
    predicate: clean.predicate
      .map((pair) => ({
        from_member: pair.to_member,
        to_member: pair.from_member,
        operator:
          pair.operator === "spatial_contains"
            ? "spatial_within"
            : pair.operator === "spatial_within"
              ? "spatial_contains"
              : pair.operator,
        nulls: pair.nulls,
        ...(pair.from_element_path
          ? { to_element_path: pair.from_element_path }
          : {}),
        ...(pair.to_element_path
          ? { from_element_path: pair.to_element_path }
          : {}),
      }))
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      ),
    conditions: clean.conditions
      .map((condition) => ({
        ...condition,
        side: condition.side === "from" ? "to" : "from",
      }))
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      ),
  };
  const directJson = JSON.stringify(clean);
  const reversedJson = JSON.stringify(reversed);
  return directJson < reversedJson ? directJson : reversedJson;
}

function asObject(value: unknown): Record<string, any> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : null;
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function splitStructFields(value: string): string[] {
  const fields: string[] = [];
  let start = 0,
    depth = 0,
    quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '"') {
      if (quoted && value[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted) {
      if ("(<[".includes(char)) depth += 1;
      else if (")>]".includes(char)) depth -= 1;
      else if (char === "," && depth === 0) {
        fields.push(value.slice(start, index).trim());
        start = index + 1;
      }
    }
  }
  fields.push(value.slice(start).trim());
  return fields;
}

function structFields(dataType: string): Map<string, string> | null {
  const value = dataType.trim();
  if (!value.toUpperCase().startsWith("STRUCT(") || !value.endsWith(")"))
    return null;
  const result = new Map<string, string>();
  for (const field of splitStructFields(value.slice(7, -1))) {
    const match = field.match(/^(?:"((?:[^"]|"")+)"|([^\s]+))\s+(.+)$/);
    if (!match) return null;
    result.set((match[1] ?? match[2]).replace(/""/g, '"'), match[3]);
  }
  return result;
}

export function resolveNestedType(
  dataType: string,
  path: string[],
): string | null {
  let current = dataType;
  for (const segment of path) {
    const fields = structFields(current);
    if (!fields?.has(segment)) return null;
    current = fields.get(segment)!;
  }
  return current;
}

function semanticMemberType(
  entity: SemanticEntity,
  member: SemanticMember,
): string | undefined {
  if (member.output_type || member.data_type)
    return member.output_type ?? member.data_type;
  const path = member.column_path ?? (member.column ? [member.column] : []);
  const physical = entity.columns.find(
    (column) => column.name === path[0],
  )?.duckdbType;
  if (!physical || path.length < 2) return physical;
  return resolveNestedType(physical, path.slice(1)) ?? undefined;
}

function modelFilterLeaves(filter: SemanticMember["filter"]): Array<{
  member: string;
  operator: string;
  value?: unknown;
  values?: unknown[];
}> {
  if (!filter) return [];
  if ("and" in filter)
    return filter.and.flatMap((child) => modelFilterLeaves(child));
  if ("or" in filter)
    return filter.or.flatMap((child) => modelFilterLeaves(child));
  return [filter];
}

function valueCompatible(value: unknown, target?: string): boolean {
  if (value == null || !target) return true;
  const normalized = normalizedType(target);
  if (normalized === "BOOLEAN") return typeof value === "boolean";
  if (/^(?:U?(?:TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT))/.test(normalized))
    return typeof value === "number" && Number.isInteger(value);
  if (/^(?:REAL|FLOAT|DOUBLE|DECIMAL|NUMERIC)/.test(normalized))
    return typeof value === "number";
  if (/^(?:VARCHAR|CHAR|TEXT|DATE|TIME|TIMESTAMP|UUID)/.test(normalized))
    return typeof value === "string";
  return true;
}

function listElementType(dataType: string, path: string[]): string | null {
  const value = dataType.trim();
  const element = value.endsWith("[]")
    ? value.slice(0, -2).trim()
    : value.toUpperCase().startsWith("LIST(") && value.endsWith(")")
      ? value.slice(5, -1).trim()
      : null;
  if (!element) return null;
  return path.length ? resolveNestedType(element, path) : element;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function validatedTag(
  tags: Record<string, string> | null | undefined,
  key: string,
  schema: SemanticSchemaName,
  path: string,
  diagnostics: SemanticDiagnostic[],
): unknown {
  const raw = getTag(tags, key);
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    diagnostics.push({
      stage: "model_resolution",
      code: "invalid_semantic_json",
      message: `${key} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      path,
    });
    return null;
  }
  const errors = validateSemanticValue(schema, value);
  for (const message of errors)
    diagnostics.push({
      stage: "model_resolution",
      code: "semantic_schema",
      message: `${key} ${message}`,
      path,
    });
  return errors.length ? null : value;
}

function addMembers(
  target: Map<string, SemanticMember>,
  raw: unknown,
  source: string,
  diagnostics: SemanticDiagnostic[],
) {
  const values: unknown[] = [];
  const templateIds = new Set<string>();
  for (const value of asArray(raw)) {
    const candidate = asObject(value);
    if (!candidate || !("template_id" in candidate)) {
      values.push(value);
      continue;
    }
    const templateId = String(candidate.template_id ?? "");
    if (templateIds.has(templateId))
      diagnostics.push({
        stage: "model_resolution",
        code: "duplicate_member_template",
        message: `Member template '${templateId}' is declared more than once`,
        path: source,
      });
    templateIds.add(templateId);
    const defaults = asObject(candidate.template);
    if (!defaults) continue;
    for (const override of asArray(candidate.members)) {
      const patch = asObject(override);
      if (!patch) continue;
      const expanded = { ...defaults, ...patch };
      const errors = validateSemanticValue("member", expanded);
      if (errors.length) {
        diagnostics.push({
          stage: "model_resolution",
          code: "invalid_expanded_member",
          message: `Member template '${templateId}' entry is invalid: ${errors.join("; ")}`,
          path: source,
        });
      } else values.push(expanded);
    }
  }
  if (values.length > 500) {
    diagnostics.push({
      stage: "model_resolution",
      code: "member_template_expansion_limit",
      message: `Packed semantic members expand to ${values.length} entries; the limit is 500`,
      path: source,
    });
    values.length = 500;
  }
  for (const value of values) {
    const member = asObject(value) as SemanticMember | null;
    if (
      !member ||
      typeof member.member_id !== "string" ||
      typeof member.kind !== "string"
    )
      continue;
    const previous = target.get(member.member_id);
    if (previous && canonicalJson(previous) !== canonicalJson(member)) {
      diagnostics.push({
        stage: "model_resolution",
        code: "member_carrier_conflict",
        message: `Member '${member.member_id}' differs between semantic carriers`,
        path: source,
      });
    } else if (!previous) target.set(member.member_id, member);
  }
}

function normalizedType(value: string | undefined): string {
  const raw = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
  return (
    {
      STRING: "VARCHAR",
      TEXT: "VARCHAR",
      INT: "INTEGER",
      INT4: "INTEGER",
      INT8: "BIGINT",
      FLOAT: "REAL",
      FLOAT8: "DOUBLE",
      BOOL: "BOOLEAN",
    }[raw] ?? raw
  );
}

function typesCompatible(leftValue?: string, rightValue?: string): boolean {
  const left = normalizedType(leftValue);
  const right = normalizedType(rightValue);
  if (!left || !right || left === "ANY" || right === "ANY" || left === right)
    return true;
  const numeric = [
    "TINYINT",
    "SMALLINT",
    "INTEGER",
    "BIGINT",
    "HUGEINT",
    "REAL",
    "DOUBLE",
  ];
  return numeric.includes(left) && numeric.includes(right);
}

export function buildSemanticEnvironment(
  catalogs: readonly CatalogData[],
): SemanticEnvironment {
  const diagnostics: SemanticDiagnostic[] = [];
  const identities = catalogs.flatMap((catalog) => {
    const parsed = asObject(
      validatedTag(
        catalog.catalogTags,
        TAG_SEMANTIC_CATALOG,
        "catalog",
        catalog.catalogName,
        diagnostics,
      ),
    );
    if (!parsed || typeof parsed.catalog_id !== "string") return [];
    return [
      {
        attachmentAlias: catalog.catalogName,
        identity: parsed as SemanticCatalogIdentity,
      },
    ];
  });
  const entities: SemanticEntity[] = [];
  const declarations: Array<{
    value: Record<string, any>;
    hostAlias: string;
    ownerCatalogId: string;
  }> = [];

  for (const catalog of catalogs) {
    const identity = identities.find(
      (item) => item.attachmentAlias === catalog.catalogName,
    )?.identity;
    const catalogRelationships = asArray(
      validatedTag(
        catalog.catalogTags,
        TAG_SEMANTIC_RELATIONSHIPS,
        "relationships",
        catalog.catalogName,
        diagnostics,
      ),
    );
    if (identity)
      for (const value of catalogRelationships)
        if (asObject(value))
          declarations.push({
            value,
            hostAlias: catalog.catalogName,
            ownerCatalogId: identity.catalog_id,
          });
    for (const schema of catalog.schemas) {
      const relationEntityIds = new Map<string, string>();
      for (const object of [...schema.tables, ...schema.views]) {
        const definition = asObject(
          parseJsonTag(object.tags, TAG_SEMANTIC_ENTITY),
        );
        if (definition?.entity_id)
          relationEntityIds.set(object.name, String(definition.entity_id));
      }
      const objects: Array<{
        object: any;
        kind: "relation" | "table_function";
        columns: ColumnInfo[];
      }> = [
        ...schema.tables.map((object) => ({
          object,
          kind: "relation" as const,
          columns: getColumns(object),
        })),
        ...schema.views.map((object: any) => ({
          object,
          kind: "relation" as const,
          columns: object._columnInfo ?? [],
        })),
        ...schema.functions
          .filter((object: any) => {
            if (
              !["TABLE", "TABLE_BUFFERING"].includes(
                String(object.function_type),
              )
            )
              return false;
            const definition = asObject(
              parseJsonTag(object.tags, TAG_SEMANTIC_ENTITY),
            );
            return (
              !definition?.entity_id ||
              relationEntityIds.get(object.name) !==
                String(definition.entity_id)
            );
          })
          .map((object: any) => ({
            object,
            kind: "table_function" as const,
            columns: object._functionReturn?.columns ?? [],
          })),
        ...schema.macros
          .filter(
            (object: any) =>
              String(object.macro_type).toUpperCase() === "TABLE" &&
              asObject(parseJsonTag(object.tags, TAG_SEMANTIC_ENTITY)),
          )
          .map((object: any) => ({
            object,
            kind: "table_function" as const,
            columns: object._functionReturn?.columns ?? [],
          })),
      ];
      const overloadCounts = new Map<string, number>();
      for (const { object, kind } of objects) {
        if (kind !== "table_function") continue;
        const key = `${object.name}:${object.function_type ?? object.macro_type}`;
        overloadCounts.set(key, (overloadCounts.get(key) ?? 0) + 1);
      }
      for (const { object, kind, columns } of objects) {
        const objectPath = `${catalog.catalogName}.${schema.info.name}.${object.name}`;
        const entity = asObject(
          validatedTag(
            object.tags,
            TAG_SEMANTIC_ENTITY,
            "entity",
            objectPath,
            diagnostics,
          ),
        );
        const rels = asArray(
          validatedTag(
            object.tags,
            TAG_SEMANTIC_RELATIONSHIPS,
            "relationships",
            objectPath,
            diagnostics,
          ),
        );
        if (identity)
          for (const value of rels)
            if (asObject(value))
              declarations.push({
                value,
                hostAlias: catalog.catalogName,
                ownerCatalogId: identity.catalog_id,
              });
        if (!entity) continue;
        if (!identity) {
          diagnostics.push({
            stage: "model_resolution",
            code: "missing_catalog_identity",
            message: `Semantic entity on ${catalog.catalogName}.${schema.info.name}.${object.name} has no vgi.semantic_catalog`,
          });
          continue;
        }
        const members = new Map<string, SemanticMember>();
        addMembers(
          members,
          validatedTag(
            object.tags,
            TAG_SEMANTIC_MEMBERS,
            "members",
            objectPath,
            diagnostics,
          ),
          objectPath,
          diagnostics,
        );
        for (const column of columns) {
          const native = asObject(
            validatedTag(
              column.tags,
              TAG_SEMANTIC_MEMBER,
              "member",
              `${objectPath}.${column.name}`,
              diagnostics,
            ),
          );
          if (!native) continue;
          const member = { ...native, column: native.column ?? column.name };
          addMembers(
            members,
            [member],
            `${catalog.catalogName}.${schema.info.name}.${object.name}.${column.name}`,
            diagnostics,
          );
        }
        const entityId = String(entity.entity_id ?? "");
        for (const member of members.values()) {
          if (member.kind !== "measure") continue;
          const inherentlyNonAdditive =
            member.expression != null ||
            ["count_distinct", "avg", "min", "max"].includes(
              String(member.aggregation),
            );
          if (inherentlyNonAdditive && member.additivity !== "non_additive")
            diagnostics.push({
              stage: "model_resolution",
              code: "invalid_measure_additivity",
              message: `Measure '${member.member_id}' must be non_additive for aggregation/expression '${member.aggregation ?? "derived"}'`,
              path: objectPath,
            });
          if (member.filter && member.expression)
            diagnostics.push({
              stage: "model_resolution",
              code: "derived_measure_filter_unsupported",
              message: `Derived measure '${member.member_id}' cannot own a filter; put filters on its referenced aggregate measures`,
              path: objectPath,
            });
          for (const predicate of modelFilterLeaves(member.filter)) {
            const filterMember = members.get(predicate.member);
            if (!filterMember)
              diagnostics.push({
                stage: "model_resolution",
                code: "unknown_measure_filter_member",
                message: `Measure '${member.member_id}' filter references unknown local member '${predicate.member}'`,
                path: objectPath,
              });
            else if (filterMember.kind === "measure")
              diagnostics.push({
                stage: "model_resolution",
                code: "measure_filter_requires_dimension",
                message: `Measure '${member.member_id}' filter member '${predicate.member}' must not be a measure`,
                path: objectPath,
              });
            else {
              const values = predicate.values ?? ("value" in predicate ? [predicate.value] : []);
              const columnPath = filterMember.column_path ?? (filterMember.column ? [filterMember.column] : []);
              const physicalType = columns.find((column) => column.name === columnPath[0])?.duckdbType;
              const filterType = filterMember.output_type ?? filterMember.data_type ??
                (physicalType && columnPath.length > 1
                  ? resolveNestedType(physicalType, columnPath.slice(1)) ?? undefined
                  : physicalType);
              if (values.some((value) => !valueCompatible(value, filterType)))
                diagnostics.push({
                  stage: "model_resolution",
                  code: "measure_filter_value_type_mismatch",
                  message: `Measure '${member.member_id}' filter values are incompatible with member '${predicate.member}'`,
                  path: objectPath,
                });
            }
          }
        }
        const sourceArguments = asArray(entity.source?.arguments);
        const detailedArguments =
          kind === "table_function" && object._functionArgsDetailed !== false
            ? getFunctionArgs(object)
            : [];
        const functionParameters =
          kind === "table_function"
            ? asArray(object._parameters ?? object.parameters).map(String)
            : [];
        const functionOverloadCount =
          kind === "table_function"
            ? (overloadCounts.get(
                `${object.name}:${object.function_type ?? object.macro_type}`,
              ) ?? 1)
            : 1;
        if (kind !== "table_function" && sourceArguments.length)
          diagnostics.push({
            stage: "model_resolution",
            code: "relation_source_arguments",
            message: `Relation entity '${entityId}' cannot declare table-function source arguments`,
            path: objectPath,
          });
        const argumentNames = sourceArguments.map((mapping) =>
          String(mapping.argument ?? ""),
        );
        const parameterNames = sourceArguments.map((mapping) =>
          String(mapping.parameter ?? ""),
        );
        if (new Set(argumentNames).size !== argumentNames.length)
          diagnostics.push({
            stage: "model_resolution",
            code: "duplicate_source_argument",
            message: `Entity '${entityId}' maps a table-function argument more than once`,
            path: objectPath,
          });
        if (new Set(parameterNames).size !== parameterNames.length)
          diagnostics.push({
            stage: "model_resolution",
            code: "duplicate_source_parameter",
            message: `Entity '${entityId}' maps a semantic parameter more than once`,
            path: objectPath,
          });
        if (kind === "table_function") {
          if (
            (sourceArguments.length || functionParameters.length) &&
            !detailedArguments.length
          )
            diagnostics.push({
              stage: "model_resolution",
              code: "missing_function_argument_metadata",
              message: `Table function '${entityId}' requires vgi_function_arguments() metadata`,
              path: objectPath,
            });
          const fieldIndexes = detailedArguments.flatMap((argument) =>
            argument.fieldIndex == null ? [] : [argument.fieldIndex],
          );
          if (
            functionOverloadCount > 1 ||
            new Set(fieldIndexes).size !== fieldIndexes.length
          )
            diagnostics.push({
              stage: "model_resolution",
              code: "ambiguous_function_overload",
              message: `Table function '${entityId}' has ambiguous overload metadata`,
              path: objectPath,
            });
          if (detailedArguments.some((argument) => argument.isVarargs))
            diagnostics.push({
              stage: "model_resolution",
              code: "unsupported_function_varargs",
              message: `Table function '${entityId}' uses unsupported varargs`,
              path: objectPath,
            });
          if (detailedArguments.some((argument) => argument.isTableInput))
            diagnostics.push({
              stage: "model_resolution",
              code: "unsupported_table_input",
              message: `Table function '${entityId}' requires an unsupported table input`,
              path: objectPath,
            });
          const byName = new Map<string, FunctionArg[]>();
          for (const argument of detailedArguments)
            byName.set(argument.name, [
              ...(byName.get(argument.name) ?? []),
              argument,
            ]);
          const unknown = [
            ...new Set(argumentNames.filter((name) => !byName.has(name))),
          ].sort();
          if (detailedArguments.length && unknown.length)
            diagnostics.push({
              stage: "model_resolution",
              code: "unknown_source_argument",
              message: `Source mappings reference unknown function arguments ${JSON.stringify(unknown)}`,
              path: objectPath,
            });
          if (argumentNames.some((name) => (byName.get(name)?.length ?? 0) > 1))
            diagnostics.push({
              stage: "model_resolution",
              code: "ambiguous_source_argument",
              message:
                "A source mapping resolves to more than one physical function argument",
              path: objectPath,
            });
          const mapped = new Set(argumentNames);
          const invalidKinds = detailedArguments
            .filter(
              (argument) =>
                mapped.has(argument.name) &&
                Boolean(argument.named) === Boolean(argument.positional) &&
                !argument.isVarargs,
            )
            .map((argument) => argument.name)
            .sort();
          if (invalidKinds.length)
            diagnostics.push({
              stage: "model_resolution",
              code: "invalid_source_argument_kind",
              message: `Source arguments must resolve to exactly one of named or positional: ${JSON.stringify(invalidKinds)}`,
              path: objectPath,
            });
          const missingPositions = detailedArguments
            .filter(
              (argument) =>
                mapped.has(argument.name) &&
                argument.positional &&
                argument.position == null,
            )
            .map((argument) => argument.name)
            .sort();
          if (missingPositions.length)
            diagnostics.push({
              stage: "model_resolution",
              code: "missing_source_argument_position",
              message: `Positional source arguments have no arg_position: ${JSON.stringify(missingPositions)}`,
              path: objectPath,
            });
          const optionalWithoutDefault = sourceArguments
            .filter(
              (mapping) =>
                mapping.required === false &&
                byName.get(String(mapping.argument))?.length === 1 &&
                byName.get(String(mapping.argument))![0].defaultValue ===
                  undefined,
            )
            .map((mapping) => String(mapping.argument))
            .sort();
          if (optionalWithoutDefault.length)
            diagnostics.push({
              stage: "model_resolution",
              code: "optional_source_argument_without_default",
              message: `Optional semantic source mappings require physical defaults: ${JSON.stringify(optionalWithoutDefault)}`,
              path: objectPath,
            });
          const unmappedRequired = detailedArguments
            .filter(
              (argument) =>
                !mapped.has(argument.name) &&
                !argument.isVarargs &&
                !argument.isTableInput &&
                argument.defaultValue === undefined,
            )
            .map((argument) => argument.name)
            .sort();
          if (unmappedRequired.length)
            diagnostics.push({
              stage: "model_resolution",
              code: "unmapped_required_source_argument",
              message: `Required function arguments lack semantic mappings: ${JSON.stringify(unmappedRequired)}`,
              path: objectPath,
            });
        }
        for (const member of members.values()) {
          if (!member.source_argument) continue;
          const argumentName = member.source_argument;
          const matches = detailedArguments.filter(
            (argument) => argument.name === argumentName,
          );
          const mappings = sourceArguments.filter(
            (mapping) => mapping.argument === argumentName,
          );
          if (kind !== "table_function")
            diagnostics.push({
              stage: "model_resolution",
              code: "source_argument_member_on_relation",
              message: `Member '${member.member_id}' uses source_argument on a relation`,
              path: objectPath,
            });
          else if (!matches.length)
            diagnostics.push({
              stage: "model_resolution",
              code: "source_argument_member_missing",
              message: `Member '${member.member_id}' references missing function argument '${argumentName}'`,
              path: objectPath,
            });
          else if (matches.length !== 1 || functionOverloadCount > 1)
            diagnostics.push({
              stage: "model_resolution",
              code: "source_argument_member_ambiguous",
              message: `Member '${member.member_id}' source argument '${argumentName}' is ambiguous`,
              path: objectPath,
            });
          else if (mappings.length !== 1)
            diagnostics.push({
              stage: "model_resolution",
              code: "source_argument_member_unmapped",
              message: `Member '${member.member_id}' source argument '${argumentName}' must be exposed by exactly one semantic source-argument mapping`,
              path: objectPath,
            });
          const declaredType = member.data_type ?? member.output_type;
          if (!declaredType)
            diagnostics.push({
              stage: "model_resolution",
              code: "source_argument_member_type_required",
              message: `Member '${member.member_id}' backed by a source argument needs data_type or output_type`,
              path: objectPath,
            });
          else if (
            matches.length === 1 &&
            !typesCompatible(declaredType, matches[0].duckdbType)
          )
            diagnostics.push({
              stage: "model_resolution",
              code: "source_argument_member_type_mismatch",
              message: `Member '${member.member_id}' type '${declaredType}' is incompatible with function argument '${argumentName}' type '${matches[0].duckdbType}'`,
              path: objectPath,
            });
        }
        for (const member of members.values()) {
          if (!member.unit_parameter) continue;
          const argumentName = member.unit_parameter.argument;
          const matches = detailedArguments.filter(
            (argument) => argument.name === argumentName,
          );
          if (!matches.length) {
            diagnostics.push({
              stage: "model_resolution",
              code: "unit_parameter_argument_missing",
              message: `Member '${member.member_id}' unit_parameter references missing function argument '${argumentName}'`,
              path: objectPath,
            });
            continue;
          }
          if (matches.length !== 1 || functionOverloadCount > 1) {
            diagnostics.push({
              stage: "model_resolution",
              code: "unit_parameter_argument_ambiguous",
              message: `Member '${member.member_id}' unit_parameter argument '${argumentName}' is ambiguous`,
              path: objectPath,
            });
            continue;
          }
          if (
            sourceArguments.filter(
              (mapping) => mapping.argument === argumentName,
            ).length !== 1
          ) {
            diagnostics.push({
              stage: "model_resolution",
              code: "unit_parameter_source_unmapped",
              message: `Member '${member.member_id}' unit_parameter argument '${argumentName}' must be exposed by exactly one semantic source-argument mapping`,
              path: objectPath,
            });
          }
          const missingChoices = (matches[0].choices ?? [])
            .filter((choice) => !(choice in member.unit_parameter!.values))
            .sort();
          if (missingChoices.length)
            diagnostics.push({
              stage: "model_resolution",
              code: "unit_parameter_choices_incomplete",
              message: `Member '${member.member_id}' unit mapping does not cover advertised choices ${JSON.stringify(missingChoices)}`,
              path: objectPath,
            });
        }
        const physicalColumns = new Map(
          columns.map((column) => [column.name, column.duckdbType]),
        );
        for (const member of members.values()) {
          const columnPath =
            member.column_path ?? (member.column ? [member.column] : []);
          if (!columnPath.length) continue;
          if (physicalColumns.size && !physicalColumns.has(columnPath[0])) {
            diagnostics.push({
              stage: "model_resolution",
              code: "unknown_physical_column",
              message: `Member '${member.member_id}' references unknown column root '${columnPath[0]}'`,
              path: objectPath,
            });
          } else if (
            columnPath.length > 1 &&
            physicalColumns.get(columnPath[0]) &&
            !resolveNestedType(
              physicalColumns.get(columnPath[0])!,
              columnPath.slice(1),
            )
          ) {
            diagnostics.push({
              stage: "model_resolution",
              code: "unknown_physical_column_path",
              message: `Member '${member.member_id}' references unknown nested field path '${columnPath.join(".")}' in ${physicalColumns.get(columnPath[0])}`,
              path: objectPath,
            });
          }
        }
        const duplicate = entities.find(
          (candidate) =>
            candidate.attachmentAlias === catalog.catalogName &&
            candidate.catalogId === identity.catalog_id &&
            candidate.entityId === entityId,
        );
        if (duplicate)
          diagnostics.push({
            stage: "model_resolution",
            code: "duplicate_entity",
            message: `Duplicate entity '${entityId}' in attachment '${catalog.catalogName}'`,
          });
        entities.push({
          key: entityKey(identity.catalog_id, entityId),
          catalogId: identity.catalog_id,
          catalogInstanceId: identity.catalog_instance_id,
          bindingKey: identity.binding_key ?? identity.catalog_id,
          attachmentAlias: catalog.catalogName,
          entityId,
          schemaName: schema.info.name,
          sourceName: object.name,
          sourceKind: kind,
          sourceArguments,
          functionArguments: detailedArguments,
          functionParameters,
          functionOverloadCount,
          inputFromArgs:
            typeof object.input_from_args === "boolean"
              ? object.input_from_args
              : null,
          grain: asArray(entity.grain).map(String),
          defaultTimeDimension:
            typeof entity.default_time_dimension === "string"
              ? entity.default_time_dimension
              : undefined,
          members,
          columns,
          requiredFilters: (asArray(object.required_filters).length
            ? asArray(object.required_filters)
            : parseRequiredFilters(object.tags)
          ).map((group) => asArray(group).map(String)),
        });
      }
    }
  }

  const byId = new Map<string, typeof declarations>();
  for (const declaration of declarations) {
    const id = String(declaration.value.relationship_id ?? "");
    const list = byId.get(id) ?? [];
    list.push(declaration);
    byId.set(id, list);
  }
  const relationships: SemanticRelationship[] = [];
  const attachedCatalogIds = new Set(
    identities.map((item) => item.identity.catalog_id),
  );
  for (const [relationshipId, items] of byId) {
    const normalized = items.map((item) => canonicalRelationship(item.value));
    const conflicted = new Set(normalized).size > 1;
    const value = items[0].value;
    const from = value.from as SemanticRef;
    const to = value.to as SemanticRef;
    let fromCandidates = entities.filter(
      (entity) => entity.key === entityKey(from?.catalog_id, from?.entity_id),
    );
    let toCandidates = entities.filter(
      (entity) => entity.key === entityKey(to?.catalog_id, to?.entity_id),
    );
    const endpointHosts = new Set(
      items
        .filter(
          (item) =>
            item.ownerCatalogId === from?.catalog_id ||
            item.ownerCatalogId === to?.catalog_id,
        )
        .map((item) => item.hostAlias),
    );
    if (
      fromCandidates.some((entity) => endpointHosts.has(entity.attachmentAlias))
    )
      fromCandidates = fromCandidates.filter((entity) =>
        endpointHosts.has(entity.attachmentAlias),
      );
    if (
      toCandidates.some((entity) => endpointHosts.has(entity.attachmentAlias))
    )
      toCandidates = toCandidates.filter((entity) =>
        endpointHosts.has(entity.attachmentAlias),
      );
    const status: ResolutionStatus = conflicted
      ? "conflicted"
      : fromCandidates.length === 0 || toCandidates.length === 0
        ? (fromCandidates.length === 0 &&
            attachedCatalogIds.has(from?.catalog_id)) ||
          (toCandidates.length === 0 && attachedCatalogIds.has(to?.catalog_id))
          ? "unavailable"
          : "unresolved"
        : fromCandidates.length > 1 || toCandidates.length > 1
          ? "ambiguous"
          : "resolved";
    if (conflicted)
      diagnostics.push({
        stage: "relationship_resolution",
        code: "relationship_conflict",
        message: `Relationship '${relationshipId}' has incompatible declarations`,
      });
    if (status === "resolved") {
      const endpointEntities = [fromCandidates[0], toCandidates[0]];
      for (const pair of asArray(value.predicate)) {
        const pairMembers = [
          endpointEntities[0].members.get(String(pair.from_member)),
          endpointEntities[1].members.get(String(pair.to_member)),
        ];
        if (pairMembers.some((member) => !member)) {
          diagnostics.push({
            stage: "relationship_resolution",
            code: "unresolved_relationship_member",
            message: `Relationship '${relationshipId}' references an unknown member`,
          });
          continue;
        }
        const types = pairMembers.map((member, index) =>
          semanticMemberType(endpointEntities[index], member!),
        );
        if (
          String(pair.operator ?? "equal").startsWith("spatial_") &&
          types.some(
            (type) =>
              type != null && !type.toUpperCase().startsWith("GEOMETRY"),
          )
        )
          diagnostics.push({
            stage: "relationship_resolution",
            code: "invalid_spatial_relationship_type",
            message: `Spatial relationship '${relationshipId}' members must be GEOMETRY`,
          });
        if (pair.operator === "list_contains") {
          const collectionIndex = "from_element_path" in pair ? 0 : 1;
          const path =
            collectionIndex === 0
              ? asArray(pair.from_element_path).map(String)
              : asArray(pair.to_element_path).map(String);
          const type = types[collectionIndex];
          if (type && !listElementType(type, path))
            diagnostics.push({
              stage: "relationship_resolution",
              code: "invalid_list_relationship_type",
              message: `Relationship '${relationshipId}' collection member must be a LIST with a valid element path`,
            });
        }
      }
      for (const condition of asArray(value.conditions)) {
        const endpoint = endpointEntities[condition.side === "from" ? 0 : 1];
        const member = endpoint.members.get(String(condition.member));
        if (!member)
          diagnostics.push({
            stage: "relationship_resolution",
            code: "unresolved_relationship_condition_member",
            message: `Relationship '${relationshipId}' condition references unknown member '${condition.member}'`,
          });
      }
    }
    const attesters = new Set(items.map((item) => item.ownerCatalogId));
    const endpointAttesters = [from?.catalog_id, to?.catalog_id].filter((id) =>
      attesters.has(id),
    );
    relationships.push({
      relationshipId,
      from,
      to,
      fromCardinality: value.from_cardinality,
      toCardinality: value.to_cardinality,
      predicate: value.predicate ?? [],
      conditions: value.conditions ?? [],
      hostAliases: [...new Set(items.map((item) => item.hostAlias))],
      resolutionStatus: status,
      attestation:
        endpointAttesters.length > 1
          ? "corroborated"
          : endpointAttesters.length === 0
            ? "third_party"
            : "unilateral",
    });
  }
  const structureIds = new Map<string, string>();
  for (const relationship of relationships) {
    const structure = canonicalRelationship({
      from: relationship.from,
      to: relationship.to,
      from_cardinality: relationship.fromCardinality,
      to_cardinality: relationship.toCardinality,
      predicate: relationship.predicate,
      conditions: relationship.conditions,
    });
    const previous = structureIds.get(structure);
    if (previous)
      diagnostics.push({
        stage: "relationship_resolution",
        code: "duplicate_relationship_candidate",
        message: `Relationships '${previous}' and '${relationship.relationshipId}' describe the same edge`,
      });
    else structureIds.set(structure, relationship.relationshipId);
  }
  return { catalogs: identities, entities, relationships, diagnostics };
}

export function resolveEntity(
  environment: SemanticEnvironment,
  ref: SemanticRef,
  bindings: Record<string, string> = {},
  anchorAlias?: string,
): SemanticEntity | SemanticDiagnostic {
  let candidates = environment.entities.filter(
    (entity) => entity.key === entityKey(ref.catalog_id, ref.entity_id),
  );
  if (
    anchorAlias &&
    candidates.some((entity) => entity.attachmentAlias === anchorAlias)
  )
    candidates = candidates.filter(
      (entity) => entity.attachmentAlias === anchorAlias,
    );
  const binding = candidates
    .map((entity) => bindings[entity.bindingKey] ?? bindings[entity.catalogId])
    .find(Boolean);
  if (binding)
    candidates = candidates.filter(
      (entity) => entity.attachmentAlias === binding,
    );
  if (candidates.length === 1) return candidates[0];
  return {
    stage: "catalog_binding",
    code: candidates.length
      ? "ambiguous_catalog_binding"
      : "unresolved_catalog_binding",
    message: candidates.length
      ? `Entity '${ref.catalog_id}.${ref.entity_id}' matches multiple attachments; provide bindings`
      : `Entity '${ref.catalog_id}.${ref.entity_id}' is not attached`,
    details: { candidates: candidates.map((entity) => entity.attachmentAlias) },
  };
}
