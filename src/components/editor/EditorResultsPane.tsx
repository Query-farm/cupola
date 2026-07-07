import { Loader2, AlertCircle, TableProperties, CheckCircle2 } from "lucide-react";
import { DataPreview } from "@/components/content/DataPreview";
import { ExplainView } from "@/components/editor/ExplainView";

export interface ResultState {
  table: any | null;
  error: string | null;
  running: boolean;
  rowCount: number;
  elapsedMs: number;
  /** True for a statement that returned no result set (DDL/DML success). */
  ok: boolean;
  /** True once at least one statement has been run for this tab. */
  ran: boolean;
}

export const emptyResult: ResultState = {
  table: null,
  error: null,
  running: false,
  rowCount: 0,
  elapsedMs: 0,
  ok: false,
  ran: false,
};

interface Props {
  state: ResultState;
}

export function EditorResultsPane({ state }: Props) {
  return (
    <div className="flex flex-col h-full min-h-0">
      <StatusBar state={state} />
      <div className="flex-1 min-h-0">
        {state.error ? (
          <div className="flex flex-col items-center justify-center h-full text-center p-8">
            <AlertCircle className="h-8 w-8 text-destructive/60 mb-3" />
            <p className="text-sm font-medium text-destructive mb-1">Query failed</p>
            <pre className="text-xs text-muted-foreground max-w-2xl whitespace-pre-wrap font-mono text-left">
              {state.error}
            </pre>
          </div>
        ) : state.running && !state.table ? (
          <div className="flex items-center justify-center h-full text-muted-foreground gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">Running…</span>
          </div>
        ) : state.table && isExplainTable(state.table) ? (
          <ExplainView table={state.table} />
        ) : state.table ? (
          // Re-key by the result identity so DataPreview resets its paging
          // window when a new result arrives.
          <DataPreview key={resultKey(state)} result={state.table} />
        ) : state.ran && state.ok ? (
          <div className="flex flex-col items-center justify-center h-full text-center p-8">
            <CheckCircle2 className="h-8 w-8 text-accent/60 mb-3" />
            <p className="text-sm text-muted-foreground">Statement executed successfully.</p>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center p-8">
            <TableProperties className="h-8 w-8 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">
              Run a query to see results here.
            </p>
            <p className="text-xs text-muted-foreground/70 mt-1">
              ⌘/Ctrl+Enter runs the statement at the cursor.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusBar({ state }: Props) {
  if (!state.ran && !state.running) return null;
  return (
    <div className="flex items-center gap-3 px-3 py-1 border-b border-border bg-muted/30 text-xs text-muted-foreground shrink-0">
      {state.running ? (
        <span className="flex items-center gap-1.5">
          <Loader2 className="h-3 w-3 animate-spin" /> Running…
        </span>
      ) : state.error ? (
        <span className="text-destructive">Error</span>
      ) : (
        <>
          <span>
            {state.table ? `${state.rowCount.toLocaleString()} row${state.rowCount === 1 ? "" : "s"}` : "OK"}
          </span>
          <span>·</span>
          <span>{state.elapsedMs} ms</span>
        </>
      )}
    </div>
  );
}

/** True when an Arrow result is a DuckDB EXPLAIN output (explain_key/explain_value). */
function isExplainTable(table: any): boolean {
  const names: string[] = table?.schema?.fields?.map((f: any) => f.name) ?? [];
  return names.includes("explain_key") && names.includes("explain_value");
}

let keyCounter = 0;
const keyMap = new WeakMap<object, number>();
/** Stable identity for a result table so DataPreview remounts per result. */
function resultKey(state: ResultState): number {
  const t = state.table;
  if (!t) return 0;
  let k = keyMap.get(t);
  if (k === undefined) {
    k = ++keyCounter;
    keyMap.set(t, k);
  }
  return k;
}
