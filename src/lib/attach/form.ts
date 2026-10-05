/**
 * The options form's submit logic, kept out of the component so it is
 * unit-tested: typed fields (one per declared option) plus a raw-text
 * fallback, which goes through the same legacy parser as a URL.
 */
import { parsePlainLiteral, splitLegacyOptions } from "./legacy-options";
import { formatOptionList, isSecretOption, isValidOptionName, partitionSecrets, type OptionSpecInfo } from "./options";

export interface CollectedOptions {
  /** Structured values, secrets included. */
  options: Record<string, string>;
  /** Raw expressions to evaluate in the engine at connect time. */
  rawOptions: string;
  /** Why the form cannot be submitted; empty when it can. */
  errors: string[];
}

/** Combine the typed fields and the raw text. An empty field means "not set"
 *  (the server's default applies), so it is left out rather than sent as ''. */
export function collectFormOptions(
  fields: Record<string, string>,
  raw: string,
  specs: readonly OptionSpecInfo[],
): CollectedOptions {
  const options: Record<string, string> = {};
  const errors: string[] = [];
  const pending: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value === "") continue;
    if (!isValidOptionName(name)) {
      errors.push(`"${name}" is not a valid option name.`);
      continue;
    }
    options[name] = value;
  }
  const { entries, problems } = splitLegacyOptions(raw);
  for (const p of problems) errors.push(`${p.name ?? p.text}: ${p.reason}`);
  for (const { name, expr } of entries) {
    if (name in options) {
      errors.push(`${name} is set twice.`);
      continue;
    }
    const plain = parsePlainLiteral(expr);
    if (plain !== null) options[name] = plain;
    // A secret's raw text would be stored in the clear until evaluated.
    else if (isSecretOption(name, specs)) errors.push(`${name} is secret: give it a plain 'string' value.`);
    else pending.push(`${name} ${expr}`);
  }
  const named = new Set([...Object.keys(options), ...entries.map((e) => e.name)].map((n) => n.toLowerCase()));
  for (const spec of specs) {
    if (spec.required && !named.has(spec.name.toLowerCase())) errors.push(`${spec.name} is required.`);
  }
  return { options, rawOptions: pending.join(", "), errors };
}

/** The input to render for a declared option. */
export type FieldKind = "secret" | "boolean" | "integer" | "number" | "date" | "text";

export function fieldKind(spec: OptionSpecInfo): FieldKind {
  if (spec.secret) return "secret";
  const t = spec.duckdbType.toUpperCase();
  if (t === "BOOLEAN") return "boolean";
  if (/^(?:U?(?:TINY|SMALL|BIG|HUGE)?INT(?:EGER)?|U?INTEGER)$/.test(t)) return "integer";
  if (/^(?:FLOAT|DOUBLE|REAL|DECIMAL)/.test(t)) return "number";
  if (t === "DATE") return "date";
  return "text";
}

/** A hint at the DuckDB text form a field expects. */
export function fieldPlaceholder(spec: OptionSpecInfo): string {
  if (spec.defaultText != null) return `default: ${spec.defaultText}`;
  const t = spec.duckdbType.toUpperCase();
  if (t.endsWith("[]")) return "[1, 2, 3]";
  if (t.startsWith("STRUCT")) return "{'a': 1}";
  if (t.startsWith("MAP")) return "{'key': 'value'}";
  if (t.startsWith("TIMESTAMP")) return "2026-01-31 12:00:00";
  if (t.startsWith("INTERVAL")) return "1 day";
  return spec.duckdbType;
}

/** The control the workspace manager's options grid renders for a declared
 *  option (richer than `fieldKind`, which the plain forms use):
 *  - `secret`: masked, with a reveal toggle; stored in the secret store.
 *  - `switch`: BOOLEAN.
 *  - `integer` / `number`: a number input (integers step by 1).
 *  - `date`: a date input (DATE's text form is ISO `YYYY-MM-DD`).
 *  - `text`: VARCHAR and other scalar types typed as text (TIME, UUID, …).
 *  - `duckdb`: nested and structured types (LIST, STRUCT, MAP, arrays,
 *    INTERVAL, TIMESTAMP…), a text input that takes DuckDB's own literal
 *    syntax, e.g. `[1, 2]` or `{'a': 1}`. The value is still stored as text
 *    and cast by the extension; nothing in it runs as SQL. */
export type OptionInputKind = "secret" | "switch" | "integer" | "number" | "date" | "text" | "duckdb";

export function optionInputKind(spec: OptionSpecInfo): OptionInputKind {
  const kind = fieldKind(spec);
  if (kind === "boolean") return "switch";
  if (kind !== "text") return kind;
  const t = spec.duckdbType.toUpperCase().trim();
  if (/^(?:VARCHAR|TEXT|STRING|CHAR|BPCHAR|UUID|BLOB|BIT|TIME|TIMETZ|TIME WITH TIME ZONE|JSON)$/.test(t)) return "text";
  return "duckdb";
}

/** The rows of an options form: the server's declared options, plus a masked
 *  row for a stored secret it does not declare and a text row for any other
 *  stored option, so nothing stored is invisible (or silently dropped on save). */
export function optionRows(specs: readonly OptionSpecInfo[], values: Record<string, string>): OptionSpecInfo[] {
  const declared = new Set(specs.map((s) => s.name.toLowerCase()));
  const extra = Object.keys(values).filter((name) => !declared.has(name.toLowerCase())).map((name): OptionSpecInfo => ({
    name,
    description: isSecretOption(name) ? "A stored secret this server does not declare." : "Stored option this server does not declare.",
    duckdbType: "VARCHAR",
    castType: "VARCHAR",
    arrowType: "Utf8",
    required: false,
    secret: isSecretOption(name),
  }));
  return [...specs, ...extra];
}

/** The SQL tab's text for a catalog's options: the non-secret values as
 *  `name 'text'` pairs (always string literals, through the one quoting
 *  builder), then any raw text still awaiting evaluation. Secrets are left
 *  out: the tab is for text people copy around, and they are edited in the
 *  masked fields only. */
export function optionsToSqlText(
  values: Record<string, string>,
  rawOptions: string,
  specs: readonly OptionSpecInfo[] = [],
): string {
  const set = Object.fromEntries(Object.entries(values).filter(([name, v]) => v !== "" && isValidOptionName(name)));
  const plain = formatOptionList(partitionSecrets(set, specs).plain);
  return [plain, rawOptions.trim()].filter(Boolean).join(", ");
}

/** Read the SQL tab back. The text goes through the same legacy parser as a
 *  URL (`collectFormOptions`): plain literals become values, anything else is
 *  kept as raw text that is evaluated, against the constant-only allowlist,
 *  before ATTACH. It is never spliced into a statement. Secret values come
 *  from `secretValues` (the masked fields), and a secret named in the text is
 *  refused unless it is a plain string. */
export function sqlTextToOptions(
  text: string,
  secretValues: Record<string, string>,
  specs: readonly OptionSpecInfo[],
): CollectedOptions & { values: Record<string, string> } {
  const collected = collectFormOptions(secretValues, text, specs);
  return { ...collected, values: { ...collected.options } };
}
