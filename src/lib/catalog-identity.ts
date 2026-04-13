/**
 * Per-catalog OAuth identity.
 *
 * Primary source: client-side JWT decoding via `getUserInfo()` from auth.ts.
 * This is available immediately for the primary service (tokens stored in
 * sessionStorage by the SPA OAuth client).
 *
 * Secondary source: the DuckDB `vgi_catalog_identity()` table function,
 * which returns identity for all attached catalogs. This becomes available
 * once the shell worker boots and `bridge.query` is set — typically only
 * after the user opens the SQL Shell. When available, it upgrades the
 * identity with claims parsed by the native extension (which may include
 * fields not present in the client-side JWT).
 */
import { useState, useEffect } from "react";
import { getUserInfo } from "./auth";
import { esc, readRows } from "./duckdb-query";
import { bridge } from "./shell-bridge";

export interface CatalogIdentity {
  catalogName: string;
  authenticated: boolean;
  email: string | null;
  name: string | null;
  issuer: string | null;
}

/** Try to fetch identity from vgi_catalog_identity() via the shell bridge.
 *  Returns null if the bridge isn't ready or the function isn't available. */
async function fetchFromExtension(catalogName: string): Promise<CatalogIdentity | null> {
  const rows = await readRows(
    `SELECT catalog_name, authenticated, email, name, issuer FROM vgi_catalog_identity() WHERE catalog_name = '${esc(catalogName)}'`
  );
  if (!rows || rows.length === 0) return null;
  const row = rows[0];
  const identity: CatalogIdentity = {
    catalogName: String(row.catalog_name ?? catalogName),
    authenticated: Boolean(row.authenticated),
    email: row.email == null ? null : String(row.email),
    name: row.name == null ? null : String(row.name),
    issuer: row.issuer == null ? null : String(row.issuer),
  };
  // Only return if there's something useful to display
  if (identity.name || identity.email) return identity;
  return null;
}

/** Build identity from the client-side JWT for a service URL. */
function fetchFromJwt(serviceUrl: string, catalogName: string): CatalogIdentity | null {
  const info = getUserInfo(serviceUrl);
  if (!info || (!info.name && !info.email)) return null;
  return {
    catalogName,
    authenticated: true,
    email: info.email ?? null,
    name: info.name ?? null,
    issuer: null,
  };
}

/** React hook that returns the OAuth identity for a catalog.
 *  Returns JWT-based identity immediately for the primary service, then
 *  upgrades to extension-based identity if the shell bridge becomes available. */
export function useCatalogIdentity(
  catalogName: string,
  serviceUrl?: string,
): { identity: CatalogIdentity | null; loading: boolean } {
  const [identity, setIdentity] = useState<CatalogIdentity | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    // Immediate: try client-side JWT
    if (serviceUrl) {
      const jwtIdentity = fetchFromJwt(serviceUrl, catalogName);
      if (jwtIdentity && !cancelled) {
        setIdentity(jwtIdentity);
        setLoading(false);
      }
    }

    // Deferred: try the DuckDB extension if bridge is available (or becomes
    // available). This can provide richer info (issuer, extension-parsed
    // claims) and works for attached catalogs that don't have SPA tokens.
    const tryExtension = async () => {
      if (cancelled || !bridge.query) return;
      try {
        const result = await fetchFromExtension(catalogName);
        if (result && !cancelled) {
          setIdentity(result);
          setLoading(false);
        }
      } catch {
        // Extension not available — keep JWT-based identity
      }
    };

    // If bridge.query is already available, try immediately.
    // Otherwise, check once after a delay (the worker may boot soon).
    if (bridge.query) {
      tryExtension();
    } else {
      const timer = setTimeout(tryExtension, 3000);
      if (!cancelled) {
        // If we didn't get JWT identity either, stop loading
        if (!identity && !serviceUrl) setLoading(false);
      }
      return () => { cancelled = true; clearTimeout(timer); };
    }

    return () => { cancelled = true; };
  }, [catalogName, serviceUrl]);

  return { identity, loading };
}
