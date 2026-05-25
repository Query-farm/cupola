/**
 * Mosaic tab — a developer-friendly editor + preview for hand-authoring
 * vgplot specs. Mirrors the Perspective tab in the bottom-panel area but
 * for declarative chart specs.
 *
 * Layout: two-pane split. JSON spec on the left (plain textarea, JetBrains
 * Mono), live-rendered chart on the right. Render button + Ctrl/Cmd+Enter.
 * Reuses chart-export.ts and FullscreenChart from the chat block.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, AlertCircle, Play, Download, Maximize2, X, FilePlus, RotateCcw } from "lucide-react";
import { renderChartSpec } from "@/lib/mosaic-bridge";
import { findChartSvg, downloadChartSVG, downloadChartPNG } from "@/lib/chart-export";

const STORAGE_KEY = "mosaic-editor-spec";
const DEFAULT_SPEC = `{
  "$schema": "https://uwdata.github.io/mosaic/schema/latest.json",
  "data": {
    "demo": "SELECT 'a' AS k, 1 AS v UNION ALL SELECT 'b', 2 UNION ALL SELECT 'c', 3 UNION ALL SELECT 'd', 4"
  },
  "plot": [
    { "mark": "barY", "data": { "from": "demo" }, "x": "k", "y": "v" }
  ],
  "width": 640,
  "height": 360
}`;

/** Examples the user can pick from to seed the editor. */
const EXAMPLES: Array<{ name: string; description: string; spec: string }> = [
  {
    name: "Bar chart",
    description: "Aggregated counts by category",
    spec: DEFAULT_SPEC,
  },
  {
    name: "Histogram",
    description: "Binned distribution of a numeric column",
    spec: `{
  "$schema": "https://uwdata.github.io/mosaic/schema/latest.json",
  "data": {
    "samples": "SELECT random() * 100 AS x FROM range(2000)"
  },
  "plot": [
    { "mark": "rectY",
      "data": { "from": "samples" },
      "x": { "bin": "x" },
      "y": { "count": null } }
  ],
  "width": 640,
  "height": 320
}`,
  },
  {
    name: "Scatter",
    description: "Two numeric columns + categorical color",
    spec: `{
  "$schema": "https://uwdata.github.io/mosaic/schema/latest.json",
  "data": {
    "points": "SELECT random() AS x, random() AS y, (range % 3)::VARCHAR AS g FROM range(300) t(range)"
  },
  "plot": [
    { "mark": "dot",
      "data": { "from": "points" },
      "x": "x", "y": "y", "fill": "g", "r": 3 }
  ],
  "width": 640,
  "height": 480
}`,
  },
  {
    name: "Line chart",
    description: "Time series — one row per step",
    spec: `{
  "$schema": "https://uwdata.github.io/mosaic/schema/latest.json",
  "data": {
    "series": "SELECT range AS t, sin(range / 5.0) AS y FROM range(100) r(range)"
  },
  "plot": [
    { "mark": "lineY", "data": { "from": "series" }, "x": "t", "y": "y" }
  ],
  "width": 640,
  "height": 320
}`,
  },
];

interface Props {
  isActive: boolean;
}

