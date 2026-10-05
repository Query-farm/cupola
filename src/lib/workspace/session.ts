/**
 * Where this tab keeps its catalog set between reloads, until phase 2's
 * workspace store exists.
 *
 * Opening a `#ws=` link decodes it once, assigns aliases once
 * (`normaliseWorkspace`), stores the result here under a fresh id and swaps
 * the fragment for `?local_ws=<id>`. A reload of that URL reads the same
 * catalog set back, with the same aliases and without asking for consent
 * again. sessionStorage is tab-scoped, so the id means nothing in another tab
 * or browser; the shareable form is always `#ws=`.
 *
 * Sign-in follows the `vgi-pending-share-sql` pattern: a catalog's Sign in
 * button stores `{workspace, pendingSignIns}` before the top-level redirect to
 * the identity provider, and the returning page reads it to say who was signed
 * in and who still needs it. Redirects are never chained automatically.
 */
import type { ActiveWorkspace } from "./spec";

const WORKSPACE_KEY = "cupola.session-workspace.v1:";
const PENDING_SIGN_IN_KEY = "cupola-pending-sign-in";

interface StoredWorkspace {
  workspace: ActiveWorkspace;
  consented: boolean;
}

function storage(): Storage | null {
  try { return typeof window === "undefined" ? null : window.sessionStorage; } catch { return null; }
}

export function stashSessionWorkspace(workspace: ActiveWorkspace, consented: boolean): void {
  try { storage()?.setItem(WORKSPACE_KEY + workspace.id, JSON.stringify({ workspace, consented } satisfies StoredWorkspace)); } catch {}
}

export function loadSessionWorkspace(id: string): StoredWorkspace | null {
  try {
    const raw = storage()?.getItem(WORKSPACE_KEY + id);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredWorkspace;
    if (!parsed?.workspace || !Array.isArray(parsed.workspace.catalogs)) return null;
    return { workspace: parsed.workspace, consented: Boolean(parsed.consented) };
  } catch {
    return null;
  }
}

export function markSessionWorkspaceConsented(workspace: ActiveWorkspace): void {
  stashSessionWorkspace(workspace, true);
}

export interface PendingSignIn {
  workspaceId: string;
  /** A copy of the catalog set, in case the session entry is gone. */
  workspace: ActiveWorkspace;
  /** The catalog this redirect signs in to. */
  signingIn: string;
  /** Catalog ids that needed sign-in when the redirect started. */
  pendingSignIns: string[];
  at: number;
}

export function savePendingSignIn(pending: Omit<PendingSignIn, "at">): void {
  try { storage()?.setItem(PENDING_SIGN_IN_KEY, JSON.stringify({ ...pending, at: Date.now() })); } catch {}
}

/** The pending sign-in for this workspace, if any. Not removed: the banner
 *  that reports it clears it once shown. */
export function readPendingSignIn(workspaceId: string): PendingSignIn | null {
  try {
    const raw = storage()?.getItem(PENDING_SIGN_IN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingSignIn;
    return parsed?.workspaceId === workspaceId ? parsed : null;
  } catch {
    return null;
  }
}

export function clearPendingSignIn(): void {
  try { storage()?.removeItem(PENDING_SIGN_IN_KEY); } catch {}
}
