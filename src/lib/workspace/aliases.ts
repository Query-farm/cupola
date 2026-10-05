/**
 * Catalog aliases: the DuckDB database name each attached catalog gets, and
 * therefore the SQL contract (`alias.schema.table`) every report, editor tab
 * and AI answer is written against.
 *
 * Rules (docs/multi-catalog.md, "Aliases"):
 * - The default alias is the server's catalog name.
 * - An alias is a plain SQL identifier (`^[A-Za-z_][A-Za-z0-9_]*$`).
 * - `memory`, `temp`, `system` and `main` are reserved: DuckDB owns the first
 *   three, and `main` is the schema name every catalog has, so `main.x` would
 *   be ambiguous.
 * - Aliases are unique within a workspace. DuckDB identifiers are
 *   case-insensitive, so `Sales` and `sales` collide.
 * - On a collision the alias gets `_2`, `_3`, … appended. This is computed ONCE,
 *   when the catalog list is constructed, and the result is kept: recomputing
 *   on every load would let an alias change when the catalog order changes,
 *   silently breaking every query written against it.
 *
 * Pure: unit-tested in tests/unit/workspace.test.ts.
 */

export const RESERVED_ALIASES: readonly string[] = ["memory", "temp", "system", "main"];

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** DuckDB truncates identifiers past 63 bytes in some paths; stay under it. */
export const MAX_ALIAS_LENGTH = 63;

export function isReservedAlias(alias: string): boolean {
  return RESERVED_ALIASES.includes(alias.toLowerCase());
}

/** A usable alias: a plain identifier, not too long, not reserved. */
export function isValidAlias(alias: string): boolean {
  return IDENTIFIER.test(alias) && alias.length <= MAX_ALIAS_LENGTH && !isReservedAlias(alias);
}

/** Turn any text into a plain identifier: other characters become `_`, a
 *  leading digit gets a `_` prefix, and empty text becomes `catalog`. A
 *  reserved name is left as is; de-duplication moves it on. */
export function sanitizeAlias(raw: string): string {
  let alias = raw.trim().replace(/[^A-Za-z0-9_]/g, "_");
  if (!alias || /^_+$/.test(alias)) alias = "catalog";
  if (/^[0-9]/.test(alias)) alias = `_${alias}`;
  return alias.slice(0, MAX_ALIAS_LENGTH);
}

/** The first of `base`, `base_2`, `base_3`, … not in `taken` (lower-cased),
 *  trimming `base` so the suffix still fits. */
export function uniqueAlias(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const suffix = `_${n}`;
    const candidate = `${base.slice(0, MAX_ALIAS_LENGTH - suffix.length)}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

export interface AliasRequest {
  /** The alias asked for, if any. */
  alias?: string | null;
  /** The catalog's name on the server: the alias when none is asked for. */
  catalogName: string;
}

export interface AliasAssignment {
  aliases: string[];
  /** One line per alias that differs from what was asked for. */
  notes: string[];
}

/** Assign an alias to each catalog, in order. Reserved names count as taken,
 *  so a catalog named `memory` becomes `memory_2`. */
export function assignAliases(requests: readonly AliasRequest[], alreadyTaken: Iterable<string> = []): AliasAssignment {
  const taken = new Set<string>([...RESERVED_ALIASES, ...[...alreadyTaken].map((a) => a.toLowerCase())]);
  const aliases: string[] = [];
  const notes: string[] = [];
  for (const request of requests) {
    const asked = request.alias?.trim() || "";
    const base = asked && IDENTIFIER.test(asked) && asked.length <= MAX_ALIAS_LENGTH ? asked : sanitizeAlias(asked || request.catalogName);
    const alias = uniqueAlias(base, taken);
    taken.add(alias.toLowerCase());
    aliases.push(alias);
    const wanted = asked || request.catalogName;
    if (alias !== wanted) {
      notes.push(isReservedAlias(base)
        ? `"${wanted}" is a reserved name in DuckDB; attached as "${alias}".`
        : alias !== base
          ? `"${wanted}" is already used by another catalog; attached as "${alias}".`
          : `"${wanted}" is not a plain SQL identifier; attached as "${alias}".`);
    }
  }
  return { aliases, notes };
}

/** The alias for a `?service=` catalog. That contract is frozen: the alias is
 *  the server's catalog name exactly as it always was, because saved reports
 *  and queries reference it. Only a name DuckDB cannot attach under (empty or
 *  reserved) is moved. */
export function serviceAlias(catalogName: string): string {
  if (!catalogName.trim()) return "catalog";
  return isReservedAlias(catalogName) ? uniqueAlias(catalogName, new Set(RESERVED_ALIASES)) : catalogName;
}