export function MosaicEditor({ isActive }: Props) {
  // Persist the editor across tab switches and (best-effort) across reloads
  // via localStorage. Per-service persistence would be a follow-up; for now
  // it's a single global slot.
  const [text, setText] = useState<string>(() => {
    try { return localStorage.getItem(STORAGE_KEY) || DEFAULT_SPEC; }
    catch { return DEFAULT_SPEC; }
  });
  const [renderedSpec, setRenderedSpec] = useState<any>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const chartRef = useRef<HTMLDivElement>(null);

  // Debounced auto-save to localStorage.
  useEffect(() => {
    const id = setTimeout(() => {
      try { localStorage.setItem(STORAGE_KEY, text); } catch {}
    }, 500);
    return () => clearTimeout(id);
  }, [text]);

  const doRender = useCallback(() => {
    setParseError(null);
    try {
      const spec = JSON.parse(text);
      setRenderedSpec(spec);
    } catch (e: any) {
      setParseError(`Invalid JSON: ${e?.message || String(e)}`);
      setRenderedSpec(null);
    }
  }, [text]);

  // Initial render on first show (if the persisted spec parses).
  useEffect(() => {
    if (!isActive || renderedSpec) return;
    doRender();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);

  // Ctrl/Cmd+Enter triggers render from anywhere on the panel.
  useEffect(() => {
    if (!isActive) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        doRender();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isActive, doRender]);

  const download = useCallback((format: "svg" | "png") => {
    const svg = findChartSvg(chartRef.current);
    if (!svg) return;
    const title = inferTitle(renderedSpec) || "chart";
    if (format === "svg") downloadChartSVG(svg, title);
    else downloadChartPNG(svg, title).catch(console.error);
  }, [renderedSpec]);

  return (
    <div className="flex flex-col h-full bg-background text-foreground">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border bg-card shrink-0">
        <div className="flex items-center gap-1">
          <button
            onClick={doRender}
            className="flex items-center gap-1.5 px-3 py-1 rounded text-sm font-semibold bg-harvest-500 text-white hover:bg-harvest-600 transition-colors cursor-pointer"
            title="Render (Ctrl/Cmd+Enter)"
          >
            <Play className="h-3.5 w-3.5" />
            Render
          </button>
          <ExampleMenu onPick={(spec) => { setText(spec); }} />
          <button
            onClick={() => { setText(DEFAULT_SPEC); setRenderedSpec(null); setParseError(null); }}
            title="Reset to default spec"
            className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="flex items-center gap-1">
          <DownloadMenu onDownload={download} disabled={!renderedSpec} />
          <button
            onClick={() => setFullscreen(true)}
            disabled={!renderedSpec}
            title="Fullscreen"
            className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Split pane */}
      <div className="flex flex-1 min-h-0 divide-x divide-border">
        {/* Editor */}
        <div className="flex flex-col w-1/2 min-w-0">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Tab") {
                e.preventDefault();
                const t = e.currentTarget;
                const s = t.selectionStart, end = t.selectionEnd;
                const next = text.slice(0, s) + "  " + text.slice(end);
                setText(next);
                requestAnimationFrame(() => {
                  t.selectionStart = t.selectionEnd = s + 2;
                });
              }
            }}
            spellCheck={false}
            className="flex-1 min-h-0 p-3 bg-card text-foreground font-mono text-xs leading-relaxed resize-none outline-none border-0"
            placeholder="Paste a Mosaic vgplot JSON spec…"
          />
          {parseError && (
            <div className="flex items-start gap-2 p-2 text-xs text-destructive bg-destructive/5 border-t border-destructive/30">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>{parseError}</span>
            </div>
          )}
        </div>

        {/* Preview */}
        <div className="flex-1 min-w-0 overflow-auto bg-card">
          <ChartPreview spec={renderedSpec} containerRef={chartRef} />
        </div>
      </div>

      {fullscreen && renderedSpec && (
        <FullscreenSpec spec={renderedSpec} onClose={() => setFullscreen(false)} />
      )}
    </div>
  );
}

