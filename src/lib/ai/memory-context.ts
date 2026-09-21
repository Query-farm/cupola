/**
 * Memory-catalog drift, expressed as a message the agent reads AFTER the
 * cached prefix.
 *
 * The chat surface used to rebuild the whole system prompt on every user turn,
 * which meant the agent's own work invalidated its cache: the prompt tells the
 * model to `CREATE TABLE memory.main.…`, `run_sql` refreshes `ui.memoryCatalog`
 * when it does, and the next turn's `buildSystemPrompt` then rendered a
 * different object inventory. `system` renders ahead of every message, so a
 * changed byte there drops BOTH the system cache and the entire accumulated
 * conversation — the agent paid full input price for its own success.
 *
 * The system prompt is now frozen for the life of a conversation and the drift
 * rides here instead, appended to the user turn. That position is after the
 * cached prefix, so it invalidates nothing, and because each note stays in
 * history unedited the transcript remains append-only (a later rewrite would
 * reintroduce exactly the invalidation this avoids).
 *
 * Pure — no service / VGI-RPC imports beyond the type, so it unit-tests without
 * the RPC graph (same rationale as ./ai-history and ./query-results).
 */

import type { CatalogData } from "../service";

/** Fully-qualified names of every table and view in a catalog, sorted.
 *
 *  Sorted because the note is compared against the previous turn's list and
 *  then sent to the model: catalog order is whatever DuckDB's introspection
 *  returned, and an unsorted list would report spurious drift (and, once it
 *  reached the prompt, differ byte-for-byte between otherwise identical
 *  states). */
export function memoryObjectNames(catalog: CatalogData | null | undefined): string[] {
  if (!catalog) return [];
  const names: string[] = [];
  for (const schema of catalog.schemas) {
    const prefix = `${catalog.catalogName}.${schema.info.name}`;
    for (const table of schema.tables) names.push(`${prefix}.${table.name}`);
    for (const view of schema.views) names.push(`${prefix}.${view.name}`);
  }
  return names.sort();
}

/**
 * A short note describing what changed since the system prompt was written, or
 * null when nothing did (the common case — no note, no tokens).
 *
 * Both arguments come from `memoryObjectNames`, so both are sorted.
 */
export function memoryContextNote(previous: string[], current: string[]): string | null {
  const previousSet = new Set(previous);
  const currentSet = new Set(current);
  const added = current.filter((name) => !previousSet.has(name));
  const removed = previous.filter((name) => !currentSet.has(name));
  if (added.length === 0 && removed.length === 0) return null;

  const lines = ["[Memory catalog changed since the system prompt above was written]"];
  if (added.length) lines.push(`Now present: ${added.join(", ")}`);
  if (removed.length) lines.push(`No longer present: ${removed.join(", ")}`);
  lines.push("The inventory in the system prompt is stale for the memory catalog only; call describe_table before querying any of these.");
  return lines.join("\n");
}
