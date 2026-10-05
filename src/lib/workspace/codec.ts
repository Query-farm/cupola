/**
 * `#ws=` link codec: the workspace file as JSON, raw-deflated and base64url'd
 * with the same codec as shared query links (`share-query.ts`). A fragment is
 * never sent to a server, so a workspace's URLs and options stay out of
 * request logs and Referer headers.
 */
import { compressSql, decompressSql } from "../share-query";
import { validateWorkspaceFile, type PortableWorkspaceFile, type ValidationResult } from "./spec";

export const WS_FRAGMENT_PARAM = "ws";
/** Refuse absurd tokens before inflating them. */
const MAX_TOKEN_CHARS = 64 * 1024;
const MAX_JSON_CHARS = 512 * 1024;

export async function encodeWorkspaceToken(file: PortableWorkspaceFile): Promise<string> {
  return compressSql(JSON.stringify(file));
}

/** Decode and validate a `#ws=` token. Never throws: a corrupt, oversized or
 *  invalid token is an error the page shows. */
export async function decodeWorkspaceToken(token: string): Promise<ValidationResult> {
  if (!token) return { ok: false, error: "The workspace link is empty." };
  if (token.length > MAX_TOKEN_CHARS) return { ok: false, error: "The workspace link is too long." };
  let json: string;
  try {
    json = await decompressSql(token);
  } catch {
    return { ok: false, error: "The workspace link is damaged (it could not be decompressed). Ask for the link again." };
  }
  if (json.length > MAX_JSON_CHARS) return { ok: false, error: "The workspace link is too large." };
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { ok: false, error: "The workspace link is damaged (it is not valid JSON)." };
  }
  return validateWorkspaceFile(value);
}

/** A `#ws=` link to `baseUrl` (the app's own URL, without query or hash). */
export async function buildWorkspaceUrl(baseUrl: string, file: PortableWorkspaceFile): Promise<string> {
  return `${baseUrl}#${WS_FRAGMENT_PARAM}=${await encodeWorkspaceToken(file)}`;
}
