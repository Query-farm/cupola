/**
 * Full-screen maximize view for a Vega chart, with two tabs:
 *   - Visualization: the chart at large size.
 *   - Data: the SQL (formatted via sql-formatter), row count, and
 *     warnings — the place to inspect what's driving the chart.
 *
 * Each embed is independent — there's no easy "share one view across two
 * mount points" in Vega — but both views read from the same chart-rows-store
 * entry. The dialog's refresh button updates the shared cache and re-embeds
 * the dialog's view; the inline view picks up the new fetchedAt via the
 * parent's onUpdate path.
 *
 * The chart only embeds on the Visualization tab. Switching to Data does
 * NOT tear down the chart view; we just hide its tab panel. Switching
 * back is instant.
 */
import { useEffect, useRef, useState } from "react";
// useRef already imported above; hadInitialTab uses it.
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { RotateCw, Loader2, Copy, Check } from "lucide-react";
import type { VegaChartContent } from "./ChatMessageAssistant";
import { getChartRows, getChartExtras } from "@/lib/chart-rows-store";
import { embedChart, downloadPNG, downloadSVG, type VegaView } from "./chart-embed";
import { ChartDownloadMenu } from "./ChartDownloadMenu";
import { SqlCodeBlock } from "@/components/content/SqlCodeBlock";

interface Props {
  chart: VegaChartContent;
  onClose: () => void;
  onRefresh: () => void;
  refreshing: boolean;
}

