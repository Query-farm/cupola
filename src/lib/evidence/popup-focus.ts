/** How long after a popup closes its trigger is kept focused through the options query. */
const RETURN_FOCUS_WAIT_MS = 5_000;

/** Evidence's dropdown moves focus into its popup's search box, and bits-ui's select never returns
 * it (its close handler prevents the focus scope's restore). Closing removes the box, focus falls
 * to <body>, and the keyboard can no longer reach the dropdown.
 *
 * The trigger can't simply be focused once. Typing a search reruns the options query and clearing
 * it reruns it again, a moment after the popup has closed, and the button is disabled while each
 * one loads. A disabled button can't take focus and drops any it has, so focus is held until the
 * queries settle. Anything the reader focuses meanwhile wins. */
export function returnPopupFocus(root: ShadowRoot): () => void {
  let owner: HTMLButtonElement | null = null;
  let deadline = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => { clearTimeout(timer); timer = undefined; };
  const lost = () => !root.activeElement && (!document.activeElement || document.activeElement === document.body || document.activeElement === root.host);

  const attempt = () => {
    timer = undefined;
    const button = owner;
    if (!button?.isConnected || performance.now() > deadline || !lost() || button.getAttribute('aria-expanded') === 'true') return;
    if (button.disabled) { timer = setTimeout(attempt, 50); return; }
    button.focus({ preventScroll: true });
  };
  const inPopup = (target: EventTarget | undefined): target is Element => target instanceof Element && Boolean(target.closest('[data-slot="select-content"]'));

  const focusin = (event: Event) => {
    stop();
    const target = event.composedPath()[0];
    if (inPopup(target)) owner = root.querySelector<HTMLButtonElement>('[data-slot="select-trigger"][aria-expanded="true"]') ?? owner;
    else if (target !== owner) owner = null;
  };
  const focusout = (event: Event) => {
    const target = event.composedPath()[0];
    const closing = inPopup(target) && owner;
    if (closing) deadline = performance.now() + RETURN_FOCUS_WAIT_MS;
    // Disabled by a rerunning query, rather than left by the reader.
    else if (target !== owner || !owner?.disabled) return;
    stop();
    // A move to another control has settled by the next tick.
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
