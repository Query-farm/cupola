import { useEffect, useState } from "react";
import { X } from "lucide-react";

interface Props {
  label?: string;
  /** When provided, an inline cancel chip is shown next to the indicator
   *  so the user can interrupt mid-Thinking instead of hunting for the
   *  Stop button at the bottom of the panel. */
  onCancel?: () => void;
}

export function ThinkingIndicator({ label = "Thinking", onCancel }: Props) {
  // Per-second elapsed tick so the user has honest "still working" feedback
  // when the agent's response is slow (model latency, long tool round-trip,
  // network retry). Resets each time the indicator mounts.
  const [elapsedSec, setElapsedSec] = useState(0);
  useEffect(() => {
    const start = Date.now();
    setElapsedSec(0);
    const id = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
      <div className="flex gap-1">
        <span className="w-1.5 h-1.5 bg-primary/40 rounded-full animate-bounce [animation-delay:0ms]" />
        <span className="w-1.5 h-1.5 bg-primary/40 rounded-full animate-bounce [animation-delay:150ms]" />
        <span className="w-1.5 h-1.5 bg-primary/40 rounded-full animate-bounce [animation-delay:300ms]" />
      </div>
      <span>
        {label}
        {elapsedSec > 0 && <span className="text-muted-foreground/60 ml-1.5 font-mono text-xs">{formatElapsed(elapsedSec)}</span>}
      </span>
      {onCancel && (
        <button
          onClick={(e) => { e.stopPropagation(); onCancel(); }}
          className="ml-1 flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-destructive bg-destructive/10 hover:bg-destructive/20 transition-colors"
          title="Cancel (Escape)"
        >
          <X className="h-3 w-3" />
          Cancel
        </button>
      )}
    </div>
  );
}

function formatElapsed(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m${r.toString().padStart(2, "0")}s`;
}
