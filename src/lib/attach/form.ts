/**
 * The options form's submit logic, kept out of the component so it is
 * unit-tested: typed fields (one per declared option) plus a raw-text
 * fallback, which goes through the same legacy parser as a URL.
 */
import { parsePlainLiteral, splitLegacyOptions } from "./legacy-options";
import { isSecretOption, isValidOptionName, type OptionSpecInfo } from "./options";

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
