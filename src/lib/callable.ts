/**
 * One shape over everything a SQL author can call: VGI functions, DuckDB
 * functions in an attached catalog, and macros. The sidebar hover card, the
 * editor's Inspector, snippet insertion and in-editor signature help all read
 * this, so a function looks the same wherever it shows up.
 *
 * Kept free of RPC/engine imports so it stays unit-testable.
 */
import type { FunctionInfo, MacroInfo } from "./vgi-catalog-types";
import type { CatalogData } from "./service";
import { formatSignature, getFunctionArgs, getFunctionReturn, isTableFunction, type FunctionArg, type FunctionReturn } from "./function-info";
import { getTag, TAG_DOC_MD, TAG_TITLE } from "./tags";

export interface Callable {
  kind: "function" | "macro";
  /** `system` for DuckDB's built-in functions. */
  catalog: string;
  schema: string;
  name: string;
  args: FunctionArg[];
  ret: FunctionReturn;
  /** Returns a table, so it belongs in FROM rather than a SELECT list. */
  isTable: boolean;
  /** `name(arg TYPE, …) → RET`, unqualified. */
  signature: string;
  /** One-paragraph plain description ("" when undocumented). */
  description: string;
  /** Long-form Markdown documentation (`vgi.doc_md`), if any. */
  docMd?: string;
  source: FunctionInfo | MacroInfo;
}

type MacroWithOverrides = MacroInfo & {
  _functionArgs?: FunctionArg[];
  _functionReturn?: FunctionReturn;
  _parameterTypes?: string[];
};

/** A macro's arguments. DuckDB-introspected macros carry `_functionArgs` only
 *  when `vgi_function_arguments()` described them, and it comes back empty for
 *  a plain `CREATE MACRO`, so fall back to the declared parameter names. */
export function macroArgs(macro: MacroInfo): FunctionArg[] {
  const m = macro as MacroWithOverrides;
  if (m._functionArgs?.length) return m._functionArgs;
  return (macro.parameters ?? []).map((name, index) => {
    const type = m._parameterTypes?.[index] || "ANY";
    return {
      name,
      arrowType: type,
      duckdbType: type,
      nullable: true,
      named: false,
      positional: true,
      position: index,
      fieldIndex: index,
      isTableInput: false,
      isAnyType: type.toUpperCase() === "ANY",
      isVarargs: false,
      isConst: false,
    };
  });
}

function firstText(...values: (string | null | undefined)[]): string {
  for (const v of values) if (v && v.trim()) return v.trim();
  return "";
}

export function functionCallable(catalog: string, func: FunctionInfo): Callable {
  const args = getFunctionArgs(func);
  const ret = getFunctionReturn(func);
  return {
    kind: "function",
    catalog,
    schema: func.schema_name,
    name: func.name,
    args,
    ret,
    isTable: isTableFunction(func),
    signature: formatSignature(func.name, args, ret),
    description: firstText(func.description, func.comment, getTag(func.tags, TAG_TITLE)),
    docMd: getTag(func.tags, TAG_DOC_MD) || undefined,
    source: func,
  };
}

export function macroCallable(catalog: string, macro: MacroInfo): Callable {
  const args = macroArgs(macro);
  const isTable = macro.macro_type === "TABLE";
  const ret = (macro as MacroWithOverrides)._functionReturn ?? { isTable, columns: [] };
  return {
    kind: "macro",
    catalog,
    schema: macro.schema_name,
    name: macro.name,
    args,
    ret,
    isTable,
    signature: formatSignature(macro.name, args, ret),
    description: firstText(macro.comment, getTag(macro.tags, TAG_TITLE)),
    docMd: getTag(macro.tags, TAG_DOC_MD) || undefined,
    source: macro,
  };
}

/** Every overload of `catalog.schema.name` of the given kind. DuckDB returns
 *  one row per overload, so a schema can list the same name more than once. */
export function findCallables(
  catalogs: readonly CatalogData[],
  catalog: string,
  schema: string,
  name: string,
  kind: "function" | "macro",
): Callable[] {
  const s = catalogs.find((c) => c.catalogName === catalog)?.schemas.find((x) => x.info.name === schema);
  if (!s) return [];
  return kind === "function"
    ? s.functions.filter((f) => f.name === name).map((f) => functionCallable(catalog, f))
    : (s.macros ?? []).filter((m) => m.name === name).map((m) => macroCallable(catalog, m));
}

/** The callables behind a sidebar selection (`{type: "function"|"macro", catalog, schema, name}`). */
export function callablesForSelection(
  catalogs: readonly CatalogData[],
  sel: { type: string; catalog?: string; schema?: string; name: string } | null | undefined,
): Callable[] {
  if (!sel || !sel.catalog || !sel.schema || (sel.type !== "function" && sel.type !== "macro")) return [];
  return findCallables(catalogs, sel.catalog, sel.schema, sel.name, sel.type);
}

/** One of DuckDB's own functions, called by bare name. */
export function isBuiltin(c: Pick<Callable, "catalog">): boolean {
  return c.catalog === "system";
}
