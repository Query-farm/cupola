/**
 * The Query Editor's keyboard shortcuts, written for the reader's platform
 * (`keyLabel`). Only bindings the editor really has: its own (run) and the
 * CodeMirror defaults it loads (`cm-sql-setup.ts`).
 */
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { isMac, keyLabel } from "@/lib/keys";

const SHORTCUTS: Array<{ action: string; keys: string[] }> = [
  { action: "Run the statement at the cursor, or the selection", keys: ["Mod-Enter"] },
  { action: "Show completions", keys: ["Ctrl-Space"] },
  { action: "Next / previous argument of an inserted call", keys: ["Tab", "Shift-Tab"] },
  { action: "Close completions or signature help", keys: ["Escape"] },
  { action: "Comment or uncomment lines", keys: ["Mod-/"] },
  { action: "Undo", keys: ["Mod-z"] },
  { action: "Redo", keys: [isMac ? "Shift-Mod-z" : "Mod-y"] },
  { action: "Select all", keys: ["Mod-a"] },
];

export function KeyboardShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="editor-shortcuts-dialog">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <table className="w-full text-sm">
          <tbody>
            {SHORTCUTS.map(({ action, keys }) => (
              <tr key={action} className="border-t border-border first:border-t-0">
                <td className="py-1.5 pr-3 text-foreground/90">{action}</td>
                <td className="py-1.5 text-right whitespace-nowrap">
                  {keys.map((k, i) => (
                    <span key={k}>
                      {i > 0 && <span className="mx-1 text-muted-foreground">/</span>}
                      <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs">{keyLabel(k)}</kbd>
                    </span>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DialogContent>
    </Dialog>
  );
}
