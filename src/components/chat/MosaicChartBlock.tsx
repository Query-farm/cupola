import { useEffect, useRef, useState } from "react";
import {
  Loader2, AlertCircle, ChevronDown, Code2,
  Maximize2, X, Download, RotateCw, Eye, EyeOff,
} from "lucide-react";
import { renderChartSpec } from "@/lib/mosaic-bridge";
import { findChartSvg, downloadChartSVG, downloadChartPNG } from "@/lib/chart-export";

/** Watch interval options (ms). 0 = off. */
const WATCH_INTERVALS_MS: Array<{ label: string; ms: number }> = [
  { label: "Off", ms: 0 },
  { label: "5s", ms: 5_000 },
  { label: "30s", ms: 30_000 },
  { label: "1m", ms: 60_000 },
];

/**
 * Renders a Mosaic vgplot spec inline in the chat. The first chart per
 * page-load triggers the lazy Mosaic chunk download (~500KB); subsequent
 * charts mount immediately because `getMosaicAPI()` caches the context.
 *
 * Controls on the chart header:
 *   - Refresh: re-runs the spec's data queries. Useful when the underlying
 *     catalog data has changed (e.g. an Iceberg snapshot was advanced).
 *   - Watch: cycles an auto-refresh interval (Off → 5s → 30s → 1m → Off).
 *   - Maximize: opens a viewport-scaled fullscreen overlay re-rendering
 *     the chart at modal dimensions.
 *   - Download: dropdown with SVG (vector, lossless) and PNG (2× rasterized).
 *   - Spec: toggle to show the raw JSON spec the AI emitted.
 */
export function MosaicChartBlock({
  spec, title,
}: { spec: any; title?: string }) {
  const [showSpec, setShowSpec] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [watchIdx, setWatchIdx] = useState(0); // index into WATCH_INTERVALS_MS
  const inlineRef = useRef<HTMLDivElement>(null);

  const downloadInline = (format: "svg" | "png") => {
    runDownload(format, title, inlineRef.current);
  };

  // Auto-refresh tick when Watch is on.
  useEffect(() => {
    const ms = WATCH_INTERVALS_MS[watchIdx].ms;
    if (!ms) return;
    const id = setInterval(() => setRefreshKey((k) => k + 1), ms);
    return () => clearInterval(id);
  }, [watchIdx]);

  return (
    <>
      <div className="border border-border rounded-lg bg-card overflow-hidden">
        <ChartHeader
          title={title}
          showSpec={showSpec}
          watchLabel={WATCH_INTERVALS_MS[watchIdx].label}
          watching={watchIdx > 0}
          onToggleSpec={() => setShowSpec((v) => !v)}
          onMaximize={() => setFullscreen(true)}
          onDownload={downloadInline}
          onRefresh={() => setRefreshKey((k) => k + 1)}
          onCycleWatch={() => setWatchIdx((i) => (i + 1) % WATCH_INTERVALS_MS.length)}
        />

        {showSpec && (
          <pre className="text-[11px] font-mono bg-muted/50 border-b border-border px-3 py-2 overflow-x-auto max-h-48">
            {JSON.stringify(spec, null, 2)}
          </pre>
        )}

        <div className="p-3">
          <ChartCanvas spec={spec} containerRef={inlineRef} refreshKey={refreshKey} />
        </div>
      </div>

      {fullscreen && (
        <FullscreenChart
          spec={spec}
          title={title}
          onClose={() => setFullscreen(false)}
        />
      )}
    </>
  );
}

// --- pieces -----------------------------------------------------------------

interface HeaderProps {
  title?: string;
  showSpec: boolean;
  watchLabel: string;
  watching: boolean;
  onToggleSpec: () => void;
  onMaximize: () => void;
  onDownload: (format: "svg" | "png") => void;
  onRefresh: () => void;
  onCycleWatch: () => void;
}

function ChartHeader({
  title, showSpec, watchLabel, watching,
  onToggleSpec, onMaximize, onDownload, onRefresh, onCycleWatch,
}: HeaderProps) {
  return (
    <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/30">
      <div className="flex items-center gap-2 min-w-0">
        <div className="font-heading text-sm font-semibold truncate">
          {title || "Chart"}
        </div>
        {watching && (
          <span className="flex items-center gap-1 text-[10px] font-mono text-harvest-700 dark:text-harvest-400" title={`Auto-refresh every ${watchLabel}`}>
            <span className="w-1.5 h-1.5 rounded-full bg-harvest-500 animate-pulse" />
            {watchLabel}
          </span>
        )}
      </div>
      <div className="flex items-center gap-0.5 shrink-0">
        <IconButton title="Refresh chart" onClick={(e) => { e.stopPropagation(); onRefresh(); }}>
          <RotateCw className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton
          title={watching ? `Watching: ${watchLabel} (click to cycle)` : "Watch — auto-refresh"}
          onClick={(e) => { e.stopPropagation(); onCycleWatch(); }}
        >
          {watching
            ? <Eye className="h-3.5 w-3.5 text-harvest-600 dark:text-harvest-400" />
            : <EyeOff className="h-3.5 w-3.5" />}
        </IconButton>
        <IconButton title="Fullscreen" onClick={onMaximize}>
          <Maximize2 className="h-3.5 w-3.5" />
        </IconButton>
        <DownloadMenu onDownload={onDownload} compact />
        <IconButton title={showSpec ? "Hide spec" : "Show spec"} onClick={onToggleSpec}>
          <Code2 className="h-3.5 w-3.5" />
          <ChevronDown className={`h-3 w-3 transition-transform ${showSpec ? "" : "-rotate-90"}`} />
        </IconButton>
      </div>
    </div>
  );
}

