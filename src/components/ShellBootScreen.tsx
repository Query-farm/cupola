import { useEffect, useState } from "react";
import { bridge, onBootChange } from "@/lib/shell-bridge";

/**
 * Animated DuckDB-WASM boot indicator shown inside the SQL Shell panel
 * while the shell is initializing (downloading WASM, loading extensions,
 * attaching the catalog, syncing timezone).
 *
 * Visual: pulsing DuckDB icon, current phase label, elapsed timer, and a
 * progress bar — determinate during the WASM download (we get a real
 * percentage from `db.instantiate`), indeterminate (sweeping shimmer) for
 * the open-ended extension-load + connect phases. Earth/soil/harvest
 * palette to match the rest of the chrome.
 */
export function ShellBootScreen() {
  // Subscribe to phase + progress changes from duckdb-worker-boot and
  // DuckDBShell. We re-read from bridge on every fire — the value source
  // is the bridge singleton.
  const [, force] = useState(0);
  useEffect(() => {
    const unsub = onBootChange(() => force((n) => n + 1));
    return () => unsub();
  }, []);
  const phase = bridge.bootPhase || "Initializing DuckDB-WASM";
  const progress = bridge.bootProgress;
  const isDeterminate = typeof progress === "number" && progress > 0;

  // Elapsed-time counter — bumps every second so the user can tell whether
  // boot is making progress or hung.
  const [elapsedSec, setElapsedSec] = useState(0);
  useEffect(() => {
    const start = bridge.workerCreateStart || performance.now();
    const id = setInterval(() => {
      setElapsedSec(Math.max(0, Math.round((performance.now() - start) / 1000)));
    }, 1000);
    setElapsedSec(Math.max(0, Math.round((performance.now() - start) / 1000)));
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6 py-12 text-terminal-fg gap-5">
      {/* Animated duck icon ring */}
      <div className="relative w-20 h-20 mb-2">
        <img
          src={`${import.meta.env.BASE_URL}duckdb-icon-light.svg`}
          alt=""
          aria-hidden="true"
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-14 h-14 animate-shell-pulse"
        />
        <div className="absolute inset-0 rounded-full border-4 border-transparent border-t-harvest-500 border-r-harvest-500/30 animate-spin" />
      </div>

      {/* Phase label */}
      <div className="text-center">
        <div className="text-sm font-medium text-terminal-fg">
          {phase}
          <span className="inline-block ml-0.5 text-harvest-400 animate-shell-ellipsis" aria-hidden="true">…</span>
        </div>
        <div className="text-[11px] font-mono text-terminal-muted mt-1">
          {elapsedSec}s elapsed
        </div>
      </div>

      {/* Progress bar */}
      <div className="w-64 h-1.5 rounded-full bg-terminal-muted/30 overflow-hidden relative">
        {isDeterminate ? (
          <div
            className="absolute inset-y-0 left-0 bg-harvest-500 rounded-full transition-[width] duration-200 ease-out"
            style={{ width: `${Math.max(0, Math.min(100, progress!))}%` }}
          />
        ) : (
          // Indeterminate: a thin bar sweeps left→right indefinitely.
          <div className="absolute top-0 bottom-0 w-1/3 bg-harvest-500/70 rounded-full animate-shell-sweep" />
        )}
      </div>

      {/* Scoped keyframes — kept inline so this component is self-contained. */}
      <style>{`
        @keyframes shell-pulse {
          0%, 100% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
          50%      { transform: translate(-50%, -50%) scale(0.95); opacity: 0.85; }
        }
        .animate-shell-pulse { animation: shell-pulse 2.4s ease-in-out infinite; }

        @keyframes shell-ellipsis {
          0%, 20%  { opacity: 0; }
          40%      { opacity: 0.5; }
          60%, 100% { opacity: 1; }
        }
        .animate-shell-ellipsis { animation: shell-ellipsis 1.2s ease-in-out infinite; }

        @keyframes shell-sweep {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(300%); }
        }
        .animate-shell-sweep { animation: shell-sweep 1.6s ease-in-out infinite; }
      `}</style>
    </div>
  );
}
