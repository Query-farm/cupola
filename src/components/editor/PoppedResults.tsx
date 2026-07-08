import { useState } from "react";
import { RefreshCw, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataPreview } from "@/components/content/DataPreview";
import { SqlCodeBlock } from "@/components/content/SqlCodeBlock";
import type { ResultSnapshot } from "@/lib/editor/result-popout";

interface Props {
  snapshot: ResultSnapshot;
  /** The editor's current result differs from this snapshot (offer Sync). */
  hasNewer: boolean;
  onSync: () => void;
}

// Stable identity per Arrow table so DataPreview remounts (resets paging) when a
// Sync swaps in a new result.
let keyCounter = 0;
const keyMap = new WeakMap<object, number>();
function tableKey(t: object | null): number {
  if (!t) return 0;
  let k = keyMap.get(t);
  if (k === undefined) { k = ++keyCounter; keyMap.set(t, k); }
  return k;
}

/**
 * Content rendered into the detached results window. A loud "Snapshot" header
 * (badge + capture time + the originating SQL) makes the detached grid
 * self-describing, and a Sync button pulls the editor's current result on demand.
 */
export function PoppedResults({ snapshot, hasNewer, onSync }: Props) {
  const [showSql, setShowSql] = useState(false);
  const time = snapshot.capturedAt.toLocaleTimeString([], {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });

  return (
    <div className="flex flex-col h-screen bg-background text-foreground">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/20 shrink-0">
        <Badge variant="secondary" className="text-xs">Snapshot</Badge>
        <span className="text-xs text-muted-foreground whitespace-nowrap">Captured {time}</span>
        <button
          type="button"
          onClick={() => setShowSql((v) => !v)}
          className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1 cursor-pointer"
        >
          <ChevronRight className={`h-3 w-3 transition-transform ${showSql ? "rotate-90" : ""}`} />
          SQL
        </button>
        <div className="ml-auto flex items-center gap-2">
          {hasNewer && (
            <span className="text-xs text-amber-600 whitespace-nowrap">Source has a newer result</span>
          )}
          <Button
            variant={hasNewer ? "default" : "outline"}
            size="sm"
            onClick={onSync}
            disabled={!hasNewer}
            title={hasNewer ? "Update to the editor's current result" : "Already showing the latest result"}
            className="gap-1.5"
            data-testid="popout-sync"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Sync
          </Button>
        </div>
      </div>

      {showSql && (
        <div className="px-3 py-2 border-b border-border bg-card shrink-0 max-h-[30vh] overflow-auto">
          <SqlCodeBlock query={snapshot.sql} />
        </div>
      )}

      <div className="flex-1 min-h-0">
        <DataPreview key={tableKey(snapshot.table)} result={snapshot.table} />
      </div>
    </div>
  );
}
