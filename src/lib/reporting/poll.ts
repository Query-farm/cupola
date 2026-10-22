import { errorCode } from './client';

/** Errors another poll cannot fix: the user must sign in again (or be granted access) first. */
const TERMINAL = new Set(['UNAUTHENTICATED', 'PERMISSION_DENIED']);

/** The wait before the next poll, or null to stop polling until something else asks for a refresh.
 *  Failures back off from `ms`, doubling to at most five minutes. */
export function nextPollDelay(ms: number, failures: number, error?: unknown): number | null {
  if (error !== undefined && TERMINAL.has(errorCode(error) ?? '')) return null;
  return failures ? Math.min(ms * 2 ** failures, 5 * 60_000) : ms;
}

/** Runs `next` after `ms`, but never while the tab is hidden: a background tab polls no one, and
 *  catches up once, as soon as it is shown again. Aborting `signal` cancels it. */
export function pollAfter(ms: number, next: () => void, signal: AbortSignal): void {
  const shown = () => {
    if (document.hidden) return;
    document.removeEventListener('visibilitychange', shown);
    if (!signal.aborted) next();
  };
  const timer = setTimeout(() => {
    if (signal.aborted) return;
    if (!document.hidden) next();
    else document.addEventListener('visibilitychange', shown);
  }, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); document.removeEventListener('visibilitychange', shown); }, { once: true });
}
