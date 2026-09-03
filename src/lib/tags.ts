/**
 * VGI metadata tag vocabulary and helpers.
 *
 * Implements the reserved `vgi.*` tag standard defined in vgi-lint-check's
 * TAGS.md. Reserved tags carry structured docs/discovery metadata; a worker may
 * still emit a handful of *deprecated* key names (§8 of the standard), so all
 * reads go through `getTag`, which resolves a canonical key and transparently
 * falls back to its deprecated alias. JSON-valued tags are stored as JSON
 * strings and decoded *defensively* — a malformed value yields an empty result,
 * never a throw.
 */
import contract from "./vgi-tag-contract.json";

type ContractEntry = { symbol: string; key: string; canonical?: string };
const CONTRACT_ENTRIES: ContractEntry[] = [
  ...contract.tags,
  ...contract.aliases,
  ...contract.retired,
  ...contract.extension_tags,
];
const CONTRACT_VALUES = new Map(CONTRACT_ENTRIES.map((entry) => [entry.symbol, entry.key]));
function tagValue(symbol: string): string {
  const value = CONTRACT_VALUES.get(symbol);
  if (!value) throw new Error(`VGI tag contract is missing ${symbol}`);
  return value;
}

export const TAG_CONTRACT_REVISION = contract.contract_revision;

// ── Canonical reserved keys ────────────────────────────────────────────────
export const TAG_DOC_LLM = tagValue("TAG_DOC_LLM");
export const TAG_DOC_MD = tagValue("TAG_DOC_MD");
export const TAG_DOC_LINKS = tagValue("TAG_DOC_LINKS");
export const TAG_TITLE = tagValue("TAG_TITLE");
export const TAG_KEYWORDS = tagValue("TAG_KEYWORDS");
export const TAG_CATEGORY = tagValue("TAG_CATEGORY");
export const TAG_CATEGORIES = tagValue("TAG_CATEGORIES");
export const TAG_CLASSIFICATION_TAGS = tagValue("TAG_CLASSIFICATION_TAGS");
export const TAG_EXAMPLE_QUERIES = tagValue("TAG_EXAMPLE_QUERIES");
export const TAG_EXECUTABLE_EXAMPLES = tagValue("TAG_EXECUTABLE_EXAMPLES");
export const TAG_AGENT_TEST_TASKS = tagValue("TAG_AGENT_TEST_TASKS");
export const TAG_RESULT_COLUMNS_SCHEMA = tagValue("TAG_RESULT_COLUMNS_SCHEMA");
export const TAG_RESULT_DYNAMIC_COLUMNS_MD = tagValue("TAG_RESULT_DYNAMIC_COLUMNS_MD");
export const TAG_SOURCE_URL = tagValue("TAG_SOURCE_URL");
export const TAG_AUTHOR = tagValue("TAG_AUTHOR");
export const TAG_COPYRIGHT = tagValue("TAG_COPYRIGHT");
export const TAG_LICENSE = tagValue("TAG_LICENSE");
export const TAG_SUPPORT_CONTACT = tagValue("TAG_SUPPORT_CONTACT");
export const TAG_SUPPORT_POLICY_URL = tagValue("TAG_SUPPORT_POLICY_URL");
export const TAG_ICON_URL = tagValue("TAG_ICON_URL");
export const TAG_REQUIRED_FILTERS = tagValue("TAG_REQUIRED_FILTERS");

// ── Deprecated keys (older workers still emit these; §8) ───────────────────
export const TAG_DESCRIPTION_LLM = tagValue("TAG_DESCRIPTION_LLM");
export const TAG_DESCRIPTION_MD = tagValue("TAG_DESCRIPTION_MD");
export const TAG_CATEGORY_TAGS = tagValue("TAG_CATEGORY_TAGS");
export const TAG_RESULT_COLUMNS_MD = tagValue("TAG_RESULT_COLUMNS_MD");
export const TAG_COLUMNS_MD = tagValue("TAG_COLUMNS_MD");

/** Canonical key → its deprecated alias, for read-time fallback. */
const DEPRECATED_ALIASES: Record<string, string> = Object.fromEntries(
  contract.aliases.map((entry) => [entry.canonical, entry.key]),
);

/** All reserved keys (canonical + deprecated) — hidden from the raw TagsTable. */
export const RESERVED_TAG_KEYS: ReadonlySet<string> = new Set(
  [...contract.tags, ...contract.aliases, ...contract.retired].map((entry) => entry.key),
);

type Tags = Record<string, string> | null | undefined;

/** Normalize DuckDB MAP values returned as objects, Maps, or Arrow entry lists. */
export function normalizeTags(value: unknown): Record<string, string> {
  if (value == null) return {};
  if (value instanceof Map) {
    return Object.fromEntries([...value.entries()].map(([k, v]) => [String(k), String(v)]));
  }
  if (Array.isArray(value)) {
    const entries = value.flatMap((item): [string, string][] => {
      if (Array.isArray(item) && item.length >= 2) return [[String(item[0]), String(item[1])]];
      if (item && typeof item === "object" && "key" in item && "value" in item) {
        const pair = item as { key: unknown; value: unknown };
        return [[String(pair.key), String(pair.value)]];
      }
      return [];
    });
    return Object.fromEntries(entries);
  }
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, String(v)]));
  }
  return {};
}

