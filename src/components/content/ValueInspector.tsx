import { useEffect, useRef, useState } from "react";
import { Braces, Check, Copy, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isNullValue } from "@/lib/format";
import type { ColumnInfo } from "@/lib/service";
import { cellText, prettyJson } from "./cell-text";

interface Props {
  column: string;
  info?: ColumnInfo;
  field?: any;
  value: any;
  /** 1-based row number in the whole result. */
  rowNumber: number;
  numberGrouping?: boolean;
  onClose: () => void;
}

/**
 * Docked panel showing one cell's full value, wrapped, with copy. The grid
 * truncates long values to its column width; this is where they're read.
 * JSON objects and arrays can be shown indented.
 *
 * Rendered inline rather than in a dialog: the pop-out results window renders
 * DataPreview from the opener's realm, and a portal would land in the opener.
 */
export function ValueInspector({ column, info, field, value, rowNumber, numberGrouping, onClose }: Props) {
  const isNull = isNullValue(value);
  const text = isNull ? "" : cellText(value, column, field, info, numberGrouping);
  const pretty = isNull ? null : prettyJson(text);
  const [showPretty, setShowPretty] = useState(true);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const shown = pretty && showPretty ? pretty : text;

  useEffect(() => { setCopied(false); }, [text]);

  const copy = () => {
    const nav = rootRef.current?.ownerDocument.defaultView?.navigator ?? navigator;
    void nav.clipboard?.writeText(shown).then(() => setCopied(true), () => {});
  };

  return (
    <div
      ref={rootRef}
      role="region"
      aria-label="Cell value"
      className="flex flex-col h-full min-w-0 border-l border-border bg-card"
    >
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border shrink-0">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-mono font-semibold truncate" title={column}>{column}</div>
          <div className="text-[11px] text-muted-foreground truncate">
            Row {rowNumber.toLocaleString()}
            {info?.duckdbType ? ` · ${info.duckdbType}` : ""}
            {!isNull ? ` · ${text.length.toLocaleString()} chars` : ""}
          </div>
        </div>
        {pretty && (
          <Button
            variant={showPretty ? "secondary" : "ghost"}
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => setShowPretty((v) => !v)}
            title={showPretty ? "Show as stored" : "Format JSON"}
            aria-pressed={showPretty}
          >
            <Braces className="h-3.5 w-3.5" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={copy}
          disabled={isNull}
          title="Copy value"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onClose} title="Close (Esc)">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto px-3 py-2">
        {isNull ? (
          <span className="text-xs text-muted-foreground/50 italic">NULL</span>
        ) : (
          <pre
            data-testid="cell-value"
            className="text-xs font-mono whitespace-pre-wrap [overflow-wrap:anywhere] select-text"
          >
            {shown}
          </pre>
        )}
      </div>
    </div>
  );
}

const PANEL_WIDTH_KEY = "cupola.value-panel-width";
const MIN_PANEL_WIDTH = 220;
/** Room the grid keeps beside the panel, however wide it's dragged. */
const MIN_GRID_WIDTH = 160;

function readPanelWidth(): number | null {
  try {
    const n = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    return Number.isFinite(n) && n >= MIN_PANEL_WIDTH ? n : null;
  } catch {
    return null;
  }
}

/**
 * The value panel's dock: a left-edge handle drags its width (double-click
 * resets it), remembered per browser. Unset, it takes 40% of the results area.
 */
export function ValuePanelFrame({ children }: { children: React.ReactNode }) {
  const [width, setWidth] = useState<number | null>(readPanelWidth);
  const [dragging, setDragging] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);

  const startDrag = (e: React.PointerEvent) => {
    const frame = frameRef.current;
    const area = frame?.parentElement;
    if (!frame || !area) return;
    e.preventDefault();
    // The element's own view: the pop-out results window renders this from the
    // opener's realm, so its pointer events arrive at the child window.
    const doc = frame.ownerDocument;
    const view = doc.defaultView ?? window;
    const startX = e.clientX;
    const startWidth = frame.getBoundingClientRect().width;
    const max = Math.max(MIN_PANEL_WIDTH, area.getBoundingClientRect().width - MIN_GRID_WIDTH);
    let latest = startWidth;
    const onMove = (ev: PointerEvent) => {
      latest = Math.round(Math.min(max, Math.max(MIN_PANEL_WIDTH, startWidth + startX - ev.clientX)));
      setWidth(latest);
    };
    const prevCursor = doc.body.style.cursor;
    const prevSelect = doc.body.style.userSelect;
    const onUp = () => {
      view.removeEventListener("pointermove", onMove);
      view.removeEventListener("pointerup", onUp);
      doc.body.style.cursor = prevCursor;
      doc.body.style.userSelect = prevSelect;
      setDragging(false);
      try { localStorage.setItem(PANEL_WIDTH_KEY, String(latest)); } catch {}
    };
    view.addEventListener("pointermove", onMove);
    view.addEventListener("pointerup", onUp);
    doc.body.style.cursor = "col-resize";
    doc.body.style.userSelect = "none";
    setDragging(true);
  };

  const reset = () => {
    setWidth(null);
    try { localStorage.removeItem(PANEL_WIDTH_KEY); } catch {}
  };

  return (
    <div
      ref={frameRef}
      data-testid="value-panel"
      className={`relative shrink-0 ${width == null ? "w-[40%] max-w-[560px] min-w-[240px]" : ""}`}
      style={width == null ? undefined : { width, maxWidth: `calc(100% - ${MIN_GRID_WIDTH}px)` }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize value panel"
        title="Drag to resize · double-click to reset"
        onPointerDown={startDrag}
        onDoubleClick={reset}
        className={`absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize touch-none
          after:absolute after:inset-y-0 after:left-1 after:w-px after:bg-primary
          after:opacity-0 hover:after:opacity-60 ${dragging ? "after:opacity-100" : ""}`}
      />
      {children}
    </div>
  );
}
