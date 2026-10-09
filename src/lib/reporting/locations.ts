import type { ReportsInfo } from './contracts.generated';

export interface ReportLocation { url: string; name: string; info?: ReportsInfo; error?: string; loading?: boolean }
/** Names are labels, never identities. Duplicate names need a visible discriminator. */
export function locationLabel(location: ReportLocation, locations: readonly ReportLocation[]): string {
  const same = locations.filter(item => item.name === location.name);
  if (same.length < 2) return location.name;
  const address = new URL(location.url);
  return `${location.name} (${address.host}${address.pathname === '/' ? '' : address.pathname})`;
}