function ExampleMenu({ onPick }: { onPick: (spec: string) => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);
  return (
    <div className="relative">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        title="Insert example"
        className="flex items-center gap-1 p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer"
      >
        <FilePlus className="h-3.5 w-3.5" />
        <span className="text-xs">Examples</span>
      </button>
      {open && (
        <div
          className="absolute left-0 top-full mt-1 z-10 bg-card border border-border rounded-md shadow-md py-1 w-64"
          onClick={(e) => e.stopPropagation()}
        >
          {EXAMPLES.map((ex) => (
            <button
              key={ex.name}
              onClick={() => { setOpen(false); onPick(ex.spec); }}
              className="block w-full text-left px-3 py-1.5 text-xs hover:bg-muted transition-colors cursor-pointer"
            >
              <div className="font-medium text-foreground">{ex.name}</div>
              <div className="text-[11px] text-muted-foreground">{ex.description}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function DownloadMenu({
  onDownload, disabled,
}: { onDownload: (format: "svg" | "png") => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);
  return (
    <div className="relative">
      <button
        onClick={(e) => { e.stopPropagation(); if (!disabled) setOpen((v) => !v); }}
        disabled={disabled}
        title="Download"
        className="flex items-center gap-1.5 px-2 py-1 rounded text-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Download className="h-3.5 w-3.5" />
        Download
      </button>
      {open && !disabled && (
        <div
          className="absolute right-0 top-full mt-1 z-10 bg-card border border-border rounded-md shadow-md py-1 w-32"
          onClick={(e) => e.stopPropagation()}
        >
          <button onClick={() => { setOpen(false); onDownload("svg"); }} className="block w-full text-left px-3 py-1.5 text-xs hover:bg-muted">SVG</button>
          <button onClick={() => { setOpen(false); onDownload("png"); }} className="block w-full text-left px-3 py-1.5 text-xs hover:bg-muted">PNG</button>
        </div>
      )}
    </div>
  );
}

function ChartPreview({
  spec, containerRef,
}: { spec: any; containerRef: React.RefObject<HTMLDivElement | null> }) {
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!spec) { setStatus("idle"); return; }
    let cancelled = false;
    let viewEl: any = null;
    setStatus("loading");
    setError(null);
    (async () => {
      try {
        const result = await renderChartSpec(spec);
        if (cancelled) return;
        if (result.errors.length > 0) {
          setError(result.errors[0].message);
          setStatus("error");
          return;
        }
        viewEl = result.element;
        if (containerRef.current) {
          containerRef.current.innerHTML = "";
          containerRef.current.appendChild(viewEl as Node);
        }
        setStatus("ready");
      } catch (e: any) {
        if (cancelled) return;
        setError(e?.message || String(e));
        setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
      try { viewEl?.destroy?.() ?? viewEl?.dispose?.(); } catch {}
    };
  }, [spec, containerRef]);

  return (
    <div className="h-full flex items-center justify-center p-6">
      {status === "idle" && (
        <div className="text-muted-foreground text-sm">Press <kbd className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">⌘ Enter</kbd> or click <strong>Render</strong> to draw the spec.</div>
      )}
      {status === "loading" && (
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Rendering…
        </div>
      )}
      {status === "error" && (
        <div className="flex items-start gap-2 text-destructive text-sm max-w-md">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <div className="font-medium">Chart failed to render</div>
            <div className="text-xs mt-1 break-words font-mono">{error}</div>
          </div>
        </div>
      )}
      <div ref={containerRef} className={status === "ready" ? "" : "hidden"} />
    </div>
  );
}

function FullscreenSpec({ spec, onClose }: { spec: any; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState(() => ({
    width: Math.min(1400, window.innerWidth - 80),
    height: Math.max(400, window.innerHeight - 160),
  }));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const onResize = () => setDims({
      width: Math.min(1400, window.innerWidth - 80),
      height: Math.max(400, window.innerHeight - 160),
    });
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  const scaled = { ...spec, width: dims.width, height: dims.height };

  const download = (format: "svg" | "png") => {
    const svg = findChartSvg(ref.current);
    if (!svg) return;
    const title = inferTitle(spec) || "chart";
    if (format === "svg") downloadChartSVG(svg, title);
    else downloadChartPNG(svg, title).catch(console.error);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="flex items-center justify-between px-4 h-12 border-b border-border bg-card shrink-0" onClick={(e) => e.stopPropagation()}>
        <div className="font-heading text-base font-semibold truncate">{inferTitle(spec) || "Chart"}</div>
        <div className="flex items-center gap-1">
          <DownloadMenu onDownload={download} />
          <button onClick={onClose} className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted" title="Close (Esc)">
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-auto flex items-center justify-center p-6" onClick={(e) => e.stopPropagation()}>
        <ChartPreview spec={scaled} containerRef={ref} />
      </div>
    </div>
  );
}

/** Best-effort: pull a title out of meta.title / params.title / first plot name. */
function inferTitle(spec: any): string | null {
  return spec?.meta?.title || spec?.title || null;
}
