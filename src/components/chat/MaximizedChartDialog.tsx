/**
 * Full-screen maximize view for a Vega chart.
 *
 * Each embed is independent — there's no easy "share one view across two
 * mount points" in Vega — but both views read from the same chart-rows-store
 * entry. The dialog's refresh button updates the shared cache and re-runs
 * the embed inside the dialog; the inline view picks up the new fetchedAt
 * via the parent's onUpdate path and will reflect the new rows when next
 * re-embedded (or via the inline refresh button).
 *
 * Sizing: Vega doesn't reflow on container resize. We embed once the
 * container has nonzero dimensions (typically takes one rAF after the
 * Dialog mounts), and re-embed if the window resizes.
 */
import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RotateCw, Loader2 } from "lucide-react";
import type { VegaChartContent } from "./ChatMessageAssistant";
import { getChartRows } from "@/lib/chart-rows-store";
import { embedChart, downloadPNG, downloadSVG, type VegaView } from "./chart-embed";
import { ChartDownloadMenu } from "./ChartDownloadMenu";

interface Props {
  chart: VegaChartContent;
  onClose: () => void;
  onRefresh: () => void;
  refreshing: boolean;
}

export function MaximizedChartDialog({ chart, onClose, onRefresh, refreshing }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<VegaView | null>(null);

  // Use a ref-callback to react to the container DOM node being mounted by
  // the dialog portal. Effects don't fire reliably for portaled content
  // (timing of "container exists" vs "useEffect runs after portal mount"
  // is fragile). Ref-callback fires synchronously when React attaches the
  // node, which is the right moment to start watching for layout.
  const onContainerRef = (node: HTMLDivElement | null) => {
    containerRef.current = node;
    if (!node) {
      const v = viewRef.current;
      viewRef.current = null;
      if (v) v.finalize();
      return;
    }
    // Already attached on a previous render; don't double-embed.
    if (viewRef.current) return;
    void embedIntoContainer(node);
  };

  const embedIntoContainer = async (el: HTMLElement) => {
    // Defer until layout: dialog open transitions can produce a 0-width
    // container for the first frame.
    while (el.clientWidth < 50) {
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      if (!containerRef.current || containerRef.current !== el) return;
    }
    if (!containerRef.current || containerRef.current !== el) return;
    const cached = getChartRows(chart.chartId);
    const rows = cached?.rows ?? [];
    try {
      const view = await embedChart(el, chart.spec, rows);
      if (!containerRef.current || containerRef.current !== el) {
        view.finalize();
        return;
      }
      viewRef.current = view;
    } catch (err) {
      console.error("[MaximizedChartDialog] embed failed:", err);
    }
  };

  // Re-embed on window resize so the chart picks up the new dialog size.
  useEffect(() => {
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const onResize = () => {
      const el = containerRef.current;
      if (!el) return;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (viewRef.current) {
          viewRef.current.finalize();
          viewRef.current = null;
        }
        if (containerRef.current) void embedIntoContainer(containerRef.current);
      }, 100);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (resizeTimer) clearTimeout(resizeTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When the underlying data refreshes (parent updates chart.fetchedAt),
  // re-embed with the new rows.
  useEffect(() => {
    if (!containerRef.current) return;
    if (viewRef.current) {
      viewRef.current.finalize();
      viewRef.current = null;
    }
    void embedIntoContainer(containerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart.fetchedAt]);

  const handleDownload = async (format: "png" | "svg") => {
    const v = viewRef.current;
    if (!v) return;
    if (format === "png") await downloadPNG(v, chart.title || "chart");
    else await downloadSVG(v, chart.title || "chart");
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        className="!max-w-[90vw] !w-[90vw] !h-[85vh] flex flex-col p-4 gap-2"
        data-testid="vega-chart-maximize-dialog"
      >
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-3 text-base">
            <span className="flex-1 truncate">{chart.title ?? "Chart"}</span>
            <div className="flex items-center gap-1 mr-6">
              <button
                onClick={onRefresh}
                disabled={refreshing}
                title="Refresh from DuckDB"
                data-testid="chart-maximize-refresh"
                className="p-1.5 rounded hover:bg-foreground/5 disabled:opacity-40 transition-colors"
              >
                {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}
              </button>
              <ChartDownloadMenu onDownload={handleDownload} size="md" testId="chart-maximize-download" />
            </div>
          </DialogTitle>
        </DialogHeader>
        {chart.error && (
          <div className="px-3 py-2 border border-destructive/30 bg-destructive/10 text-xs rounded shrink-0">
            <div className="font-medium text-destructive">Refresh failed</div>
            <div className="text-destructive/90 mt-1">{chart.error}</div>
          </div>
        )}
        {/* Chart container — fills remaining dialog space. The w-full is
            critical: width:"container" in the Vega spec resolves against
            offsetWidth at embed time. */}
        <div
          ref={onContainerRef}
          data-testid="vega-chart-maximize-container"
          className="flex-1 min-h-0 w-full overflow-auto"
        />
        <div className="text-[11px] text-muted-foreground/70 flex items-center gap-2 pt-1 shrink-0">
          <span>{chart.rowCount.toLocaleString()} rows</span>
          <span>·</span>
          <code className="bg-muted/50 px-1.5 py-0.5 rounded text-foreground/70 max-w-full truncate flex-1">{chart.sql}</code>
        </div>
      </DialogContent>
    </Dialog>
  );
}
