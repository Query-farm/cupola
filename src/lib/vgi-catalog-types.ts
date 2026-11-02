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
import { deserializeSchema, readConstraintRecord, type ConstraintRecordView } from "vgi/client";
import type {
  SchemaInfo as WireSchemaInfo,
  TableInfo as WireTableInfo,
  ViewInfo as WireViewInfo,
  FunctionInfo as WireFunctionInfo,
  MacroInfo as WireMacroInfo,
} from "vgi/client";

/** A schema, addressed by name the way Cupola addresses one. */
export type SchemaInfo = Omit<WireSchemaInfo, "path"> & { name: string };
/** Parsed foreign key constraint. */
export interface ForeignKeyInfo {
  columns: string[];
  referencedTable: string;
  referencedSchema: string;
  referencedColumns: string[];
  /** Catalog-qualified targets are possible for attached DuckDB databases. */
  referencedCatalog?: string;
  /** Stable database constraint name, when the catalog exposes one. */
  constraintName?: string;
}

/**
 * vgi.v3 serves a table's constraints as canonical records (`constraints`)
 * that name columns by path. Cupola keeps the shape it had before: key
 * constraints as top-level column indices, CHECKs as SQL text, foreign keys
 * decoded. DuckDB-attached catalogs (`duckdb-catalog.ts`) fill the same
 * fields from `duckdb_constraints()`, so both sources look alike downstream.
 * `required_filters` likewise stays a list of OR-groups of dotted paths.
 */
export type TableInfo = Omit<WireTableInfo, "schema_path" | "constraints" | "required_filters"> & {
  schema_name: string;
  not_null_constraints: number[];
  unique_constraints: number[][];
  check_constraints: string[];
  primary_key_constraints: number[][];
  foreign_key_constraints: ForeignKeyInfo[];
  required_filters: string[][];
};
export type ViewInfo = Omit<WireViewInfo, "schema_path"> & { schema_name: string };
export type FunctionInfo = Omit<WireFunctionInfo, "schema_path"> & { schema_name: string };
/**
 * vgi.v3 macros are overload families. `parameters` and `definition` are the
 * first overload's, which is the only one every server serves today; the
 * family itself stays on `overloads` when the RPC tree supplied one.
 */
export type MacroInfo = Omit<WireMacroInfo, "schema_path" | "overloads"> & {
  schema_name: string;
  parameters: string[];
  definition: string;
  overloads?: WireMacroInfo["overloads"];
};

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

/** A dotted name for a required-filter path (`["bbox","xmin"]` → `bbox.xmin`). */
export function requiredFilterPathName(path: unknown): string {
  if (typeof path === "string") return path;
  return Array.isArray(path) ? path.map(String).join(".") : "";
}

function decodeConstraints(wire: WireTableInfo): ConstraintRecordView[] {
  const records: ConstraintRecordView[] = [];
  for (const bytes of wire.constraints ?? []) {
    try {
      records.push(readConstraintRecord(bytes));
    } catch {
      // An undecodable record is skipped rather than failing the whole tree.
    }
  }
  return records;
}

export function flattenTableInfo(wire: WireTableInfo): TableInfo {
  const { constraints: _constraints, required_filters, ...rest } = flattenChild(wire);
  let names: string[] = [];
  try {
    names = deserializeSchema(wire.columns).fields.map((field) => field.name);
  } catch {
    names = [];
  }
  // Key constraints are indexed by top-level column; a nested path (a NOT NULL
  // on a struct field) has no index and is left to the column's own nullability.
  const indices = (columns: string[][]): number[] | null => {
    const out = columns.map((path) => (path.length === 1 ? names.indexOf(path[0]!) : -1));
    return out.every((index) => index >= 0) ? out : null;
  };
  const table: TableInfo = {
    ...rest,
    not_null_constraints: [],
    unique_constraints: [],
    check_constraints: [],
    primary_key_constraints: [],
    foreign_key_constraints: [],
    required_filters: (required_filters ?? [])
      .map((group) => group.map(requiredFilterPathName).filter(Boolean))
      .filter((group) => group.length > 0),
  };
  for (const record of decodeConstraints(wire)) {
    switch (record.kind) {
      case "NOT_NULL": {
        const key = indices(record.columns);
        if (key) table.not_null_constraints.push(...key);
        break;
      }
      case "PRIMARY_KEY":
      case "UNIQUE": {
        const key = indices(record.columns);
        if (key) (record.kind === "PRIMARY_KEY" ? table.primary_key_constraints : table.unique_constraints).push(key);
        break;
      }
      case "CHECK":
        if (record.checkSql) table.check_constraints.push(record.checkSql);
        break;
      case "FOREIGN_KEY":
        if (record.references) {
          table.foreign_key_constraints.push({
            columns: record.columns.map((path) => path.join(".")),
            referencedTable: record.references.table,
            referencedSchema: schemaNameFromPath(record.references.schemaPath),
            referencedColumns: record.references.columns.map((path) => path.join(".")),
            ...(record.declaredName ? { constraintName: record.declaredName } : {}),
          });
        }
        break;
    }
  }
  table.not_null_constraints.sort((a, b) => a - b);
  return table;
}
export const flattenViewInfo = (wire: WireViewInfo): ViewInfo => flattenChild(wire);
export const flattenFunctionInfo = (wire: WireFunctionInfo): FunctionInfo =>
  flattenChild(wire);
export function flattenMacroInfo(wire: WireMacroInfo): MacroInfo {
  const flat = flattenChild(wire);
  const first = flat.overloads?.[0];
  return {
    ...flat,
    parameters: first?.parameters.map((parameter) => parameter.name) ?? [],
    definition: first?.definition ?? "",
  };
}
