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

// ── Canonical reserved keys ────────────────────────────────────────────────
export const TAG_DOC_LLM = "vgi.doc_llm";
export const TAG_DOC_MD = "vgi.doc_md";
export const TAG_RESULT_COLUMNS_MD = "vgi.result_columns_md";
export const TAG_DOC_LINKS = "vgi.doc_links";
export const TAG_TITLE = "vgi.title";
export const TAG_KEYWORDS = "vgi.keywords";
export const TAG_CATEGORY = "vgi.category";
export const TAG_CATEGORIES = "vgi.categories";
export const TAG_CLASSIFICATION_TAGS = "vgi.classification_tags";
export const TAG_EXAMPLE_QUERIES = "vgi.example_queries";
export const TAG_EXECUTABLE_EXAMPLES = "vgi.executable_examples";
export const TAG_AGENT_TEST_TASKS = "vgi.agent_test_tasks";
export const TAG_SOURCE_URL = "vgi.source_url";
export const TAG_AUTHOR = "vgi.author";
export const TAG_COPYRIGHT = "vgi.copyright";
export const TAG_LICENSE = "vgi.license";
export const TAG_SUPPORT_CONTACT = "vgi.support_contact";
export const TAG_SUPPORT_POLICY_URL = "vgi.support_policy_url";

// ── Deprecated keys (older workers still emit these; §8) ───────────────────
export const TAG_DESCRIPTION_LLM = "vgi.description_llm";
export const TAG_DESCRIPTION_MD = "vgi.description_md";
export const TAG_COLUMNS_MD = "vgi.columns_md";
export const TAG_CATEGORY_TAGS = "vgi.category_tags";

/** Canonical key → its deprecated alias, for read-time fallback. */
const DEPRECATED_ALIASES: Record<string, string> = {
  [TAG_DOC_LLM]: TAG_DESCRIPTION_LLM,
  [TAG_DOC_MD]: TAG_DESCRIPTION_MD,
  [TAG_RESULT_COLUMNS_MD]: TAG_COLUMNS_MD,
  [TAG_CLASSIFICATION_TAGS]: TAG_CATEGORY_TAGS,
};

/** All reserved keys (canonical + deprecated) — hidden from the raw TagsTable. */
export const RESERVED_TAG_KEYS: ReadonlySet<string> = new Set([
  TAG_DOC_LLM, TAG_DOC_MD, TAG_RESULT_COLUMNS_MD, TAG_DOC_LINKS, TAG_TITLE,
  TAG_KEYWORDS, TAG_CATEGORY, TAG_CATEGORIES, TAG_CLASSIFICATION_TAGS,
  TAG_EXAMPLE_QUERIES, TAG_EXECUTABLE_EXAMPLES, TAG_AGENT_TEST_TASKS,
  TAG_SOURCE_URL, TAG_AUTHOR, TAG_COPYRIGHT, TAG_LICENSE,
  TAG_SUPPORT_CONTACT, TAG_SUPPORT_POLICY_URL,
  TAG_DESCRIPTION_LLM, TAG_DESCRIPTION_MD, TAG_COLUMNS_MD, TAG_CATEGORY_TAGS,
]);

type Tags = Record<string, string> | null | undefined;

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
const AI_DROP_KEYS: ReadonlySet<string> = new Set([
  TAG_DOC_MD, TAG_DESCRIPTION_MD,
  TAG_EXAMPLE_QUERIES, TAG_EXECUTABLE_EXAMPLES,
  TAG_AGENT_TEST_TASKS,
  TAG_DOC_LINKS,
  TAG_SOURCE_URL, TAG_AUTHOR, TAG_COPYRIGHT, TAG_LICENSE,
  TAG_SUPPORT_CONTACT, TAG_SUPPORT_POLICY_URL,
]);

/** Filter tags for AI agent tool output. See {@link AI_DROP_KEYS}. */
export function filterTagsForAI(tags?: Record<string, string> | null): Record<string, string> | undefined {
  if (!tags) return undefined;
  const filtered: Record<string, string> = {};
  for (const [k, v] of Object.entries(tags)) {
    if (!AI_DROP_KEYS.has(k)) filtered[k] = v;
  }
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}
