/**
 * The editor Ask AI panel's rendering of a `run_sql` tool call: the standard
 * SqlToolCallBlock plus an "apply to editor" action bar. Also exports
 * SqlApplyBar for use under assistant text blocks that propose (but didn't
 * run) a query.
 */
import { Replace, FileText, TextCursorInput, SquarePlus, ChevronDown } from "lucide-react";
import { Popover as BaseUIPopover } from "@base-ui/react/popover";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SqlToolCallBlock } from "@/components/chat/SqlToolCallBlock";
import type { ToolCallEntry } from "@/components/chat/ChatMessageAssistant";

export interface SqlApplyActions {
  replaceStatement: (sql: string) => void;
  replaceDocument: (sql: string) => void;
  insertAtCursor: (sql: string) => void;
  openInNewTab: (sql: string) => void;
}

export function SqlApplyBar({ sql, apply }: { sql: string; apply: SqlApplyActions }) {
  return (
    <div className="flex items-center gap-1.5 px-0.5">
      <Popover>
        <PopoverTrigger
          className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded bg-primary text-primary-foreground hover:bg-accent shadow-sm transition-colors"
          title="Apply this SQL to the editor"
          data-testid="ai-apply-menu"
        >
          <Replace className="h-3.5 w-3.5" />
          Apply
          <ChevronDown className="h-3 w-3" />
        </PopoverTrigger>
        <PopoverContent className="p-1 min-w-[200px]">
          <BaseUIPopover.Close
            onClick={() => apply.replaceStatement(sql)}
            data-testid="ai-apply-replace-statement"
            className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-foreground/5 transition-colors text-left"
          >
            <Replace className="h-3.5 w-3.5" /> Replace current statement
          </BaseUIPopover.Close>
          <BaseUIPopover.Close
            onClick={() => apply.replaceDocument(sql)}
            data-testid="ai-apply-replace-document"
            className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-foreground/5 transition-colors text-left"
          >
            <FileText className="h-3.5 w-3.5" /> Replace whole document
          </BaseUIPopover.Close>
          <BaseUIPopover.Close
            onClick={() => apply.insertAtCursor(sql)}
            data-testid="ai-apply-insert"
            className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-foreground/5 transition-colors text-left"
          >
            <TextCursorInput className="h-3.5 w-3.5" /> Insert at cursor
          </BaseUIPopover.Close>
        </PopoverContent>
      </Popover>
      <button
        onClick={() => apply.openInNewTab(sql)}
        className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-border hover:bg-foreground/5 transition-colors"
        title="Open this SQL in a new editor tab and run it"
        data-testid="ai-apply-open-tab"
      >
        <SquarePlus className="h-3.5 w-3.5" />
        New tab
      </button>
    </div>
  );
}

export function EditorSqlToolCallBlock({
  toolCall,
  onCancel,
  apply,
}: {
  toolCall: ToolCallEntry;
  onCancel?: () => void;
  apply: SqlApplyActions;
}) {
  const sql: string | undefined = toolCall.input?.sql;
  const showApply = !!sql && !toolCall.isExecuting && !toolCall.error;
  return (
    <div className="space-y-1.5">
      <SqlToolCallBlock toolCall={toolCall} onCancel={onCancel} />
      {showApply && <SqlApplyBar sql={sql!} apply={apply} />}
    </div>
  );
}
