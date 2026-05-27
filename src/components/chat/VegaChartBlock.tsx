/**
 * Inline Vega-Lite chart block rendered in the AskAIChat conversation.
 *
 * Lifecycle:
 *  - The render_chart tool in AskAIChat.executeTool runs the SQL up front
 *    and caches rows via cacheChartRows(). On mount we read those rows
 *    synchronously (no race) and embed.
 *  - Refresh re-runs the SQL via refreshChartRows() and swaps rows in via
 *    Vega's `view.change()` — no remount, no flash.
 *  - The view ref is held locally; cleanup calls view.finalize() to release
 *    the canvas/SVG and any signal handlers.
 *
 * The vega-embed module is dynamically imported on first chart render so
 * the Vega runtime stays out of the eager bundle. The TopLevelSpec type
 * is also referenced only here (not in ChatMessageAssistant) so the
 * vega-lite type metadata doesn't sneak into the entry chunk either.
 */
import { useEffect, useRef, useState, useCallback } from "react";
import { RotateCw, Maximize2, FileImage, Image as ImageIcon, Loader2 } from "lucide-react";
import type { VegaChartContent } from "./ChatMessageAssistant";
import { getChartRows, refreshChartRows } from "@/lib/chart-rows-store";
import { MaximizedChartDialog } from "./MaximizedChartDialog";
import { embedChart, downloadPNG, downloadSVG, type VegaView } from "./chart-embed";

interface Props {
  chart: VegaChartContent;
  /** Patch the parent block's chart metadata (fetchedAt, rowCount, error). */
  onUpdate: (patch: Partial<VegaChartContent>) => void;
}

export function VegaChartBlock({ chart, onUpdate }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<VegaView | null>(null);
  const isMountedRef = useRef(true);
  const [refreshing, setRefreshing] = useState(false);
  const [maximized, setMaximized] = useState(false);

  // Embed the chart whenever the spec changes (rare — usually only on first
  // mount since rows are updated via view.change(), not by re-embedding).
  useEffect(() => {
    isMountedRef.current = true;
    const el = containerRef.current;
    if (!el) return;

    // Strict-mode-safe: capture an effect-local token; ignore late embed
    // resolutions that belong to a previous effect run.
    const effectId = Symbol();
    let myEffectId: Symbol | null = effectId;

    (async () => {
      const cached = getChartRows(chart.chartId);
      const rows = cached?.rows ?? [];
      try {
        const view = await embedChart(el, chart.spec, rows);
        if (myEffectId !== effectId) {
          // Effect was cleaned up while we awaited — discard.
          view.finalize();
          return;
        }
        viewRef.current = view;
      } catch (err) {
        if (myEffectId !== effectId || !isMountedRef.current) return;
        onUpdate({ error: err instanceof Error ? err.message : String(err) });
      }
    })();

    return () => {
      myEffectId = null;
      isMountedRef.current = false;
      const v = viewRef.current;
      viewRef.current = null;
      if (v) v.finalize();
    };
    // chart.spec identity should be stable unless the LLM emits a brand-new
    // chart (which gets a new block id anyway); we still re-run on spec
    // changes to be safe. chartId is part of the key so block reuse can't
    // accidentally share a view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart.chartId]);

  // Refresh = re-run the SQL and stream new rows into the existing view.
  // Keeps the chart on screen during the fetch (no skeleton flash).
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const result = await refreshChartRows(chart.chartId, chart.sql);
      if (!isMountedRef.current) return;
      if ("error" in result) {
        onUpdate({ error: result.error });
        return;
      }
      onUpdate({ rowCount: result.rows.length, columns: result.columns, fetchedAt: Date.now(), error: undefined });
      // Swap the dataset without remounting the view.
      const v = viewRef.current;
      if (v) {
        // The lazy embedChart helper exposes the vega module on the view
        // for changeset construction.
        const vega = (v as any).__vega;
        await v.change("source_0", vega.changeset().remove(() => true).insert(result.rows)).runAsync();
      }
    } finally {
      if (isMountedRef.current) setRefreshing(false);
    }
  }, [chart.chartId, chart.sql, onUpdate]);

  const handlePNG = useCallback(async () => {
    const v = viewRef.current;
    if (!v) return;
    await downloadPNG(v, chart.title || "chart");
  }, [chart.title]);

  const handleSVG = useCallback(async () => {
    const v = viewRef.current;
    if (!v) return;
    await downloadSVG(v, chart.title || "chart");
  }, [chart.title]);

  return (
    <>
      <div className="border border-border rounded-md bg-card overflow-hidden">
        {/* Header: title + toolbar */}
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/60 bg-muted/30">
          <div className="flex-1 text-xs font-medium truncate">
            {chart.title ?? "Chart"}
          </div>
          <ToolbarButton onClick={handleRefresh} disabled={refreshing} title="Refresh from DuckDB">
            {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCw className="h-3.5 w-3.5" />}
          </ToolbarButton>
          <ToolbarButton onClick={() => setMaximized(true)} title="Maximize">
            <Maximize2 className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton onClick={handlePNG} title="Download PNG">
            <ImageIcon className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton onClick={handleSVG} title="Download SVG">
            <FileImage className="h-3.5 w-3.5" />
          </ToolbarButton>
        </div>

        {/* Error banner (chart from last successful fetch stays visible below) */}
        {chart.error && (
          <div className="px-3 py-2 border-b border-destructive/30 bg-destructive/10 text-xs">
            <div className="font-medium text-destructive">Refresh failed</div>
            <div className="text-destructive/90 mt-1">{chart.error}</div>
            <pre className="mt-1.5 p-1.5 rounded bg-background/60 overflow-x-auto text-[10px] text-foreground/70">{chart.sql}</pre>
          </div>
        )}

        {/* Chart container — fixed height for predictable layout in chat */}
        <div ref={containerRef} className="px-3 py-2 min-h-[280px] flex items-center justify-center" />

        {/* Footer: row count + relative timestamp */}
        <div className="px-3 py-1 border-t border-border/60 text-[10px] text-muted-foreground/70 flex items-center gap-2">
          <span>{chart.rowCount.toLocaleString()} row{chart.rowCount === 1 ? "" : "s"}</span>
          <span>·</span>
          <RelativeTime fetchedAt={chart.fetchedAt} />
        </div>
      </div>

      {maximized && (
        <MaximizedChartDialog
          chart={chart}
          onClose={() => setMaximized(false)}
          onRefresh={handleRefresh}
          refreshing={refreshing}
        />
      )}
    </>
  );
}

function ToolbarButton({
  children, onClick, disabled, title,
}: { children: React.ReactNode; onClick: () => void; disabled?: boolean; title: string }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="p-1 rounded hover:bg-foreground/5 disabled:opacity-40 transition-colors"
    >
      {children}
    </button>
  );
}

function RelativeTime({ fetchedAt }: { fetchedAt: number }) {
  const [, force] = useState(0);
  // Tick once a minute so the relative timestamp ages live.
  useEffect(() => {
    const t = setInterval(() => force((x) => x + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  return <span>Refreshed {formatRelative(Date.now() - fetchedAt)}</span>;
}

function formatRelative(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}
