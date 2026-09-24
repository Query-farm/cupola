import { evidenceRegistry } from './editor-support';

// Serialize schema metadata, never component constructors or validator functions.
function attributeType(type: any): unknown {
  if (Array.isArray(type)) return type.map(attributeType);
  if (type?.zodSchema) return describeZod(type.zodSchema);
  return type?.name ?? 'unknown';
}
function describeZod(schema: any, depth = 0): unknown {
  if (depth > 8) return 'nested value';
  const def = schema?._def;
  if (!def) return 'unknown';
  const kind = def.typeName;
  if (def.innerType) return { type: describeZod(def.innerType, depth + 1), wrapper: kind };
  if (def.schema) return describeZod(def.schema, depth + 1);
  if (kind === 'ZodEnum') return { enum: def.values };
  if (kind === 'ZodLiteral') return { const: def.value };
  if (kind === 'ZodUnion') return { anyOf: def.options.map((s: unknown) => describeZod(s, depth + 1)) };
  if (kind === 'ZodObject') return { type: 'object', properties: Object.fromEntries(Object.entries(def.shape()).map(([key, value]) => [key, describeZod(value, depth + 1)])) };
  if (kind === 'ZodArray') return { type: 'array', items: describeZod(def.type, depth + 1) };
  return { type: kind, description: schema.description, checks: def.checks };
}
export async function componentReference(name?: string) {
  const tags = await evidenceRegistry();
  if (name === undefined) return Object.entries(tags).map(([name, component]) => ({ name, description: component.schema.description, category: component.schema.category }));
  if (!Object.hasOwn(tags, name)) throw new Error(`Unknown Evidence component: ${name}`);
  const schema = tags[name].schema;
  return {
    name, description: schema.description, category: schema.category, examples: schema.examples,
    allowedChildren: schema.allowedChildren, allowedParents: schema.allowedParents, filterProperties: schema.filterProperties, dataSources: schema.dataSources, snippet: schema.snippet,
    attributes: Object.fromEntries(Object.entries(schema.attributes).map(([key, attr]) => [key, {
      type: attributeType(attr.type), description: attr.description, required: attr.required ?? false,
      default: attr.default, matches: attr.matches, deprecated: attr.deprecated,
    }])),
  };
}
