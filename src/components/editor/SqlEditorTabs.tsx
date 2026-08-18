import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import type { EditorDoc } from "@/lib/editor/editor-store";
import { cn } from "@/lib/utils";

interface Props {
  docs: EditorDoc[];
  activeId: string | null;
  /** Docs whose Ask AI conversation has a turn in flight. Each conversation is
   *  per tab, so without this a running agent vanishes when you switch tabs. */
  busyDocIds?: Set<string>;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onClose: (id: string) => void;
  onRename: (id: string, name: string) => void;
}

export function SqlEditorTabs({ docs, activeId, busyDocIds, onSelect, onAdd, onClose, onRename }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  const startRename = (doc: EditorDoc) => {
    setEditingId(doc.id);
    setDraft(doc.name);
  };
  const commitRename = () => {
    if (editingId) {
      const name = draft.trim();
      if (name) onRename(editingId, name);
    }
    setEditingId(null);
  };

  return (
    /*
      Three surfaces, so the strip reads as a trough and the selected tab as
      the sheet lying on top of it:

        strip      bg-muted    the trough
        inactive   bg-card/40  a translucent wash of the active surface
        active     bg-card     the SAME surface as the toolbar directly below,
                               so the selected tab reads as continuous with
                               its own editor

      Inactive is deliberately a translucent `card` over the strip rather than
      a third named token. `muted`, `background` and `card` do not keep the
      same light-to-dark order in both schemes — in light it runs
      muted < background < card, in dark it runs background < card < muted —
      so any fixed trio that looks recessed in one scheme inverts in the
      other. Compositing the active surface at 40% always lands between the
      strip and the active tab, whichever way round the scheme is.

      These are semantic tokens rather than named scales because
      `?theme=<url>` only rewrites semantic tokens; hardcoding soil-* here
      would leave custom themes with a mismatched tab strip.
    */
    <div className="flex items-stretch gap-1 px-1.5 pt-1.5 bg-muted border-b border-border overflow-x-auto shrink-0" data-testid="editor-tabs">
      {docs.map((doc) => {
        const active = doc.id === activeId;
        return (
          <div
            key={doc.id}
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(doc.id)}
            onDoubleClick={() => startRename(doc)}
            className={cn(
              "relative group flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-t-md cursor-pointer whitespace-nowrap border border-b-0 transition-colors max-w-[200px]",
              active
                ? "bg-card border-border text-foreground font-semibold shadow-sm"
                : "bg-card/40 border-border text-muted-foreground hover:bg-card/70 hover:text-foreground",
            )}
          >
            {/* The selected tab gets a bar in the app's active colour — the
                same `primary` the main tab bar uses for its current section —
                so "which query am I editing" is answerable from colour alone
                and not only from a one-step background difference. Absolutely
                positioned so it costs no layout height, which keeps every tab
                the same size whether selected or not. */}
            {active && (
              <span
                className="absolute inset-x-0 top-0 h-[2px] rounded-t-md bg-primary"
                aria-hidden="true"
              />
            )}
            {editingId === doc.id ? (
              <input
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commitRename}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  else if (e.key === "Escape") setEditingId(null);
                }}
                className="w-24 bg-transparent border-b border-accent outline-none text-xs"
              />
            ) : (
              <span className="truncate">{doc.name}</span>
            )}
            {busyDocIds?.has(doc.id) && (
              <span
                className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse shrink-0"
                data-testid={`editor-tab-ai-busy-${doc.id}`}
                title="Ask AI is working on this tab"
                aria-label="Ask AI is working"
              />
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClose(doc.id);
              }}
              className="opacity-0 group-hover:opacity-100 hover:text-destructive transition-opacity shrink-0"
              title="Close tab"
              aria-label={`Close ${doc.name}`}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
      <button
        onClick={onAdd}
        className="flex items-center px-2 py-1.5 ml-0.5 text-muted-foreground hover:text-foreground hover:bg-card rounded-t-md transition-colors shrink-0"
        title="New query tab"
        aria-label="New query tab"
        data-testid="editor-add-tab"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
