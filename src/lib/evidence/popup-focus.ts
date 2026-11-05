/** How long a popup's trigger may stay disabled before giving up on returning focus to it. */
const RETURN_FOCUS_WAIT_MS = 5_000;

/** Evidence's dropdown moves focus into its popup's search box, and bits-ui's select never returns
 * it (its close handler prevents the focus scope's restore). Closing removes the box, focus falls
 * to <body>, and the keyboard can no longer reach the dropdown. The trigger may not take focus at
 * once: typing a search re-runs the options query, and the button is disabled while it loads.
 * Anything the reader focuses meanwhile wins. */
export function returnPopupFocus(root: ShadowRoot): () => void {
  let trigger: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => { clearTimeout(timer); timer = undefined; };
  const lost = () => !root.activeElement && (document.activeElement === document.body || document.activeElement === root.host || !document.activeElement);

  const focusin = (event: Event) => {
    stop();
    const target = event.composedPath()[0];
    if (target instanceof Element && target.closest('[data-slot="select-content"]')) {
      trigger = root.querySelector<HTMLElement>('[data-slot="select-trigger"][aria-expanded="true"]') ?? trigger;
    }
  };
  const focusout = (event: Event) => {
    const target = event.composedPath()[0];
    if (!(target instanceof Element) || !target.closest('[data-slot="select-content"]') || !trigger) return;
    const owner = trigger;
    const deadline = performance.now() + RETURN_FOCUS_WAIT_MS;
    const attempt = () => {
      if (!owner.isConnected || !lost() || root.querySelector('[data-slot="select-content"]') || performance.now() > deadline) {
        if (!root.querySelector('[data-slot="select-content"]')) trigger = null;
        return;
      }
      if ((owner as HTMLButtonElement).disabled) { timer = setTimeout(attempt, 50); return; }
      trigger = null;
      owner.focus({ preventScroll: true });
    };
    stop();
    // Moving within the popup, or into another control, has settled by the next tick.
    timer = setTimeout(attempt, 0);
  };

  root.addEventListener('focusin', focusin);
  root.addEventListener('focusout', focusout);
  return () => {
    stop();
    root.removeEventListener('focusin', focusin);
    root.removeEventListener('focusout', focusout);
  };
}
