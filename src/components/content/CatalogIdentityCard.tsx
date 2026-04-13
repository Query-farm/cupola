import { UserCircle } from "lucide-react";
import type { CatalogIdentity } from "@/lib/catalog-identity";

interface Props {
  identity: CatalogIdentity | null;
  loading: boolean;
}

/** Extract the host from an issuer URL for compact display. */
function issuerHost(issuer: string): string {
  try {
    return new URL(issuer).host;
  } catch {
    return issuer;
  }
}

export function CatalogIdentityCard({ identity, loading }: Props) {
  if (loading || !identity) return null;

  if (!identity.authenticated) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground mb-6 px-1">
        <UserCircle className="size-4" />
        <span>Not authenticated</span>
      </div>
    );
  }

  // Nothing useful to display — the extension returned authenticated but
  // the id_token claims haven't been parsed (no name, no email).
  if (!identity.name && !identity.email) return null;

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 mb-6">
      <UserCircle className="size-8 text-primary shrink-0" />
      <div className="min-w-0">
        {identity.name && (
          <div className="text-sm font-medium text-foreground truncate">{identity.name}</div>
        )}
        {identity.email && (
          <div className="text-xs text-muted-foreground truncate">{identity.email}</div>
        )}
        {identity.issuer && (
          <div className="text-[11px] text-muted-foreground/60 truncate">
            via {issuerHost(identity.issuer)}
          </div>
        )}
      </div>
    </div>
  );
}
