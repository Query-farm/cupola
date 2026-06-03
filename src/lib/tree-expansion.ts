/**
 * Pure, DOM-free logic for the sidebar tree's expand/collapse state.
 *
 * Expansion is modeled as a single `Set<string>` of expanded node ids — the one
 * source of truth consumed by `TreeView`. Keeping this logic separate from the
 * React component makes it exhaustively unit-testable and removes the previous
 * triple-bookkeeping (per-node accordion state, a derived id list, and a shadow
 * ref) that let a node re-expand in the same tick it was collapsed.
 */

import type { TreeDataItem } from "./tree";

/**
 * Returns the ids of every ancestor of `targetId`, **excluding the target
 * itself**. Order is root-first. Returns `[]` if the target is a root node or
 * is not found.
 *
 * Excluding the target is deliberate: revealing a node only needs its ancestors
 * expanded so it becomes visible — forcing the node's own expansion is what
 * previously fought a user's click to collapse it.
 */
export function collectAncestorIds(
  data: TreeDataItem[],
  targetId: string,
): string[] {
  const path: string[] = [];

  function walk(items: TreeDataItem[], ancestors: string[]): boolean {
    for (const item of items) {
      if (item.id === targetId) {
        path.push(...ancestors);
        return true;
      }
      if (item.children?.length) {
        if (walk(item.children, [...ancestors, item.id])) {
          return true;
        }
      }
    }
    return false;
  }

  walk(data, []);
  return path;
}

/**
 * Returns a new Set equal to `expanded` plus the ancestors of `targetId`.
 * Additive only — it never removes an id, so it can never auto-collapse a node
 * the user expanded, and (because ancestors exclude the target) it never
 * re-expands the very node being revealed.
 */
export function revealPath(
  expanded: Set<string>,
  data: TreeDataItem[],
  targetId: string | undefined,
): Set<string> {
  if (!targetId) return expanded;
  const ancestors = collectAncestorIds(data, targetId);
  if (ancestors.length === 0) return expanded;
  const next = new Set(expanded);
  for (const id of ancestors) next.add(id);
  return next;
}

/** Returns a new Set with `id` toggled in/out of `expanded`. */
export function toggleExpanded(
  expanded: Set<string>,
  id: string,
): Set<string> {
  const next = new Set(expanded);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  return next;
}

/** Returns the ids of every node that has children (i.e. is expandable). */
export function collectExpandableIds(data: TreeDataItem[]): string[] {
  const ids: string[] = [];
  function walk(items: TreeDataItem[]) {
    for (const item of items) {
      if (item.children?.length) {
        ids.push(item.id);
        walk(item.children);
      }
    }
  }
  walk(data);
  return ids;
}
