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
import { memo, useEffect, useRef, useState, useCallback } from "react";
import { RotateCw, Maximize2, Download, Loader2 } from "lucide-react";
import type { VegaChartContent } from "./ChatMessageAssistant";
import { getChartRows, getChartExtras, refreshChartRows, refreshChartExtra } from "@/lib/chart-rows-store";
import { MaximizedChartDialog } from "./MaximizedChartDialog";
import { embedChart, downloadPNG, downloadSVG, sanitizeRowsForVega, CUPOLA_DATA_NAME, type VegaView } from "./chart-embed";
import { ChartDownloadMenu } from "./ChartDownloadMenu";

interface Props {
  chart: VegaChartContent;
  /** Patch the parent block's chart metadata (fetchedAt, rowCount, error). */
  onUpdate: (patch: Partial<VegaChartContent>) => void;
}

function VegaChartBlockImpl({ chart, onUpdate }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<VegaView | null>(null);
  const isMountedRef = useRef(true);
  const [refreshing, setRefreshing] = useState(false);
  const [maximized, setMaximized] = useState(false);

  // Ref-callback: fires synchronously when React attaches the DOM node.
  // We rely on vega-embed's own resize handling (autosize.resize: true in
  // the spec) to track container width changes after the initial embed —
  // an additional ResizeObserver here caused flicker because the chart's
  // height-grow on autosize:fit-x triggers a chat scrollbar toggle, which
  // changes container width by ~scrollbar-px, which fires the observer,
  // which tears down and re-embeds, which changes height again, etc.
  // Vega's internal handler updates width without a full re-embed, so it
  // doesn't loop.
  const containerNodeRef = useRef<HTMLDivElement | null>(null);

  const onContainerRef = (node: HTMLDivElement | null) => {
    containerNodeRef.current = node;
    containerRef.current = node;
    if (!node) {
      const v = viewRef.current;
      viewRef.current = null;
      if (v) v.finalize();
      return;
    }
    // Already embedded on a previous render — vega-embed handles resize
    // internally, no need to re-trigger.
    if (viewRef.current) return;
    void doEmbed(node);
  };

  const doEmbed = async (el: HTMLElement) => {
    if (containerNodeRef.current !== el) return;
    // Wait for the container to have a real width — flex/grid layout
    // sometimes lands the ref before the parent has been measured.
    let attempts = 0;
    while (el.clientWidth < 50 && attempts < 30) {
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      if (containerNodeRef.current !== el) return;
      attempts++;
    }
    if (viewRef.current) {
      viewRef.current.finalize();
      viewRef.current = null;
    }
    const cached = getChartRows(chart.chartId);
    const rows = cached?.rows ?? [];
    const extrasMap = getChartExtras(chart.chartId);
    const extraDatasets = extrasMap.size > 0
      ? Object.fromEntries(Array.from(extrasMap, ([name, ds]) => [name, ds.rows]))
      : undefined;
    try {
      const view = await embedChart(el, chart.spec, rows, extraDatasets);
      if (containerNodeRef.current !== el) {
        view.finalize();
        return;
      }
      viewRef.current = view;
    } catch (err) {
      if (containerNodeRef.current !== el || !isMountedRef.current) return;
      onUpdate({ error: err instanceof Error ? err.message : String(err) });
    }
  };

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // Re-embed when the SPEC changes (e.g. a brand-new chartId — but blocks
  // usually have stable chartId, so this is rare). chart.fetchedAt changes
  // trigger view.change() via handleRefresh, NOT a full re-embed.
  useEffect(() => {
    const el = containerNodeRef.current;
    if (!el) return;
    void doEmbed(el);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart.chartId, chart.spec]);

  // Refresh = re-run the primary SQL AND every extra dataset's SQL, then
  // stream the new rows into the existing view via chained view.change
  // calls. Keeps the chart on screen during the fetch (no skeleton flash).
  // All datasets update in a single Vega tick so multi-source charts
  // don't flicker between primary-updated and extras-updated states.
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      // Run primary + all extras in parallel. DuckDB-WASM serializes
      // internally on a single connection; Promise.all just keeps the
      // code tidy.
      const [primaryResult, ...extraResults] = await Promise.all([
        refreshChartRows(chart.chartId, chart.sql),
        ...(chart.extraSources ?? []).map((e) =>
          refreshChartExtra(chart.chartId, e.name, e.sql),
        ),
      ]);
      if (!isMountedRef.current) return;

      if ("error" in primaryResult) {
        onUpdate({ error: primaryResult.error });
        return;
      }
      // If any extra failed, surface it but still update the rest.
      const extraErrors = extraResults
        .map((r, i) => ("error" in r ? `${chart.extraSources![i].name}: ${r.error}` : null))
        .filter((s): s is string => s !== null);
      if (extraErrors.length > 0) {
        onUpdate({ error: `Extra dataset refresh failed — ${extraErrors.join("; ")}` });
        return;
      }

      // All good. Update the block metadata.
      const successfulExtras = extraResults.map((r, i) => ({
        ...chart.extraSources![i],
        rowCount: "rows" in r ? r.rows.length : chart.extraSources![i].rowCount,
        columns: "rows" in r ? r.columns : chart.extraSources![i].columns,
      }));
      onUpdate({
        rowCount: primaryResult.rows.length,
        columns: primaryResult.columns,
        fetchedAt: Date.now(),
        error: undefined,
        extraSources: successfulExtras.length > 0 ? successfulExtras : undefined,
      });

      // Stream rows into the existing view via chained view.change calls.
      // Wrap each in sanitizeRowsForVega — the rows from readRows are
      // already JSON-safe, but refresh paths historically forgot this.
      const v = viewRef.current;
      if (v) {
        const vega = (v as any).__vega;
        let chained: any = v.change(
          CUPOLA_DATA_NAME,
          vega.changeset().remove(() => true).insert(sanitizeRowsForVega(primaryResult.rows)),
        );
        extraResults.forEach((r, i) => {
          if ("rows" in r) {
            const name = chart.extraSources![i].name;
            chained = chained.change(
              name,
              vega.changeset().remove(() => true).insert(sanitizeRowsForVega(r.rows)),
            );
          }
        });
        await chained.runAsync();
      }
    } finally {
      if (isMountedRef.current) setRefreshing(false);
    }
  }, [chart.chartId, chart.sql, chart.extraSources, onUpdate]);

  const handleDownload = useCallback(async (format: "png" | "svg") => {
    const v = viewRef.current;
    if (!v) return;
    if (format === "png") await downloadPNG(v, chart.title || "chart");
    else await downloadSVG(v, chart.title || "chart");
  }, [chart.title]);

  return (
    <>
      <div className="border border-border rounded-md bg-card overflow-hidden w-full" data-testid="vega-chart-block">
        {/* Header: title + toolbar */}
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/60 bg-muted/30">
          <div className="flex-1 text-xs font-medium truncate">
            {chart.title ?? "Chart"}
          </div>
          <ToolbarButton onClick={handleRefresh} disabled={refreshing} title="Refresh from DuckDB" testId="chart-refresh">
            {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCw className="h-3.5 w-3.5" />}
          </ToolbarButton>
          <ToolbarButton onClick={() => setMaximized(true)} title="Maximize" testId="chart-maximize">
            <Maximize2 className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ChartDownloadMenu onDownload={handleDownload} size="sm" testId="chart-download" />
        </div>

        {/* Error banner (chart from last successful fetch stays visible below) */}
        {chart.error && (
          <div className="px-3 py-2 border-b border-destructive/30 bg-destructive/10 text-xs">
            <div className="font-medium text-destructive">Refresh failed</div>
            <div className="text-destructive/90 mt-1">{chart.error}</div>
            <pre className="mt-1.5 p-1.5 rounded bg-background/60 overflow-x-auto text-[10px] text-foreground/70">{chart.sql}</pre>
          </div>
        )}

        {/* Vega-Lite compile warnings — the chart still renders but the
            model's spec had issues. The same list is also sent to the
            model via the tool_result so it can self-correct. */}
        {chart.warnings && chart.warnings.length > 0 && (
          <div
            data-testid="chart-warnings"
            className="px-3 py-1.5 border-b border-amber-500/30 bg-amber-500/10 text-[11px] text-amber-900 dark:text-amber-200"
          >
            <span className="font-medium">Chart warnings:</span>
            <ul className="list-disc list-inside mt-0.5">
              {chart.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </div>
        )}

        {/* Chart container: explicit w-full lets Vega's width:"container" do
            its job; min-h gives the chart vertical room while letting it
            grow when the spec asks for a tall chart. overflow-x-auto
            handles the rare case of a chart wider than the container. */}
        {/* No horizontal padding on the chart container: Vega's
            width:"container" measures clientWidth (excludes padding) but
            then renders the SVG at that width inside the container,
            which lands in the padding zone and overflows by exactly the
            padding amount. Vertical padding is fine — height isn't
            container-sized when autosize is fit-x. */}
        <div
          ref={onContainerRef}
          data-testid="vega-chart-container"
          className="py-4 w-full min-h-[280px] overflow-x-auto"
        />

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
  children, onClick, disabled, title, testId, asChild,
}: { children: React.ReactNode; onClick?: () => void; disabled?: boolean; title: string; testId?: string; asChild?: boolean }) {
  // asChild=true: the parent (e.g. ChartDownloadMenu's PopoverTrigger) owns
  // the click/keyboard behavior; we just render the icon and styling.
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      data-testid={testId}
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

/**
 * Memoize on the chart fields a chart block actually cares about. The
 * parent (ChatMessageAssistant inside AskAIChat) re-renders on every
 * streaming chunk; without memoization every chart in the conversation
 * re-renders its toolbar, footer, RelativeTime tick, etc. With many
 * charts on screen this is the dominant cause of scroll jank.
 *
 * Identity of `onUpdate` is intentionally NOT compared — the parent
 * creates a new closure on each render. Treat it as stable in spirit;
 * the child only calls it from event handlers, never from render.
 */
export const VegaChartBlock = memo(
  VegaChartBlockImpl,
  (prev, next) =>
    prev.chart.chartId === next.chart.chartId &&
    prev.chart.fetchedAt === next.chart.fetchedAt &&
    prev.chart.error === next.chart.error &&
    prev.chart.title === next.chart.title &&
    prev.chart.warnings === next.chart.warnings &&
    prev.chart.rowCount === next.chart.rowCount &&
    prev.chart.pending === next.chart.pending &&
    // extraSources reference equality: AskAIChat builds a new array
    // whenever the chart's extras change (refresh updates the array),
    // so identity is the right signal for "do we need to re-render?".
    prev.chart.extraSources === next.chart.extraSources,
);