/**
 * Read a reserved tag by its canonical key, falling back to the deprecated
 * alias when the canonical key is absent/blank. Returns the trimmed value, or
 * `undefined` when missing or blank (reserved tags must never be empty).
 */
export function getTag(tags: Tags, canonicalKey: string): string | undefined {
  if (!tags) return undefined;
  let v = tags[canonicalKey];
  if ((v == null || v.trim() === "") && DEPRECATED_ALIASES[canonicalKey]) {
    v = tags[DEPRECATED_ALIASES[canonicalKey]];
  }
  if (v == null) return undefined;
  const trimmed = v.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Parse a JSON-valued tag defensively. Malformed/absent → `null`. */
function parseJsonTag(tags: Tags, key: string): unknown {
  const raw = getTag(tags, key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** A JSON array-of-strings tag (`vgi.keywords`, `vgi.classification_tags`). */
function parseStringArrayTag(tags: Tags, key: string): string[] {
  const parsed = parseJsonTag(tags, key);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((x): x is string => typeof x === "string" && x.trim() !== "")
    .map((s) => s.trim());
}

export const parseKeywords = (tags: Tags): string[] => parseStringArrayTag(tags, TAG_KEYWORDS);
export const parseClassificationTags = (tags: Tags): string[] =>
  parseStringArrayTag(tags, TAG_CLASSIFICATION_TAGS);

export interface DocLink {
  title?: string;
  url: string;
}

/** `vgi.doc_links`: JSON array of URL strings or `{title?, url}` objects. */
export function parseDocLinks(tags: Tags): DocLink[] {
  const parsed = parseJsonTag(tags, TAG_DOC_LINKS);
  if (!Array.isArray(parsed)) return [];
  const out: DocLink[] = [];
  for (const item of parsed) {
    if (typeof item === "string") {
      if (item.trim()) out.push({ url: item.trim() });
    } else if (item && typeof item === "object" && typeof (item as any).url === "string") {
      const url = (item as any).url.trim();
      if (!url) continue;
      const title = (item as any).title;
      out.push({ url, title: typeof title === "string" && title.trim() ? title.trim() : undefined });
    }
  }
  return out;
}

export interface CategoryDef {
  name: string;
  title?: string;
  description?: string;
  keywords?: string[];
  doc_md?: string;
}

/** `vgi.categories`: an *ordered* registry of category definitions (schema-level). */
export function parseCategories(tags: Tags): CategoryDef[] {
  const parsed = parseJsonTag(tags, TAG_CATEGORIES);
  if (!Array.isArray(parsed)) return [];
  const out: CategoryDef[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const name = typeof (item as any).name === "string" ? (item as any).name.trim() : "";
    if (!name) continue;
    const o = item as any;
    out.push({
      name,
      title: typeof o.title === "string" && o.title.trim() ? o.title.trim() : undefined,
      description: typeof o.description === "string" && o.description.trim() ? o.description.trim() : undefined,
      keywords: Array.isArray(o.keywords) ? o.keywords.filter((k: any) => typeof k === "string") : undefined,
      doc_md: typeof o.doc_md === "string" && o.doc_md.trim() ? o.doc_md.trim() : undefined,
    });
  }
  return out;
}

/** Display label for a category: its `title`, else a title-cased `name`. */
export function categoryTitle(def: CategoryDef): string {
  return def.title || titleCase(def.name);
}

export interface NormalizedExample {
  name?: string;
  description?: string;
  sql: string;
}

/** Flatten an executable-example `sql` (string | string[] | step[]) to one block. */
function flattenExecutableSql(sql: unknown): string {
  if (typeof sql === "string") return sql;
  if (Array.isArray(sql)) {
    return sql
      .map((s) =>
        typeof s === "string"
          ? s
          : s && typeof s === "object" && typeof (s as any).sql === "string"
            ? (s as any).sql
            : "",
      )
      .filter(Boolean)
      .join(";\n\n");
  }
  return "";
}

/**
 * `vgi.executable_examples`: normalized to the `{name?, description?, sql}`
 * shape the ExampleQueries component renders. Step sequences are flattened into
 * a single SQL block. `expected_result` / grader fields are intentionally dropped.
 */
export function parseExecutableExamples(tags: Tags): NormalizedExample[] {
  const parsed = parseJsonTag(tags, TAG_EXECUTABLE_EXAMPLES);
  if (!Array.isArray(parsed)) return [];
  const out: NormalizedExample[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const o = item as any;
    const sql = flattenExecutableSql(o.sql);
    if (!sql.trim()) continue;
    out.push({
      name: typeof o.name === "string" && o.name.trim() ? o.name.trim() : undefined,
      description: typeof o.description === "string" && o.description.trim() ? o.description.trim() : undefined,
      sql,
    });
  }
  return out;
}

export interface CategorizedGroup<T> {
  /** The registry entry, or `null` for the trailing "Uncategorized" bucket. */
  def: CategoryDef | null;
  items: T[];
}

/**
 * Group objects under a schema's category registry, in registry order.
 *
 * Returns `null` — a signal for the caller to fall back to its default
 * (kind-grouped) layout — when there is no registry or when *no* object
 * references a registry category (a non-compliant/legacy schema). Otherwise
 * returns the non-empty category groups in registry order, with any
 * uncategorized objects in a trailing `def: null` group.
 */
export function groupByCategory<T>(
  items: T[],
  getCategory: (item: T) => string | undefined,
  registry: CategoryDef[],
): CategorizedGroup<T>[] | null {
  if (registry.length === 0) return null;
  const byName = new Map<string, T[]>();
  for (const def of registry) byName.set(def.name, []);
  const uncategorized: T[] = [];
  let anyCategorized = false;
  for (const item of items) {
    const cat = getCategory(item);
    if (cat && byName.has(cat)) {
      byName.get(cat)!.push(item);
      anyCategorized = true;
    } else {
      uncategorized.push(item);
    }
  }
  if (!anyCategorized) return null;
  const groups: CategorizedGroup<T>[] = registry
    .map((def) => ({ def, items: byName.get(def.name) || [] }))
    .filter((g) => g.items.length > 0);
  if (uncategorized.length) groups.push({ def: null, items: uncategorized });
  return groups;
}

/** Title-case a lowercase slug: `trading_calendars` → `Trading Calendars`. */
function titleCase(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// ── Display / AI filtering ─────────────────────────────────────────────────

/**
 * Strip every reserved `vgi.*` tag (canonical + deprecated) so the raw TagsTable
 * shows only free-form keys (`domain`, `provider`, `topic`, custom). Reserved
 * tags all have dedicated rendering elsewhere.
 */
export function filterDisplayTags(tags?: Record<string, string> | null): Record<string, string> | null {
  if (!tags) return null;
  const filtered: Record<string, string> = {};
  for (const [k, v] of Object.entries(tags)) {
    if (!RESERVED_TAG_KEYS.has(k)) filtered[k] = v;
  }
  return Object.keys(filtered).length > 0 ? filtered : null;
}

/**
 * Reserved tags excluded from AI tool output. Heavy human docs, example bodies,
 * provenance, and (critically) the grader-only `vgi.agent_test_tasks` are
 * dropped; the LLM discovery signals (`vgi.doc_llm`, keywords, category,
 * classification tags, title) and all free-form tags are kept.
 */
const AI_ALWAYS_DROP_KEYS: ReadonlySet<string> = new Set([
  TAG_AGENT_TEST_TASKS,
  TAG_SOURCE_URL, TAG_AUTHOR, TAG_COPYRIGHT, TAG_LICENSE,
  TAG_SUPPORT_CONTACT, TAG_SUPPORT_POLICY_URL,
]);
const AI_LISTING_DROP_KEYS: ReadonlySet<string> = new Set([
  TAG_DOC_MD, TAG_DESCRIPTION_MD,
  TAG_EXAMPLE_QUERIES, TAG_EXECUTABLE_EXAMPLES,
  TAG_DOC_LINKS,
]);

export const CATALOG_DOC_CHAR_LIMIT = 8_000;
export const LISTING_TAG_VALUE_CHAR_LIMIT = 500;
export const DETAIL_TAG_VALUE_CHAR_LIMIT = 4_000;
export const MAX_AI_EXAMPLES = 5;

function filterTags(
  tags: Record<string, string> | null | undefined,
  drop: ReadonlySet<string>,
  valueLimit: number,
): Record<string, string> | undefined {
  if (!tags) return undefined;
  const filtered: Record<string, string> = {};
  for (const [k, v] of Object.entries(tags)) {
    if (!AI_ALWAYS_DROP_KEYS.has(k) && !drop.has(k)) {
      filtered[k] = v.length > valueLimit ? `${v.slice(0, valueLimit)}… [truncated]` : v;
    }
  }
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

/** Compact discovery metadata for list tools and prompt inventories. */
export function filterTagsForAI(tags?: Record<string, string> | null): Record<string, string> | undefined {
  return filterTags(tags, AI_LISTING_DROP_KEYS, LISTING_TAG_VALUE_CHAR_LIMIT);
}

/** Rich, bounded metadata for describe tools. Private agent graders never leave the database. */
export function filterTagsForAIDetail(tags?: Record<string, string> | null): Record<string, string> | undefined {
  return filterTags(tags, new Set(), DETAIL_TAG_VALUE_CHAR_LIMIT);
}
