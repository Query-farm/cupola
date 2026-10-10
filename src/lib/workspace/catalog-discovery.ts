/**
 * Listing the catalogs a VGI service serves, for the welcome page's connect
 * form and the picker's "Attach a catalog…".
 *
 * `catalogs_info` is an ordinary RPC, so a service behind OAuth answers it
 * only once signed in (vgi-rpc exempts nothing but `/health`, `/.well-known/`
 * and `/_oauth`). Tokens are kept per origin, so one sign-in lists every
 * catalog the service serves and attaches all of them. The forms offer
 * "Sign in to list catalogs": the reader returns to the same form, which
 * asks again with the token. What the form needs to come back to is kept in
 * sessionStorage across the redirect (URLs only, never option values).
 */
import { fetchServiceCatalogs } from "../service";
import { consumePendingCallback } from "../oauth-client";
import type { DiscoveredCatalog } from "./connect-plan";

export type CatalogDiscovery =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ok"; catalogs: DiscoveredCatalog[] }
  | { state: "error"; error: string; signInRequired: boolean };

/** `fetchServiceCatalogs`, after finishing any sign-in this page returned
 *  from: the token exchange has to happen before the RPC carries it. */
export async function discoverCatalogs(serviceUrl: string): Promise<Exclude<CatalogDiscovery, { state: "idle" | "loading" }>> {
  try {
    await consumePendingCallback();
  } catch (error) {
    return { state: "error", error: error instanceof Error ? error.message : String(error), signInRequired: true };
  }
  const found = await fetchServiceCatalogs(serviceUrl);
  return found.ok ? { state: "ok", catalogs: found.catalogs } : { state: "error", error: found.error, signInRequired: found.signInRequired };
}

// ---------------------------------------------------------------------------
// Coming back from "Sign in to list catalogs"
// ---------------------------------------------------------------------------

const PENDING_CONNECT_KEY = "cupola-pending-connect";
const PENDING_ATTACH_KEY = "cupola-pending-attach";

function stash(key: string, value: unknown): void {
  try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked: the form just starts empty */ }
}

function take<T>(key: string, valid: (value: any) => value is T): T | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(key);
    sessionStorage.removeItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return valid(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The welcome form's URL rows, kept while the reader signs in to one of them. */
export function stashPendingConnect(urls: string[]): void {
  stash(PENDING_CONNECT_KEY, { urls });
}

export function takePendingConnect(): string[] | null {
  const found = take(PENDING_CONNECT_KEY, (v): v is { urls: string[] } =>
    Boolean(v) && Array.isArray(v.urls) && v.urls.every((u: unknown) => typeof u === "string"));
  return found?.urls ?? null;
}

/** The picker's attach form, kept while the reader signs in: reopened on the
 *  same workspace's page with the same URL. */
export function stashPendingAttach(workspaceId: string, url: string): void {
  stash(PENDING_ATTACH_KEY, { workspaceId, url });
}

export function takePendingAttach(workspaceId: string): string | null {
  const found = take(PENDING_ATTACH_KEY, (v): v is { workspaceId: string; url: string } =>
    Boolean(v) && typeof v.workspaceId === "string" && typeof v.url === "string");
  return found && found.workspaceId === workspaceId ? found.url : null;
}
