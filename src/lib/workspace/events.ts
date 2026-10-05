/**
 * Window events between workspace surfaces that don't share a React tree (the header's picker,
 * the reports workspace, the command palette). Their own module so a surface can fire one without
 * importing the component that listens.
 */

/** Open the picker on its "Attach a catalog…" form (the sidebar's empty workspace button, a
 *  report's Attach, the command palette). The detail, when there is one, prefills the form. */
export const OPEN_ATTACH_EVENT = "cupola:open-attach-catalog";
export interface AttachPrefill {
  url: string;
  /** Tick only this catalog when the service lists several. */
  catalogName?: string;
  alias?: string;
}
export function openAttachCatalog(prefill?: AttachPrefill): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<AttachPrefill | undefined>(OPEN_ATTACH_EVENT, { detail: prefill }));
}

/** Open the command palette (⌘K / Ctrl+K does too). */
export const OPEN_COMMAND_PALETTE_EVENT = "cupola:open-command-palette";
export function openCommandPalette(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE_EVENT));
}

/** Ask for the alias-rename dialog: `AliasRenameHost` (mounted by the app) opens it. */
export const ALIAS_RENAME_EVENT = "cupola:alias-rename-requested";
export interface AliasRenameRequest {
  workspaceId: string;
  catalogId: string;
  oldAlias: string;
  /** The alias asked for; the dialog lets the reader change it before renaming. */
  newAlias: string;
}
/** The hook the workspace manager calls when a catalog's alias is edited: opens the dialog that
 *  counts and offers to rewrite the references, then renames. */
export function onAliasRenameRequested(workspaceId: string, catalogId: string, oldAlias: string, newAlias: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<AliasRenameRequest>(ALIAS_RENAME_EVENT, { detail: { workspaceId, catalogId, oldAlias, newAlias } }));
}
