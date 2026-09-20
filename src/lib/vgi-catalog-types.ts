/**
 * Cupola's flat view of the VGI catalog wire types.
 *
 * VGI 0.29 made a schema a *path* rather than a name: `SchemaInfo.name` became
 * `SchemaInfo.path: string[]`, and every object's `schema_name` became
 * `schema_path: string[]`. The wire model now admits nested schemas.
 *
 * Cupola does not, and neither does the thing underneath it. A schema is a
 * single name in the hash route (`#/schema/<s>/table/<t>`), in the SQL the
 * shell and editor generate (`"schema"."table"`), in the AI tool contract
 * (`describe_table`'s `schema` argument), and in DuckDB itself, which has no
 * nested schemas for the VGI extension to map a path onto. Teaching all of
 * that about paths is a real feature, not a dependency bump.
 *
 * So the path is flattened exactly once, here at the RPC boundary, and every
 * downstream module keeps the flat field it always had. These types are the
 * wire types minus the path field, plus the flat name — importing them instead
 * of `vgi/client` is what makes a module downstream of the boundary.
 *
 * `join(".")` is exact for the one-element paths every VGI server serves
 * today. A genuinely nested catalog would render as `outer.inner`, which reads
 * correctly and routes consistently but would not be a valid single SQL
 * identifier. That is the honest failure: it is visible, rather than a path
 * silently truncated to its last element.
 */
import type {
  SchemaInfo as WireSchemaInfo,
  TableInfo as WireTableInfo,
  ViewInfo as WireViewInfo,
  FunctionInfo as WireFunctionInfo,
  MacroInfo as WireMacroInfo,
} from "vgi/client";

/** A schema, addressed by name the way Cupola addresses one. */
export type SchemaInfo = Omit<WireSchemaInfo, "path"> & { name: string };
export type TableInfo = Omit<WireTableInfo, "schema_path"> & { schema_name: string };
export type ViewInfo = Omit<WireViewInfo, "schema_path"> & { schema_name: string };
export type FunctionInfo = Omit<WireFunctionInfo, "schema_path"> & { schema_name: string };
export type MacroInfo = Omit<WireMacroInfo, "schema_path"> & { schema_name: string };

/** The wire types, for the RPC boundary itself. Nothing else should need them. */
export type {
  WireSchemaInfo,
  WireTableInfo,
  WireViewInfo,
  WireFunctionInfo,
  WireMacroInfo,
};

/** Flatten a schema path to the single name Cupola routes and quotes with. */
export function schemaNameFromPath(path: readonly string[] | null | undefined): string {
  return (path ?? []).join(".");
}

/** Drop a schema's path in favour of its flat name. */
export function flattenSchemaInfo(wire: WireSchemaInfo): SchemaInfo {
  const { path, ...rest } = wire;
  return { ...rest, name: schemaNameFromPath(path) };
}

/** Drop an object's `schema_path` in favour of the flat `schema_name`. */
function flattenChild<T extends { schema_path: string[] }>(
  wire: T,
): Omit<T, "schema_path"> & { schema_name: string } {
  const { schema_path, ...rest } = wire;
  return { ...rest, schema_name: schemaNameFromPath(schema_path) };
}

export const flattenTableInfo = (wire: WireTableInfo): TableInfo => flattenChild(wire);
export const flattenViewInfo = (wire: WireViewInfo): ViewInfo => flattenChild(wire);
export const flattenFunctionInfo = (wire: WireFunctionInfo): FunctionInfo =>
  flattenChild(wire);
export const flattenMacroInfo = (wire: WireMacroInfo): MacroInfo => flattenChild(wire);
