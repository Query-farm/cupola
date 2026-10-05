/**
 * What the workspace manager does when a catalog's alias changes, until the
 * rewrite dialog (phase 3C, `alias-rewrite.ts` + AliasRenameDialog) is wired:
 * a plain confirm, then a rename that rewrites nothing.
 *
 * The contract every handler keeps: resolve true once the stored alias **is**
 * the new one, false to leave it unchanged. The manager saves the rest of the
 * catalog's draft only after a true.
 */
import { updateCatalog } from "./store";

export type AliasRenameHandler = (workspaceId: string, catalogId: string, oldAlias: string, newAlias: string) => Promise<boolean>;

export function aliasRenameMessage(oldAlias: string, newAlias: string): string {
  return `Rename alias "${oldAlias}" to "${newAlias}"?\n\n`
    + `Saved reports, editor tabs and queries that name "${oldAlias}." are not rewritten; they will fail until you change them.`;
}

// phase3-wire: AliasRenameDialog
export function confirmAliasRenameWith(confirm: (message: string) => boolean): AliasRenameHandler {
  return async (workspaceId, catalogId, oldAlias, newAlias) => {
    if (!confirm(aliasRenameMessage(oldAlias, newAlias))) return false;
    return updateCatalog(workspaceId, catalogId, { alias: newAlias });
  };
}

/** The default handler: the browser's own confirm. */
export const confirmAliasRename: AliasRenameHandler = (...args) =>
  confirmAliasRenameWith((message) => typeof window === "undefined" || window.confirm(message))(...args);