function IconButton({
  children, onClick, title,
}: { children: React.ReactNode; onClick: (e: React.MouseEvent) => void; title: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="flex items-center gap-0.5 p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer"
    >
      {children}
    </button>
  );
}

function MenuItem({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="block w-full text-left px-3 py-1.5 text-xs hover:bg-muted transition-colors cursor-pointer"
    >
      {children}
    </button>
  );
}

/** Download button with a pop-over menu of formats. Compact mode is icon-only. */
function DownloadMenu({
  onDownload, compact,
}: { onDownload: (format: "svg" | "png") => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onClick = () => setOpen(false);
    window.addEventListener("click", onClick);
    return () => window.removeEventListener("click", onClick);
  }, [open]);

  return (
    <div className="relative">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        title="Download"
        className={
          compact
            ? "flex items-center gap-0.5 p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer"
            : "flex items-center gap-1.5 px-2 py-1 rounded text-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer"
        }
      >
        <Download className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
        {!compact && "Download"}
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-10 bg-card border border-border rounded-md shadow-md py-1 w-32"
          onClick={(e) => e.stopPropagation()}
        >
          <MenuItem onClick={() => { setOpen(false); onDownload("svg"); }}>SVG</MenuItem>
          <MenuItem onClick={() => { setOpen(false); onDownload("png"); }}>PNG</MenuItem>
        </div>
      )}
    </div>
  );
}

/**
 * Mounts a Mosaic-rendered chart into a div. Re-runs whenever `spec`
 * changes. The parent owns the container ref so it can read the rendered
 * SVG out of the DOM for export.
 */
function ChartCanvas({
  spec, containerRef, refreshKey = 0,
}: {
  spec: any;
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Bumping this forces a re-render — used by the Refresh button and the
   *  Watch interval. The spec itself doesn't change, but DuckDB may have
   *  fresher data now. */
  refreshKey?: number;
}) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let viewEl: any = null;
    // Preserve the previous chart while re-rendering on a refresh so the
    // user doesn't see a "Rendering chart…" flash for every tick of a
    // Watch interval. Only show the loading state on the initial render.
    if (!containerRef.current?.firstChild) setStatus("loading");
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
        if (containerRef.current && viewEl) {
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
      try {
        if (viewEl?.destroy) viewEl.destroy();
        else if (viewEl?.dispose) viewEl.dispose();
      } catch {}
    };
  }, [spec, containerRef, refreshKey]);

  return (
    <>
      {status === "loading" && (
        <div className="flex items-center gap-2 h-40 justify-center text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Rendering chart…</span>
        </div>
      )}
      {status === "error" && (
        <div className="flex items-start gap-2 text-destructive text-sm">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <div className="font-medium">Chart failed to render</div>
            <div className="text-xs mt-1 break-words">{error}</div>
          </div>
        </div>
      )}
      <div ref={containerRef} className={status === "ready" ? "" : "hidden"} />
    </>
  );
}

/**
 * Fullscreen overlay. Clones the spec and overrides width/height so the
 * chart re-renders at viewport scale rather than just CSS-scaling the
 * inline SVG (which would blur raster marks). ESC closes; click on the
 * backdrop closes; close button in the corner closes.
 */
function FullscreenChart({
  spec, title, onClose,
}: { spec: any; title?: string; onClose: () => void }) {
  const fsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  // Compute fullscreen dimensions. Reserve room for the header + padding.
  const [dims, setDims] = useState(() => ({
    width: Math.min(1400, window.innerWidth - 80),
    height: Math.max(400, window.innerHeight - 160),
  }));
  useEffect(() => {
    const onResize = () => setDims({
      width: Math.min(1400, window.innerWidth - 80),
      height: Math.max(400, window.innerHeight - 160),
    });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const scaledSpec = scaleSpecForFullscreen(spec, dims);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex items-center justify-between px-4 h-12 border-b border-border bg-card shrink-0"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="font-heading text-base font-semibold truncate">
          {title || "Chart"}
        </div>
        <div className="flex items-center gap-1">
          <DownloadMenu onDownload={(format) => runDownload(format, title, fsRef.current)} />
          <button
            onClick={onClose}
            title="Close (Esc)"
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      <div
        className="flex-1 overflow-auto flex items-center justify-center p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <ChartCanvas spec={scaledSpec} containerRef={fsRef} />
      </div>
    </div>
  );
}

/**
 * Override width/height inside a spec for fullscreen rendering. Mosaic
 * accepts dimensions at the top level for single-plot specs, so we set
 * those. Specs with `vconcat` / `hconcat` will keep their per-plot sizes
 * unless they read top-level dims — out of scope to deeply rewrite here.
 */
function scaleSpecForFullscreen(spec: any, dims: { width: number; height: number }): any {
  if (!spec || typeof spec !== "object") return spec;
  return { ...spec, width: dims.width, height: dims.height };
}

function runDownload(
  format: "svg" | "png",
  title: string | undefined,
  container: HTMLElement | null,
) {
  const svg = findChartSvg(container);
  if (!svg) {
    console.warn("[chart] download failed — no SVG element found");
    return;
  }
  const t = title || "chart";
  if (format === "svg") {
    downloadChartSVG(svg, t);
  } else {
    downloadChartPNG(svg, t).catch((e) => console.error("[chart] PNG export failed:", e));
  }
}
