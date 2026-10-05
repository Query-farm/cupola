/**
 * The editor's right-hand panel, shared by the Inspector and Ask AI. One
 * panel with tabs rather than two side by side: both are reference material
 * for the query on the left, and two panels would leave the editor too narrow.
 * Both tab bodies stay mounted (hidden with display:none) so Ask AI's per-tab
 * conversations survive switching to the Inspector and back.
 */
import { useCallback, useEffect, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Info, Loader2, Sparkles, X } from "lucide-react";

export type DockTab = "inspector" | "ai";

const MIN = 320, MAX = 720;
const OPEN_KEY = "vgi-editor-dock-open";
const TAB_KEY = "vgi-editor-dock-tab";
// The width key predates the Inspector; keeping it keeps everyone's width.
const WIDTH_KEY = "vgi-editor-ai-width";
const LEGACY_AI_OPEN_KEY = "vgi-editor-ai-open";

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch {}
}

/** Open state, tab and width of the dock, persisted. */
export function useDockState() {
  const [open, setOpen] = useState<boolean>(() => {
    const v = read(OPEN_KEY);
    return v === null ? read(LEGACY_AI_OPEN_KEY) === "1" : v === "1";
  });
  const [tab, setTab] = useState<DockTab>(() => {
    const v = read(TAB_KEY);
    if (v === "inspector" || v === "ai") return v;
    return "ai"; // a dock opened before the Inspector existed held Ask AI
  });
  const [width, setWidth] = useState<number>(() => {
    const n = parseInt(read(WIDTH_KEY) || "", 10);
    return n >= MIN && n <= MAX ? n : 400;
  });
  useEffect(() => { write(OPEN_KEY, open ? "1" : "0"); }, [open]);
  useEffect(() => { write(TAB_KEY, tab); }, [tab]);

  /** Toolbar toggle for one tab: shows it, or closes the dock if it is already showing. */
  const toggle = useCallback((which: DockTab) => {
    if (open && tab === which) { setOpen(false); return; }
    setTab(which);
    setOpen(true);
  }, [open, tab]);
  const show = useCallback((which: DockTab) => { setTab(which); setOpen(true); }, []);

  // Resize from the left edge: dragging left widens. Persist on release.
  const onResizeStart = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    e.currentTarget.setPointerCapture(e.pointerId);
    const onMove = (ev: globalThis.PointerEvent) => {
      setWidth(Math.min(MAX, Math.max(MIN, startW - (ev.clientX - startX))));
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      setWidth((w) => { write(WIDTH_KEY, String(w)); return w; });
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }, [width]);

  return { open, setOpen, tab, setTab, width, toggle, show, onResizeStart };
}

interface Props {
  state: ReturnType<typeof useDockState>;
  isNarrow: boolean;
  aiBusy?: boolean;
  inspector: ReactNode;
  ai: ReactNode;
}

export function RightDock({ state, isNarrow, aiBusy, inspector, ai }: Props) {
  const { open, tab, setTab, setOpen, width, onResizeStart } = state;
  const tabClass = (active: boolean) =>
    `flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium border-b-2 transition-colors ${
      active ? "border-accent text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
    }`;
  return (
    <>
      {open && !isNarrow && (
        <div
          onPointerDown={onResizeStart}
          className="w-1.5 shrink-0 cursor-col-resize bg-border hover:bg-accent/60 active:bg-accent transition-colors"
        />
      )}
      <div
        className={isNarrow ? "min-h-0 border-t border-border overflow-hidden flex flex-col" : "shrink-0 overflow-hidden flex flex-col border-l border-border"}
        style={open
          ? (isNarrow ? { width: "100%", flex: "1 1 45%" } : { width })
          : { width: 0, display: "none" }}
        data-testid="editor-dock"
      >
        <div className="flex items-center border-b border-border bg-card px-1 shrink-0" role="tablist" aria-label="Side panel">
          <button role="tab" aria-selected={tab === "inspector"} className={tabClass(tab === "inspector")} onClick={() => setTab("inspector")} data-testid="dock-tab-inspector">
            <Info className="h-3.5 w-3.5" /> Inspector
          </button>
          <button role="tab" aria-selected={tab === "ai"} className={tabClass(tab === "ai")} onClick={() => setTab("ai")} data-testid="dock-tab-ai">
            {aiBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5 text-accent" />} Ask AI
          </button>
          <button
            onClick={() => setOpen(false)}
            className="ml-auto p-1 text-muted-foreground hover:text-foreground transition-colors"
            title="Close side panel"
            aria-label="Close side panel"
            data-testid="dock-close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 min-h-0" role="tabpanel" style={tab === "inspector" ? undefined : { display: "none" }}>{inspector}</div>
        <div className="flex-1 min-h-0" role="tabpanel" style={tab === "ai" ? undefined : { display: "none" }}>{ai}</div>
      </div>
    </>
  );
}
