import type { DiscoveryCapabilities, Limit, OwnershipCapabilities } from './contracts.generated';

export type OwnershipScope = OwnershipCapabilities['scopes'][number];
export const ownershipScopeLabels: Record<OwnershipScope, string> = {
  all: 'All accessible items', self: 'Owned by me', member: 'My memberships', self_or_member: 'Me and my memberships',
};

/** A search budget applies across the entire stream, including continuations. */
export function discoveryLimit(capabilities: DiscoveryCapabilities, query: string): bigint | null {
  if (query.trim() ? !capabilities.search_supported || [...query.trim()].length < Number(capabilities.min_query_length) : !capabilities.suggestions_supported) return null;
  return capabilities.max_results > 0n ? BigInt(Math.min(20, Number(capabilities.max_results))) : null;
}

export function finiteLimit(limits: Limit[], name: string): number {
  const value = limits.find(limit => limit.name === name)?.value;
  if (value == null || value <= 0n || !Number.isSafeInteger(Number(value))) throw new Error(`The worker did not publish a valid ${name} limit.`);
  return Number(value);
}
