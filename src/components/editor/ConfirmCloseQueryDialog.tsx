/**
 * Closing an editor tab deletes its query: tabs are the only place editor SQL
 * lives (history keeps what ran, not what was typed). So a tab with SQL in it
 * asks first; an empty one closes at once. Cancel takes the initial focus, so
 * a reflexive Enter keeps the query.
 */
import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export interface PendingClose {
  id: string;
  name: string;
  sql: string;
}

const PREVIEW_LINES = 6;

export function ConfirmCloseQueryDialog({ pending, onCancel, onConfirm }: {
  pending: PendingClose | null;
  onCancel: () => void;
  onConfirm: (id: string) => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const lines = pending?.sql.trim().split("\n") ?? [];
  const preview = lines.slice(0, PREVIEW_LINES).join("\n");
  return (
    <Dialog open={!!pending} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent className="sm:max-w-md" initialFocus={cancelRef} data-testid="editor-close-confirm">
        <DialogHeader>
          <DialogTitle>Delete “{pending?.name}”?</DialogTitle>
          <DialogDescription>
            Closing this tab deletes its query. This can't be undone, though queries you ran stay in History.
          </DialogDescription>
        </DialogHeader>
        {preview && (
          <pre className="max-h-40 overflow-auto rounded-md bg-muted/60 px-3 py-2 font-mono text-xs whitespace-pre-wrap break-words">
            {preview}
            {lines.length > PREVIEW_LINES && <span className="text-muted-foreground">{`\n… ${lines.length - PREVIEW_LINES} more line${lines.length - PREVIEW_LINES === 1 ? "" : "s"}`}</span>}
          </pre>
        )}
        <DialogFooter>
          <Button ref={cancelRef} variant="outline" onClick={onCancel} data-testid="editor-close-cancel">Keep query</Button>
          <Button variant="destructive" onClick={() => pending && onConfirm(pending.id)} data-testid="editor-close-delete">Delete query</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
