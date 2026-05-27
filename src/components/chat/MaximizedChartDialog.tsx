/**
 * Full-screen maximize view for a Vega chart.
 *
 * Each embed is independent — there's no easy "share one view across two
 * mount points" in Vega — but both views read from the same chart-rows-store
 * entry. The dialog's refresh button updates the shared cache and re-runs
 * the embed inside the dialog; the inline view picks up the new fetchedAt
 * via the parent's onUpdate path and will reflect the new rows when next
 * re-embedded (or via the inline refresh button).
 */
import { useEffect, useRef } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RotateCw, FileImage, Image as ImageIcon, Loader2 } from "lucide-react";
import type { VegaChartContent } from "./ChatMessageAssistant";
import { getChartRows } from "@/lib/chart-rows-store";
import { embedChart, downloadPNG, downloadSVG, type VegaView } from "./chart-embed";

interface Props {
  chart: VegaChartContent;
  onClose: () => void;
  onRefresh: () => void;
  refreshing: boolean;
}

export function MaximizedChartDialog({ chart, onClose, onRefresh, refreshing }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<VegaView | null>(null);

  // Re-embed the chart in the larger container. Vega doesn't reflow on
  // container resize, so the dialog gets its own view that lives for the
  // dialog's lifetime.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const effectId = Symbol();
    let myEffectId: Symbol | null = effectId;

    (async () => {
      const cached = getChartRows(chart.chartId);
      const rows = cached?.rows ?? [];
      try {
        const view = await embedChart(el, chart.spec, rows);
        if (myEffectId !== effectId) {
          view.finalize();
          return;
        }
        viewRef.current = view;
      } catch {
        // Error is already surfaced via the inline block's error state.
      }
    })();

    return () => {
      myEffectId = null;
      const v = viewRef.current;
      viewRef.current = null;
      if (v) v.finalize();
    };
  }, [chart.chartId, chart.spec, chart.fetchedAt]);

  const handlePNG = async () => {
    const v = viewRef.current;
    if (v) await downloadPNG(v, chart.title || "chart");
  };
  const handleSVG = async () => {
    const v = viewRef.current;
    if (v) await downloadSVG(v, chart.title || "chart");
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-[90vw] w-[90vw] h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <span className="flex-1 truncate text-base">{chart.title ?? "Chart"}</span>
            <div className="flex items-center gap-1 mr-6">
              <button
                onClick={onRefresh}
                disabled={refreshing}
                title="Refresh from DuckDB"
                className="p-1.5 rounded hover:bg-foreground/5 disabled:opacity-40 transition-colors"
              >
                {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}
              </button>
              <button
                onClick={handlePNG}
                title="Download PNG"
                className="p-1.5 rounded hover:bg-foreground/5 transition-colors"
              >
                <ImageIcon className="h-4 w-4" />
              </button>
              <button
                onClick={handleSVG}
                title="Download SVG"
                className="p-1.5 rounded hover:bg-foreground/5 transition-colors"
              >
                <FileImage className="h-4 w-4" />
              </button>
            </div>
          </DialogTitle>
        </DialogHeader>
        {chart.error && (
          <div className="px-3 py-2 mb-2 border border-destructive/30 bg-destructive/10 text-xs rounded">
            <div className="font-medium text-destructive">Refresh failed</div>
            <div className="text-destructive/90 mt-1">{chart.error}</div>
          </div>
        )}
        <div ref={containerRef} className="flex-1 min-h-0 overflow-auto flex items-center justify-center" />
        <div className="text-[11px] text-muted-foreground/70 flex items-center gap-2 pt-1">
          <span>{chart.rowCount.toLocaleString()} rows</span>
          <span>·</span>
          <code className="bg-muted/50 px-1.5 py-0.5 rounded text-foreground/70 max-w-full truncate">{chart.sql}</code>
        </div>
      </DialogContent>
    </Dialog>
  );
}
