/**
 * Parse and format VGI function metadata.
 *
 * `FunctionInfo.arguments` and `.output_schema` are serialized Arrow schemas (bytes).
 * This module decodes them into argument/return descriptions and builds a human-readable
 * call signature. Kept free of RPC/transport imports so it stays unit-testable.
 */
import { deserializeSchema } from "vgi/client";
import type { FunctionInfo } from "vgi/client";
import { arrowFieldToDuckDB } from "./arrow-to-duckdb";
import type { ColumnInfo } from "./service";

/** A parsed function argument from a FunctionInfo's serialized `arguments` schema. */
export interface FunctionArg {
  name: string;
  /** Raw Arrow type string. */
  arrowType: string;
  /** DuckDB display type (with geometry/UUID/JSON extension detection). */
  duckdbType: string;
  nullable: boolean;
  /** Named (keyword) argument rather than positional. */
  named: boolean;
  /** Accepts a table as input (table-in-out functions). */
  isTableInput: boolean;
  /** Polymorphic ANY-typed argument. */
  isAnyType: boolean;
  /** Variadic argument. */
  isVarargs: boolean;
  /** Must be a constant expression. */
  isConst: boolean;
}

/** Parsed return shape from a FunctionInfo's serialized `output_schema`. */
export interface FunctionReturn {
  /** Output columns. Empty for table functions whose shape is resolved at bind time. */
  columns: ColumnInfo[];
  /** Whether the function returns a table (vs. a scalar value). */
  isTable: boolean;
}

// VGI argument metadata keys — stable wire constants. Source of truth:
// vgi-typescript/src/types.ts (VGI_ARG_KEY, VGI_TYPE_KEY, VGI_VARARGS_KEY, VGI_CONST_KEY).
// These are NOT re-exported from the `vgi/client` entry, so they're mirrored here.
const VGI_ARG_KEY = "vgi_arg";
const VGI_ARG_NAMED = "named";
const VGI_TYPE_KEY = "vgi_type";
const VGI_TYPE_TABLE = "table";
const VGI_TYPE_ANY = "any";
const VGI_VARARGS_KEY = "vgi_varargs";
const VGI_CONST_KEY = "vgi_const";

/** Whether a function returns a table. Compares the uppercase wire value directly —
 *  do NOT use the lowercase `FunctionType` enum from `vgi/client`; it never matches. */
export function isTableFunction(func: FunctionInfo): boolean {
  return func.function_type === "TABLE" || func.function_type === "TABLE_BUFFERING";
}

/** Parse a function's argument list from its serialized Arrow `arguments` schema.
 *  Field order is already positional-first then named (set at serialization), so it
 *  is consumed as-is. Returns [] for no-arg functions or an unreadable schema. */
export function getFunctionArgs(func: FunctionInfo): FunctionArg[] {
  if (!func.arguments || func.arguments.length === 0) return [];
  try {
    const schema = deserializeSchema(func.arguments);
    return schema.fields.map((f) => {
      const m = f.metadata;
      const vgiType = m?.get(VGI_TYPE_KEY);
      return {
        name: f.name,
        arrowType: f.type.toString(),
        duckdbType: arrowFieldToDuckDB(f),
        nullable: f.nullable,
        named: m?.get(VGI_ARG_KEY) === VGI_ARG_NAMED,
        isTableInput: vgiType === VGI_TYPE_TABLE,
        isAnyType: vgiType === VGI_TYPE_ANY,
        isVarargs: m?.get(VGI_VARARGS_KEY) === "true",
        isConst: m?.get(VGI_CONST_KEY) === "true",
      };
    });
  } catch {
    return [];
  }
}

/** Parse a function's return shape from its serialized Arrow `output_schema`.
 *  A present-but-zero-field schema (common for bind-time table functions) yields
 *  `{ columns: [], isTable }`. */
export function getFunctionReturn(func: FunctionInfo): FunctionReturn {
  const isTable = isTableFunction(func);
  if (!func.output_schema || func.output_schema.length === 0) {
    return { columns: [], isTable };
  }
  try {
    const schema = deserializeSchema(func.output_schema);
    const columns: ColumnInfo[] = schema.fields.map((f) => ({
      name: f.name,
      arrowType: f.type.toString(),
      duckdbType: arrowFieldToDuckDB(f),
      nullable: f.nullable,
      comment: f.metadata?.get("comment") ?? undefined,
      defaultValue: f.metadata?.get("default") ?? undefined,
    }));
    return { columns, isTable };
  } catch {
    return { columns: [], isTable };
  }
}

/** Display type for one argument — ANY and table-input override the raw Arrow type. */
function argDisplayType(arg: FunctionArg): string {
  if (arg.isAnyType) return "ANY";
  if (arg.isTableInput) return "TABLE";
  return arg.duckdbType;
}

/** Build a human-readable call signature, e.g.
 *  `st_buffer(geom GEOMETRY, dist DOUBLE) → TABLE(id BIGINT, buffer GEOMETRY)`.
 *  Named args render `name := TYPE`; varargs get a trailing `...`; a table function
 *  with an empty output schema renders `→ TABLE` (no parens). */
export function formatFunctionSignature(func: FunctionInfo): string {
  const args = getFunctionArgs(func);
  const argParts = args.map((a) => {
    const type = argDisplayType(a);
    const base = a.named ? `${a.name} := ${type}` : `${a.name} ${type}`;
    return a.isVarargs ? `${base}...` : base;
  });
  const call = `${func.name}(${argParts.join(", ")})`;

  const ret = getFunctionReturn(func);
  if (ret.isTable) {
    if (ret.columns.length === 0) return `${call} → TABLE`;
    const cols = ret.columns.map((c) => `${c.name} ${c.duckdbType}`).join(", ");
    return `${call} → TABLE(${cols})`;
  }
  const retType = ret.columns[0]?.duckdbType ?? "";
  return retType ? `${call} → ${retType}` : call;
}
