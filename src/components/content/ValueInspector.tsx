import { useEffect, useRef, useState } from "react";
import { Braces, Check, Copy, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isNullValue } from "@/lib/format";
import type { ColumnInfo } from "@/lib/service";
import { cellText, prettyJson } from "./cell-text";

interface Props {
  column: string;
  info?: ColumnInfo;
  field?: any;
  value: any;
  /** 1-based row number in the whole result. */
  rowNumber: number;
  numberGrouping?: boolean;
  onClose: () => void;
}

/**
 * Docked panel showing one cell's full value, wrapped, with copy. The grid
 * truncates long values to its column width; this is where they're read.
 * JSON objects and arrays can be shown indented.
 *
 * Rendered inline rather than in a dialog: the pop-out results window renders
 * DataPreview from the opener's realm, and a portal would land in the opener.
 */
export function ValueInspector({ column, info, field, value, rowNumber, numberGrouping, onClose }: Props) {
  const isNull = isNullValue(value);
  const text = isNull ? "" : cellText(value, column, field, info, numberGrouping);
  const pretty = isNull ? null : prettyJson(text);
  const [showPretty, setShowPretty] = useState(true);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const shown = pretty && showPretty ? pretty : text;

  useEffect(() => { setCopied(false); }, [text]);

  const copy = () => {
    const nav = rootRef.current?.ownerDocument.defaultView?.navigator ?? navigator;
    void nav.clipboard?.writeText(shown).then(() => setCopied(true), () => {});
  };

  return (
    <div
      ref={rootRef}
      role="region"
      aria-label="Cell value"
      className="flex flex-col h-full min-w-0 border-l border-border bg-card"
    >
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border shrink-0">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-mono font-semibold truncate" title={column}>{column}</div>
          <div className="text-[11px] text-muted-foreground truncate">
            Row {rowNumber.toLocaleString()}
            {info?.duckdbType ? ` · ${info.duckdbType}` : ""}
            {!isNull ? ` · ${text.length.toLocaleString()} chars` : ""}
          </div>
        </div>
        {pretty && (
          <Button
            variant={showPretty ? "secondary" : "ghost"}
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => setShowPretty((v) => !v)}
            title={showPretty ? "Show as stored" : "Format JSON"}
            aria-pressed={showPretty}
          >
            <Braces className="h-3.5 w-3.5" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={copy}
          disabled={isNull}
          title="Copy value"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onClose} title="Close (Esc)">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto px-3 py-2">
        {isNull ? (
          <span className="text-xs text-muted-foreground/50 italic">NULL</span>
        ) : (
          <pre
            data-testid="cell-value"
            className="text-xs font-mono whitespace-pre-wrap [overflow-wrap:anywhere] select-text"
          >
            {shown}
          </pre>
        )}
      </div>
    </div>
  );
}
