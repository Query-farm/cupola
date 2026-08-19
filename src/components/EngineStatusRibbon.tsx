import { AlertTriangle, Loader2, RotateCw } from "lucide-react";
import { useEngineLifecycle } from "@/lib/use-engine-lifecycle";

/** Compact, app-wide data-engine state. Catalog browsing remains available,
 * while every query-capable tab gets the same readiness and failure signal. */
export function EngineStatusRibbon() {
  const lifecycle = useEngineLifecycle();
  if (lifecycle.status === "ready") return null;

  const failed = lifecycle.status === "error";
  const phase = lifecycle.phase ?? (lifecycle.status === "idle" ? "Preparing local data engine" : "Starting local data engine");
  const progress = lifecycle.progress;
  const determinate = !failed && typeof progress === "number" && progress > 0;

  return (
    <div
      data-testid="engine-status-ribbon"
      data-engine-status={lifecycle.status}
      role={failed ? "alert" : "status"}
      aria-live="polite"
      className={failed
        ? "shrink-0 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        : "shrink-0 border-b border-sky-300/60 bg-sky-50/80 px-3 py-2 text-xs text-sky-950 dark:border-sky-800 dark:bg-sky-950/35 dark:text-sky-100"}
    >
      <div className="flex min-w-0 items-center gap-2">
        {failed ? <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> : <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />}
        <span className="shrink-0 font-semibold">{failed ? "Data engine failed to start" : "Starting local data engine"}</span>
        <span className="min-w-0 truncate opacity-80">{failed ? lifecycle.error : phase}</span>
        {determinate && <span className="ml-auto shrink-0 font-mono tabular-nums">{Math.round(progress)}%</span>}
        {failed && <button
          type="button"
          className="ml-auto inline-flex shrink-0 items-center gap-1 rounded border border-current/25 px-2 py-1 font-medium hover:bg-destructive/10"
          onClick={() => window.location.reload()}
        ><RotateCw className="h-3 w-3" /> Retry</button>}
      </div>
      {!failed && <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-sky-950/10 dark:bg-sky-100/15" aria-hidden="true">
        {determinate
          ? <div className="h-full rounded-full bg-sky-600 transition-[width] duration-200 dark:bg-sky-400" style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
          : <div className="h-full w-1/3 animate-pulse rounded-full bg-sky-600/60 dark:bg-sky-400/70" />}
      </div>}
    </div>
  );
}
