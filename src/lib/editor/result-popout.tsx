/**
 * Detached results window controller (singleton, one reused window).
 *
 * Pops the editor's result grid out into a same-origin `window.open` window as a
 * frozen *snapshot* of an in-memory Arrow table. The child gets its own React
 * root (its event system is native to the child document — the robust choice for
 * an interactive grid). The Arrow Table is shared by reference (same JS realm),
 * so there's no serialization. The source pushes its current result via
 * `updateLatest`, letting the window offer an explicit "Sync" rather than
 * silently live-updating.
 */
import { createRoot, type Root } from "react-dom/client";
import { SettingsProvider } from "@/lib/settings";
import { PoppedResults } from "@/components/editor/PoppedResults";

export interface ResultSnapshot {
  /** Apache Arrow Table (materialized in memory). */
  table: any;
  sql: string;
  capturedAt: Date;
}

interface LatestResult {
  table: any;
  sql: string;
}

let win: Window | null = null;
let root: Root | null = null;
let current: ResultSnapshot | null = null;
let latest: LatestResult | null = null;
let openerUnloadBound = false;

/** Copy the app's stylesheets + theme custom-properties into the child document. */
function copyStyles(target: Document) {
  document.querySelectorAll('link[rel="stylesheet"], style').forEach((n) => {
    target.head.appendChild(n.cloneNode(true));
  });
  // `?theme=` overrides live as inline CSS vars on <html>; the DataGrid reads them.
  target.documentElement.style.cssText = document.documentElement.style.cssText;
  const cls = document.documentElement.getAttribute("class");
  if (cls) target.documentElement.setAttribute("class", cls);
  target.body.className = "bg-background text-foreground antialiased";
}

function render() {
  if (!root || !current) return;
  const hasNewer = !!latest && latest.table !== current.table;
  root.render(
    <SettingsProvider>
      <PoppedResults snapshot={current} hasNewer={hasNewer} onSync={sync} />
    </SettingsProvider>,
  );
}

function sync() {
  if (!latest) return;
  current = { table: latest.table, sql: latest.sql, capturedAt: new Date() };
  render();
}

/** The source calls this whenever its active result changes so the window can
 *  show a "newer result available" affordance and Sync to it. */
export function updateLatest(next: LatestResult | null) {
  latest = next;
  render();
}

export function isPopoutOpen(): boolean {
  return !!win && !win.closed;
}

/**
 * Open (or focus + refresh) the pop-out window with a snapshot of the current
 * result. MUST be called synchronously inside a user gesture or the browser
 * blocks the window. Returns false if the popup was blocked.
 */
export function openPopout(snapshot: ResultSnapshot): boolean {
  current = snapshot;

  // Reuse an already-open window: focus + re-render with the new snapshot.
  if (win && !win.closed) {
    render();
    win.focus();
    return true;
  }

  const w = window.open("", "cupola-results", "popup,width=1100,height=800");
  if (!w) return false;
  win = w;

  w.document.title = "Cupola — results snapshot";
  const rootEl = w.document.createElement("div");
  rootEl.id = "root";
  rootEl.style.height = "100vh";
  w.document.body.appendChild(rootEl);
  copyStyles(w.document);

  root = createRoot(rootEl);
  render();

  // Child closed by the user → tear down and clear the handle.
  w.addEventListener("pagehide", () => closePopout(), { once: true });

  // Opener (main app) unloads → close the child so it isn't left frozen/orphaned.
  if (!openerUnloadBound) {
    window.addEventListener("pagehide", () => { try { win?.close(); } catch { /* ignore */ } });
    openerUnloadBound = true;
  }

  return true;
}

export function closePopout() {
  try { root?.unmount(); } catch { /* ignore */ }
  root = null;
  try { if (win && !win.closed) win.close(); } catch { /* ignore */ }
  win = null;
  current = null;
}
