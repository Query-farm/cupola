import type {
  SemanticEnvironment,
  SemanticEntity,
  SemanticRef,
} from "../semantic-model";
import type { ReportParameter } from "./types";

export const semanticEntityKey = (ref: SemanticRef) =>
  `${ref.catalog_id}::${ref.entity_id}`;
export const semanticMemberKey = (ref: SemanticRef & { member_id: string }) =>
  `${semanticEntityKey(ref)}::${ref.member_id}`;
export const semanticEntityRef = (entity: SemanticEntity): SemanticRef => ({
  catalog_id: entity.catalogId,
  entity_id: entity.entityId,
});

/** Keep the JSON editor reachable while its query has incomplete structure.
 * Value and semantic validation belong to the compiler. */
export function semanticBuilderShapeError(
  query: Record<string, any>,
): string | null {
  const object = (value: any) =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const list = (value: any, valid: (item: any) => boolean = object): boolean =>
    value == null || (Array.isArray(value) && value.every(valid));
  const strings = (value: any) =>
    list(value, (item) => typeof item === "string");
  const filter = (value: any, depth = 0): boolean =>
    value == null ||
    (depth < 16 &&
      object(value) &&
      list(value.and, (item) => filter(item, depth + 1)) &&
      list(value.or, (item) => filter(item, depth + 1)));
  const expression = (value: any, depth = 0): boolean =>
    value == null ||
    (depth < 16 &&
      object(value) &&
      list(value.args, (item) => expression(item, depth + 1)) &&
      expression(value.left, depth + 1) &&
      expression(value.right, depth + 1) &&
      expression(value.other, depth + 1) &&
      (!["cast", "nullif"].includes(value.op) ||
        expression(value.value, depth + 1)));
  const checks: Record<string, boolean> = {
    measures: list(query.measures),
    dimensions: list(
      query.dimensions,
      (item) =>
        object(item) &&
        strings(item.relationship_path) &&
        list(
          item.branch_members,
          (branch) =>
            object(branch) &&
            object(branch.root) &&
            object(branch.member) &&
            strings(branch.relationship_path),
        ) &&
        list(
          item.branch_relationship_paths,
          (branch) =>
            object(branch) &&
            object(branch.root) &&
            strings(branch.relationship_path),
        ),
    ),
    filters: filter(query.filters),
    measure_filters: filter(query.measure_filters),
    derived_measures: list(
      query.derived_measures,
      (item) => object(item) && expression(item.expression),
    ),
    inputs: list(
      query.inputs,
      (item) =>
        object(item) &&
        Array.isArray(item.columns) &&
        list(item.columns) &&
        Array.isArray(item.grain) &&
        strings(item.grain) &&
        Array.isArray(item.rows) &&
        item.rows.every(Array.isArray),
    ),
    source_bindings: list(
      query.source_bindings,
      (item) =>
        object(item) &&
        object(item.entity) &&
        object(item.driver) &&
        object(item.arguments) &&
        Object.values(item.arguments).every(object) &&
        list(item.driver.order) &&
        filter(item.driver.filters),
    ),
    order: list(query.order),
  };
  return Object.keys(checks).find((key) => !checks[key]) ?? null;
}

export function semanticParameterOptions(parameters: ReportParameter[]) {
  return parameters.flatMap((parameter) =>
    parameter.type === "date_range"
      ? (["start", "end"] as const).map((part) => ({
          value: JSON.stringify({ report_parameter: parameter.key, part }),
          label: `${parameter.label} · ${part}`,
        }))
      : [
          {
            value: JSON.stringify({ report_parameter: parameter.key }),
            label: parameter.label,
          },
        ],
  );
}

export function semanticEntities(
  environment: SemanticEnvironment,
): SemanticEntity[] {
  return [
    ...new Map(
      environment.entities.map((entity) => [entity.key, entity]),
    ).values(),
  ];
}

/** Offer only outgoing steps that cannot fan out the selected fact rows.
 * The compiler still checks the complete path and catalog bindings. */
export function semanticPathSteps(
  environment: SemanticEnvironment,
  root: SemanticRef,
  path: string[],
) {
  let current = root;
  for (const id of path) {
    const relationship = environment.relationships.find(
      (item) => item.relationshipId === id,
    );
    if (!relationship) return [];
    if (semanticEntityKey(relationship.from) === semanticEntityKey(current))
      current = relationship.to;
    else if (semanticEntityKey(relationship.to) === semanticEntityKey(current))
      current = relationship.from;
    else return [];
  }
  return environment.relationships
    .filter(
      (relationship) =>
        !path.includes(relationship.relationshipId) &&
        ["resolved", "ambiguous"].includes(relationship.resolutionStatus),
    )
    .flatMap((relationship) => {
      const forward =
        semanticEntityKey(relationship.from) === semanticEntityKey(current);
      const backward =
        semanticEntityKey(relationship.to) === semanticEntityKey(current);
      if (
        (!forward && !backward) ||
        (forward
          ? relationship.toCardinality.max
          : relationship.fromCardinality.max) !== 1
      )
        return [];
      const target = forward ? relationship.to : relationship.from;
      return [
        {
          value: relationship.relationshipId,
          label: `${target.entity_id} · ${relationship.relationshipId}`,
        },
      ];
    });
}

export function replaceSemanticFilterOperator(
  filter: Record<string, any>,
  operator: string,
) {
  const { value, values, ...rest } = filter;
  if (["is_null", "is_not_null"].includes(operator))
    return { ...rest, operator };
  if (["in", "not_in", "between"].includes(operator))
    return {
      ...rest,
      operator,
      values:
        operator === "between"
          ? [
              Array.isArray(values) ? (values[0] ?? "") : (value ?? ""),
              Array.isArray(values) ? (values[1] ?? "") : "",
            ]
          : (values ?? [value ?? ""]),
    };
  return {
    ...rest,
    operator,
    value: value ?? (Array.isArray(values) ? values[0] : undefined) ?? "",
  };
}

/** Output aliases are referenced by sort, post-aggregation filters and formulas.
 * Entity/member refs and literal values are deliberately left alone. */
export function renameSemanticOutput(
  query: Record<string, any>,
  previous: string,
  next: string,
) {
  if (
    typeof previous !== "string" ||
    typeof next !== "string" ||
    previous === next
  )
    return query;
  const rename = (node: any): any => {
    if (Array.isArray(node)) return node.map(rename);
    if (!node || typeof node !== "object") return node;
    return Object.fromEntries(
      Object.entries(node).map(([key, value]) => [
        key,
        key === "member" && value === previous
          ? next
          : key === "value" && node.op === "literal"
            ? value
            : rename(value),
      ]),
    );
  };
  return {
    ...query,
    ...(query.order
      ? {
          order: query.order.map((item: any) =>
            item.member === previous ? { ...item, member: next } : item,
          ),
        }
      : {}),
    ...(query.measure_filters
      ? { measure_filters: rename(query.measure_filters) }
      : {}),
    ...(query.derived_measures
      ? {
          derived_measures: query.derived_measures.map((formula: any) => ({
            ...formula,
            expression: rename(formula.expression),
          })),
        }
      : {}),
  };
}
