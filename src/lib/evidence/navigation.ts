import { onMount } from 'svelte';

// Evidence's renderer expects SvelteKit navigation; Cupola owns page navigation.
export async function goto(url: string | URL): Promise<void> {
  const target = new URL(url, window.location.href);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('Unsupported link');
  window.location.assign(target.href);
}
export function afterNavigate(callback: () => void) { onMount(callback); }
export async function invalidateAll() { window.location.reload(); }
