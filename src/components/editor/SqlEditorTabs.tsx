import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import type { EditorDoc } from "@/lib/editor/editor-store";
import { cn } from "@/lib/utils";

interface Props {
  docs: EditorDoc[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onClose: (id: string) => void;
  onRename: (id: string, name: string) => void;
}

export function SqlEditorTabs({ docs, activeId, onSelect, onAdd, onClose, onRename }: Props) {
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
    <div className="flex items-stretch gap-0.5 px-1.5 pt-1.5 bg-card border-b border-border overflow-x-auto shrink-0" data-testid="editor-tabs">
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
              "group flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-t-md cursor-pointer whitespace-nowrap border border-b-0 transition-colors max-w-[200px]",
              active
                ? "bg-background border-border text-foreground font-medium"
                : "bg-transparent border-transparent text-muted-foreground hover:text-foreground hover:bg-foreground/5",
            )}
          >
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
        className="flex items-center px-2 py-1.5 text-muted-foreground hover:text-foreground hover:bg-foreground/5 rounded-t-md transition-colors shrink-0"
        title="New query tab"
        aria-label="New query tab"
        data-testid="editor-add-tab"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
