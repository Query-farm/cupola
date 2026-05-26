import { useEffect, useState } from "react";
import { bridge, onBootChange } from "@/lib/shell-bridge";

/**
 * Animated Haybarn boot indicator shown inside the SQL Shell panel while the
 * shell is initializing (downloading WASM, spinning up pthreads, loading
 * extensions, attaching the catalog, syncing timezone).
 *
 * Visual: a tractor (🚜) bobbing and swaying over a row of scrolling soil
 * dashes, current phase label, elapsed timer, and a progress bar —
 * determinate during the WASM download (real % from db.instantiate),
 * indeterminate (sweeping shimmer) for open-ended extension-load + connect
 * phases. Earth/soil/harvest palette to match the rest of the chrome.
 */
export function ShellBootScreen() {
  const [, force] = useState(0);
  useEffect(() => {
    const unsub = onBootChange(() => force((n) => n + 1));
    return () => unsub();
  }, []);
  const phase = bridge.bootPhase || "Initializing Haybarn";
  const progress = bridge.bootProgress;
  const isDeterminate = typeof progress === "number" && progress > 0;

  const [elapsedSec, setElapsedSec] = useState(0);
  useEffect(() => {
    const start = bridge.workerCreateStart || performance.now();
    const id = setInterval(() => {
      setElapsedSec(Math.max(0, Math.round((performance.now() - start) / 1000)));
    }, 1000);
    setElapsedSec(Math.max(0, Math.round((performance.now() - start) / 1000)));
    return () => clearInterval(id);
  }, []);

  // Safari (and any slow box) can take 15–20s for COI pthread spin-up. After
  // 8s in the slow phases, surface a reassuring note so users don't think
  // it's hung.
  const showSafariTip =
    elapsedSec >= 8 &&
    (phase.startsWith("Downloading") || phase.startsWith("Connecting"));

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6 py-12 text-terminal-fg gap-5">
      {/* Tractor + scrolling soil */}
      <div className="flex flex-col items-center gap-1">
        <div className="text-[44px] leading-none animate-shell-tractor select-none" aria-hidden="true">
          🚜
        </div>
        <div className="w-32 overflow-hidden text-harvest-500/40 font-mono text-sm leading-none">
          <div className="whitespace-nowrap animate-shell-soil">
            — — — — — — — — — — — — — — — —
          </div>
        </div>
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
        {showSafariTip && (
          <div className="text-[11px] text-terminal-muted/80 mt-1 max-w-xs text-center">
            Safari needs ~15–20s to spin up WASM threads — hang tight.
          </div>
        )}
      </div>

      {/* Progress bar */}
      <div className="w-64 h-1.5 rounded-full bg-terminal-muted/30 overflow-hidden relative">
        {isDeterminate ? (
          <div
            className="absolute inset-y-0 left-0 bg-harvest-500 rounded-full transition-[width] duration-200 ease-out"
            style={{ width: `${Math.max(0, Math.min(100, progress!))}%` }}
          />
        ) : (
          <div className="absolute top-0 bottom-0 w-1/3 bg-harvest-500/70 rounded-full animate-shell-sweep" />
        )}
      </div>

      <style>{`
        @keyframes shell-tractor {
          0%   { transform: translateY(0) rotate(-1deg); }
          50%  { transform: translateY(-2px) rotate(1deg); }
          100% { transform: translateY(0) rotate(-1deg); }
        }
        .animate-shell-tractor { animation: shell-tractor 1.2s ease-in-out infinite; }

        @keyframes shell-soil {
          0%   { transform: translateX(0); }
          100% { transform: translateX(-1.5em); }
        }
        .animate-shell-soil { animation: shell-soil 0.9s linear infinite; }

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
