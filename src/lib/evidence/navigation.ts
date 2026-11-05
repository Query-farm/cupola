import { onMount } from 'svelte';
import { isOutsideApp, LINK_REFUSED_EVENT } from './link-refusal';

// Evidence's renderer expects SvelteKit navigation; Cupola owns page navigation.
export async function goto(url: string | URL): Promise<void> {
  const target = new URL(url, window.location.href);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('Unsupported link');
  if (isOutsideApp(target, new URL(window.location.href), import.meta.env.BASE_URL)) {
    window.dispatchEvent(new CustomEvent(LINK_REFUSED_EVENT, { detail: target.pathname }));
    return;
  }
  window.location.assign(target.href);
}
export function afterNavigate(callback: () => void) { onMount(callback); }
export async function invalidateAll() { window.location.reload(); }
