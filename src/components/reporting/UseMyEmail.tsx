import { useEffect, useState } from 'react';
import { UserRound } from 'lucide-react';
import { Button } from '../ui/button';
import type { ReportClient } from '../../lib/reporting/client';
import type { CurrentIdentity } from '../../lib/reporting/contracts.generated';

/** Profile metadata is only a suggestion; the worker still validates delivery destinations. */
export function UseMyEmail({ client, onSelect, disabled }: { client: ReportClient; onSelect: (email: string) => void; disabled?: boolean }) {
  const [identity, setIdentity] = useState<CurrentIdentity | null>(null);
  useEffect(() => {
    const abort = new AbortController(); setIdentity(null);
    void (async () => {
      const profile = await client.identityInfo('identity.get_current_identity', abort.signal);
      if (!abort.signal.aborted) setIdentity(profile);
    })().catch(() => { /* Optional metadata must not prevent manual recipient entry. */ });
    return () => abort.abort();
  }, [client]);
  if (!identity?.email) return null;
  return <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
    <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => onSelect(identity.email!)}><UserRound />Use my email</Button>
    <span>{identity.display_name ? `${identity.display_name} · ` : ''}{identity.email}</span>
  </div>;
}

export function addRecipient(current: string, email: string): string {
  return current.split(/[,;\n]/).some(value => value.trim().toLowerCase() === email.trim().toLowerCase()) ? current : current.trim() ? `${current}, ${email}` : email;
}
