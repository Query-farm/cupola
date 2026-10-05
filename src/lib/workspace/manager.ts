/**
 * The pure logic behind the workspace manager (multi-catalog phase 3,
 * `components/workspace/WorkspaceManager.tsx`): catalog reordering, the
 * one-default invariant, alias validation as the reader types, a catalog's
 * edit draft, and how a Test connection result reads.
 *
 * No React, no storage: unit-tested in tests/unit/workspace-manager.test.ts.
 */
import { aliasProblem } from "./aliases";

// ---------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------

/** `ids` with `id` moved to `index` (clamped). Unknown ids leave it as is. */
export function moveTo(ids: readonly string[], id: string, index: number): string[] {
  const from = ids.indexOf(id);
  if (from < 0) return [...ids];
  const next = ids.filter((x) => x !== id);
  next.splice(Math.max(0, Math.min(next.length, index)), 0, id);
  return next;
}

/** `ids` with `id` moved `delta` places (Move up is -1, Move down +1). */
export function moveBy(ids: readonly string[], id: string, delta: number): string[] {
  const from = ids.indexOf(id);
  return from < 0 ? [...ids] : moveTo(ids, id, from + delta);
}

/** Where a drag lands: `dragged` dropped before or after `target`. */
export function dropOnto(ids: readonly string[], dragged: string, target: string, position: "before" | "after"): string[] {
  if (dragged === target || !ids.includes(dragged) || !ids.includes(target)) return [...ids];
  const without = ids.filter((x) => x !== dragged);
  const at = without.indexOf(target) + (position === "after" ? 1 : 0);
  without.splice(at, 0, dragged);
  return without;
}

/** "Moved sales to position 2 of 3." for the live region. */
export function moveAnnouncement(alias: string, ids: readonly string[], id: string): string {
  return `Moved ${alias} to position ${ids.indexOf(id) + 1} of ${ids.length}.`;
}

// ---------------------------------------------------------------------------
// The default catalog
// ---------------------------------------------------------------------------

/** The default after a change: the requested one if it is still a catalog,
 *  else the first. Exactly one when there are catalogs, none when there are
 *  none, which is the invariant the store keeps and the radio group shows. */
export function resolveDefault(ids: readonly string[], requested: string | null | undefined): string | null {
  if (requested && ids.includes(requested)) return requested;
  return ids[0] ?? null;
}

/** What removing `id` does to the default: it moves to the first remaining
 *  catalog when `id` was the default. */
export function defaultAfterRemove(ids: readonly string[], currentDefault: string | null, id: string): string | null {
  const rest = ids.filter((x) => x !== id);
  return resolveDefault(rest, currentDefault === id ? null : currentDefault);
}

// ---------------------------------------------------------------------------
// Aliases
// ---------------------------------------------------------------------------

export interface AliasHolder {
  id: string;
  alias: string;
}

/** Why `alias` cannot be this catalog's, or null: an identifier, not
 *  reserved, unique (case-insensitively) among the workspace's other
 *  catalogs. Its own current alias never counts as taken. */
export function aliasEditProblem(alias: string, catalogId: string, catalogs: readonly AliasHolder[]): string | null {
  const taken = catalogs.filter((c) => c.id !== catalogId && c.alias).map((c) => c.alias);
  return aliasProblem(alias.trim(), taken);
}

// ---------------------------------------------------------------------------
// A catalog's edit draft
// ---------------------------------------------------------------------------

/** The connection fields of one catalog being edited. They are saved
 *  together (Save, or Save and re-attach for the open workspace), never per
 *  keystroke: a URL or alias half typed must not re-attach anything. */
export interface CatalogDraft {
  alias: string;
  url: string;
  target: string;
  /** Option name → DuckDB text, secrets included. */
  values: Record<string, string>;
  /** Raw text awaiting evaluation. */
  raw: string;
  /** The SQL tab's text, when that tab was last edited. */
  sqlText: string | null;
}

export interface DraftSource {
  alias: string;
  url: string;
  target?: string;
  options: Record<string, string>;
  rawOptions?: string;
}

export function draftOf(catalog: DraftSource, secrets: Record<string, string>): CatalogDraft {
  return {
    alias: catalog.alias,
    url: catalog.url,
    target: catalog.target ?? "",
    values: { ...catalog.options, ...secrets },
    raw: catalog.rawOptions ?? "",
    sqlText: null,
  };
}

function sameRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const clean = (r: Record<string, string>) => Object.entries(r).filter(([, v]) => v !== "").sort(([x], [y]) => x.localeCompare(y));
  return JSON.stringify(clean(a)) === JSON.stringify(clean(b));
}

/** Which parts of a draft differ from what is stored. */
export function draftChanges(draft: CatalogDraft, stored: CatalogDraft): { alias: boolean; url: boolean; target: boolean; options: boolean; any: boolean } {
  const alias = draft.alias.trim() !== stored.alias;
  const url = draft.url.trim() !== stored.url;
  const target = draft.target.trim() !== stored.target;
  const options = draft.sqlText !== null || !sameRecord(draft.values, stored.values) || draft.raw.trim() !== stored.raw.trim();
  return { alias, url, target, options, any: alias || url || target || options };
}

const SERVICE_URL = /^(?:https?|grainlift(?:\+(?:https?|iroh))?):\/\/\S+$/i;

/** Why a catalog URL cannot be saved, or null. */
export function urlProblem(url: string): string | null {
  const t = url.trim();
  if (!t) return "A URL is required.";
  return SERVICE_URL.test(t) ? null : "Enter an http(s) or grainlift URL.";
}

// ---------------------------------------------------------------------------
// Test connection
// ---------------------------------------------------------------------------

export type ConnectionTest =
  | { ok: true; latencyMs: number; catalogFound: boolean; catalogs: string[]; schemaCount: number | null; schemaNote?: string }
  | { ok: false; latencyMs: number; error: string; signInRequired: boolean };

/** The one line a Test connection result shows (beside an icon: the status
 *  is never colour alone). */
export function describeConnectionTest(result: ConnectionTest, catalogName: string): string {
  const ms = `${Math.max(0, Math.round(result.latencyMs))} ms`;
  if (!result.ok) {
    return result.signInRequired ? `Needs sign-in (${ms}): ${result.error}` : `Failed after ${ms}: ${result.error}`;
  }
  if (!result.catalogFound) {
    const listed = result.catalogs.length ? result.catalogs.join(", ") : "none";
    return `Reachable in ${ms}, but it has no catalog named "${catalogName}" (it lists: ${listed}).`;
  }
  const schemas = result.schemaCount === null
    ? result.schemaNote ?? "schemas not counted"
    : `${result.schemaCount} ${result.schemaCount === 1 ? "schema" : "schemas"}`;
  return `Connected in ${ms} · ${schemas}`;
}

// ---------------------------------------------------------------------------
// Workspace names
// ---------------------------------------------------------------------------

/** A name the reader typed, or null for untitled. */
export function normalizeWorkspaceName(name: string): string | null {
  const t = name.trim();
  return t ? t.slice(0, 200) : null;
}

/** Palette names, in `--catalog-chip-N` order (Okabe-Ito hues), for labels:
 *  a swatch is never identified by its colour alone. */
export const PALETTE_NAMES: readonly string[] = ["Blue", "Orange", "Green", "Pink", "Sky blue", "Vermilion", "Yellow", "Grey"];
