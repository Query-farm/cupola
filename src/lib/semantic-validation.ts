import schemas from "./vgi-semantic-schemas.json";

export type SemanticSchemaName = "catalog" | "entity" | "member" | "members" | "relationships" | "query";

type JsonSchema = Record<string, any>;

function typeMatches(expected: string, value: unknown): boolean {
  if (expected === "null") return value === null;
  if (expected === "array") return Array.isArray(value);
  if (expected === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (expected === "integer") return typeof value === "number" && Number.isInteger(value);
  return typeof value === expected;
}

function pointer(document: JsonSchema, fragment: string): JsonSchema {
  if (!fragment || fragment === "#") return document;
  return fragment.replace(/^#\//, "").split("/").reduce<any>((value, part) => value[part.replace(/~1/g, "/").replace(/~0/g, "~")], document);
}

function resolveRef(current: SemanticSchemaName | keyof typeof schemas, ref: string): { name: keyof typeof schemas; schema: JsonSchema } {
  const [file, fragment = ""] = ref.split("#", 2);
  const name = (file ? file.replace(/\.json$/, "") : current) as keyof typeof schemas;
  return { name, schema: pointer(schemas[name] as JsonSchema, fragment ? `#${fragment}` : "#") };
}

function validate(schema: JsonSchema, value: unknown, path: string, documentName: keyof typeof schemas): string[] {
  if (schema.$ref) {
    const resolved = resolveRef(documentName, schema.$ref);
    return validate(resolved.schema, value, path, resolved.name);
  }
  const errors: string[] = [];
  if (schema.allOf) errors.push(...schema.allOf.flatMap((item: JsonSchema) => validate(item, value, path, documentName)));
  if (schema.oneOf) {
    const attempts = schema.oneOf.map((item: JsonSchema) => validate(item, value, path, documentName));
    if (attempts.filter((branchErrors: string[]) => branchErrors.length === 0).length !== 1) errors.push(`${path}: must match exactly one allowed shape`);
  }
  if (schema.anyOf) {
    const attempts = schema.anyOf.map((item: JsonSchema) => validate(item, value, path, documentName));
    if (!attempts.some((branchErrors: string[]) => branchErrors.length === 0)) errors.push(`${path}: must match an allowed shape`);
  }
  if (schema.not && validate(schema.not, value, path, documentName).length === 0) errors.push(`${path}: matches a forbidden shape`);
  if ("const" in schema && value !== schema.const) errors.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((candidate: unknown) => Object.is(candidate, value))) errors.push(`${path}: must be one of ${schema.enum.map(String).join(", ")}`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type: string) => typeMatches(type, value))) {
      errors.push(`${path}: must be ${types.join(" or ")}`);
      return errors;
    }
  }
  if (typeof value === "string") {
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${path}: is shorter than ${schema.minLength}`);
    if (schema.maxLength != null && value.length > schema.maxLength) errors.push(`${path}: is longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) errors.push(`${path}: does not match ${schema.pattern}`);
  }
  if (typeof value === "number") {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${path}: must be >= ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${path}: must be <= ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) errors.push(`${path}: needs at least ${schema.minItems} items`);
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push(`${path}: exceeds ${schema.maxItems} items`);
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) errors.push(`${path}: items must be unique`);
    if (schema.items) value.forEach((item, index) => errors.push(...validate(schema.items, item, `${path}[${index}]`, documentName)));
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    if (schema.minProperties != null && Object.keys(object).length < schema.minProperties) errors.push(`${path}: needs at least ${schema.minProperties} properties`);
    if (schema.maxProperties != null && Object.keys(object).length > schema.maxProperties) errors.push(`${path}: exceeds ${schema.maxProperties} properties`);
    for (const key of schema.required ?? []) if (!(key in object)) errors.push(`${path}: missing required property ${key}`);
    for (const [key, item] of Object.entries(object)) {
      if (schema.propertyNames) errors.push(...validate(schema.propertyNames, key, `${path}.${key}`, documentName));
      if (schema.properties?.[key]) errors.push(...validate(schema.properties[key], item, `${path}.${key}`, documentName));
      else if (schema.additionalProperties === false) errors.push(`${path}: additional property ${key} is not allowed`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") errors.push(...validate(schema.additionalProperties, item, `${path}.${key}`, documentName));
    }
  }
  return errors;
}

/** Validate against the exact schemas shipped by vgi-lint-check. */
export function validateSemanticValue(name: SemanticSchemaName, value: unknown): string[] {
  return validate(schemas[name] as JsonSchema, value, "$", name);
}