export function MaximizedChartDialog({ chart, onClose, onRefresh, refreshing }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<VegaView | null>(null);
  const [copied, setCopied] = useState(false);
  // Controlled tab state so we can re-embed the chart when the user
  // switches back from Data → Visualization. base-ui's Tabs keeps both
  // panels mounted but the hidden panel can briefly have clientHeight=0
  // during the transition; the initial embed sized the Vega view to
  // that wrong height, leaving the chart squashed when the user came
  // back. Tracking the active tab lets us re-embed on transition.
  const [activeTab, setActiveTab] = useState<string>("viz");

  // Ref-callback: initial embed on first mount (fires synchronously when
  // React attaches the DOM node — no useEffect timing race vs portaled
  // content). Finalizes the Vega view on unmount. The activeTab effect
  // below handles re-embed on Data→Viz switches and on window resize.
  const onContainerRef = (node: HTMLDivElement | null) => {
    containerRef.current = node;
    if (!node) {
      const v = viewRef.current;
      viewRef.current = null;
      if (v) v.finalize();
      return;
    }
    if (viewRef.current) return; // already embedded
    void embedIntoContainer(node);
  };

  const embedIntoContainer = async (el: HTMLElement) => {
    // Defer until layout — dialog open transitions can produce a
    // 0-width OR 0-height container for the first frame, and tab
    // switches can briefly collapse the hidden panel's height.
    // Both dimensions need to be real or forceHeight degrades to its
    // floor (200) and the chart looks tiny on the next tab switch.
    let polls = 0;
    while ((el.clientWidth < 50 || el.clientHeight < 50) && polls < 60) {
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      if (!containerRef.current || containerRef.current !== el) return;
      polls++;
    }
    if (!containerRef.current || containerRef.current !== el) return;
    // Tear down any prior view before re-embedding — this function is
    // called on resize and tab-switch, not just initial mount.
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
      const forceHeight = Math.max(200, Math.floor(el.clientHeight) - 60);
      const view = await embedChart(el, chart.spec, rows, extraDatasets, { forceHeight });
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
  // Skip if the viz tab isn't active — the container has clientWidth=0
  // when hidden, embedIntoContainer would poll forever and we'd be
  // tearing down a working view for nothing.
  useEffect(() => {
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const onResize = () => {
      const el = containerRef.current;
      if (!el || activeTab !== "viz") return;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (containerRef.current && activeTab === "viz") {
          void embedIntoContainer(containerRef.current);
        }
      }, 100);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (resizeTimer) clearTimeout(resizeTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // When the underlying data refreshes (parent updates chart.fetchedAt),
  // re-embed with the new rows. Same skip rule as the resize handler.
  useEffect(() => {
    if (!containerRef.current || activeTab !== "viz") return;
    void embedIntoContainer(containerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart.fetchedAt]);

  // When the user switches Data → Visualization, re-embed. Vega doesn't
  // reflow when its container is shown/hidden; if the initial embed
  // happened at a different height than the now-active container, the
  // chart looks squashed. Easier and safer to re-embed than to coax
  // Vega into a resize.
  //
  // Skip the very first run (it lands on mount with activeTab="viz" and
  // would race the ref-callback's initial embed, double-embedding).
  const hadInitialTab = useRef(false);
  useEffect(() => {
    if (!hadInitialTab.current) {
      hadInitialTab.current = true;
      return;
    }
    if (activeTab !== "viz") return;
    const el = containerRef.current;
    if (!el) return;
    // Defer one frame so the tab panel has fully laid out before we
    // measure clientHeight.
    const raf = requestAnimationFrame(() => {
      if (containerRef.current === el && activeTab === "viz") {
        void embedIntoContainer(el);
      }
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  const handleDownload = async (format: "png" | "svg") => {
    const v = viewRef.current;
    if (!v) return;
    if (format === "png") await downloadPNG(v, chart.title || "chart");
    else await downloadSVG(v, chart.title || "chart");
  };

  const copySql = async () => {
    try {
      await navigator.clipboard.writeText(chart.sql);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
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

        {/* Two tabs: the chart, and the data inspector (SQL + warnings).
            defaultValue="viz" because users click the maximize button to
            see the chart bigger, not to read SQL. The Data tab is one
            click away when they want it. */}
        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(String(v))}
          className="flex-1 min-h-0 flex flex-col gap-2"
        >
          <TabsList variant="line" className="shrink-0 self-start">
            <TabsTrigger value="viz" data-testid="chart-maximize-tab-viz">Visualization</TabsTrigger>
            <TabsTrigger value="data" data-testid="chart-maximize-tab-data">
              Data
              {chart.warnings && chart.warnings.length > 0 && (
                <span className="ml-1.5 text-[10px] px-1 rounded bg-amber-500/30 text-amber-900 dark:text-amber-200">
                  {chart.warnings.length} warning{chart.warnings.length === 1 ? "" : "s"}
                </span>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="viz" className="flex-1 min-h-0 flex flex-col gap-1 m-0">
            <div
              ref={onContainerRef}
              data-testid="vega-chart-maximize-container"
              className="flex-1 min-h-0 w-full overflow-auto"
            />
            <div className="text-[11px] text-muted-foreground/70 shrink-0">
              {chart.rowCount.toLocaleString()} rows
            </div>
          </TabsContent>

          <TabsContent
            value="data"
            data-testid="vega-chart-maximize-data-panel"
            className="flex-1 min-h-0 flex flex-col gap-3 m-0 overflow-auto"
          >
            <div data-testid="chart-maximize-primary-section">
              <div className="flex items-center justify-between mb-1.5">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {chart.extraSources && chart.extraSources.length > 0 ? "Primary SQL" : "SQL"}
                </div>
                <button
                  onClick={copySql}
                  className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors px-1.5 py-0.5 rounded"
                  title="Copy SQL"
                  data-testid="chart-maximize-copy-sql"
                >
                  {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              {/* SqlCodeBlock formats with sql-formatter (multi-line,
                  keyword case, indentation) and syntax-highlights. */}
              <div className="bg-muted/40 rounded-md p-3">
                <SqlCodeBlock query={chart.sql} />
              </div>
              <div className="mt-1.5 text-[11px] text-muted-foreground font-mono">
                {chart.rowCount.toLocaleString()} rows · columns: {chart.columns.join(", ")}
              </div>
            </div>

            {/* Extras section: one SqlCodeBlock per additional dataset.
                Each can be inspected and copied individually. */}
            {chart.extraSources && chart.extraSources.length > 0 && (
              <div data-testid="chart-maximize-extras-section" className="flex flex-col gap-3">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Extra datasets ({chart.extraSources.length})
                </div>
                {chart.extraSources.map((extra) => (
                  <ExtraSourceCard key={extra.name} extra={extra} />
                ))}
              </div>
            )}

            {chart.warnings && chart.warnings.length > 0 && (
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">Vega-Lite warnings</div>
                <ul className="list-disc list-inside text-xs text-amber-900 dark:text-amber-200 bg-amber-500/10 rounded-md p-3 space-y-1">
                  {chart.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

/** One card per extra dataset in the Data tab: name + multi-line SQL via
 *  SqlCodeBlock + copy button + row/column count footer. */
function ExtraSourceCard({
  extra,
}: {
  extra: { name: string; sql: string; rowCount: number; columns: string[] };
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(extra.sql);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  return (
    <div data-testid={`chart-maximize-extra-${extra.name}`}>
      <div className="flex items-center justify-between mb-1.5">
        <div className="text-[11px] font-medium text-foreground/80">
          <span className="text-muted-foreground">name:</span>{" "}
          <code className="font-mono">{extra.name}</code>
        </div>
        <button
          onClick={copy}
          className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors px-1.5 py-0.5 rounded"
          title="Copy SQL"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="bg-muted/40 rounded-md p-3">
        <SqlCodeBlock query={extra.sql} />
      </div>
      <div className="mt-1.5 text-[11px] text-muted-foreground font-mono">
        {extra.rowCount.toLocaleString()} rows · columns: {extra.columns.join(", ")}
      </div>
    </div>
  );
}
