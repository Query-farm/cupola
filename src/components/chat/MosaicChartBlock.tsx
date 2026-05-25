import { useEffect, useRef, useState } from "react";
import { Loader2, AlertCircle, ChevronDown, Code2 } from "lucide-react";
import { renderChartSpec } from "@/lib/mosaic-bridge";

/**
 * Renders a Mosaic vgplot spec inline in the chat. The first chart per
 * page-load triggers the lazy Mosaic chunk download (~400KB gzipped);
 * subsequent charts mount immediately because `getMosaicAPI()` caches the
 * context. We mount the resulting DOM element via appendChild rather than
 * dangerouslySetInnerHTML because vgplot's output is a live DOM tree with
 * its own event listeners.
 */
export function MosaicChartBlock({
  spec, title,
}: { spec: any; title?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [showSpec, setShowSpec] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let viewEl: any = null;

    (async () => {
      try {
        // renderChartSpec parses + instantiates the spec, runs any data
        // queries through HaybarnConnector → DuckDB, and returns the live
        // DOM tree wired to the Coordinator.
        const el = await renderChartSpec(spec);
        if (cancelled) return;
        viewEl = el;
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
      // Best-effort cleanup. vgplot views may or may not expose destroy/dispose.
      try {
        if (viewEl?.destroy) viewEl.destroy();
        else if (viewEl?.dispose) viewEl.dispose();
      } catch {}
    };
  }, [spec]);

  return (
    <div className="border border-border rounded-lg bg-card overflow-hidden">
      {/* Header row: title + spec-toggle */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/30">
        <div className="font-heading text-sm font-semibold truncate">
          {title || "Chart"}
        </div>
        <button
          onClick={() => setShowSpec((v) => !v)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          title={showSpec ? "Hide spec" : "Show spec"}
        >
          <Code2 className="h-3 w-3" />
          <ChevronDown className={`h-3 w-3 transition-transform ${showSpec ? "" : "-rotate-90"}`} />
        </button>
      </div>

      {/* Optional spec viewer */}
      {showSpec && (
        <pre className="text-[11px] font-mono bg-muted/50 border-b border-border px-3 py-2 overflow-x-auto max-h-48">
          {JSON.stringify(spec, null, 2)}
        </pre>
      )}

      {/* Chart body */}
      <div className="p-3">
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
      </div>
    </div>
  );
}
