/**
 * "Script" — the actions that act on the SQL TEXT, as opposed to the results.
 *
 * Both items here are the same noun in two forms: one writes the script to a
 * file, the other puts it in a URL that reopens it. Naming the menu after that
 * shared object is what keeps it honest — "Share" would only have covered one
 * of them, and an unlabelled overflow would have said nothing at all.
 * CloudBeaver uses "Download SQL script" for the same idea, so "Script" is a
 * familiar noun here rather than an invented one.
 */
import { FileCode2, Download, Link2, Check } from "lucide-react";
import { Popover as BaseUIPopover } from "@base-ui/react/popover";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

interface Props {
  onDownloadSql: () => void;
  onShareLink: () => void;
  /** Renders the link row in its just-copied state. */
  shareCopied?: boolean;
}

export function ScriptMenu({ onDownloadSql, onShareLink, shareCopied }: Props) {
  return (
    <Popover>
      <PopoverTrigger
        className="flex items-center gap-1.5 h-7 px-2 text-xs rounded hover:bg-foreground/5 transition-colors"
        title="Download or share this tab's SQL"
        data-testid="editor-script-menu"
      >
        <FileCode2 className="h-3.5 w-3.5" />
        <span>Script</span>
      </PopoverTrigger>
      <PopoverContent align="start" className="p-1 min-w-[220px]">
        <BaseUIPopover.Close
          onClick={onDownloadSql}
          data-testid="editor-download-sql"
          className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-foreground/5 transition-colors text-left"
        >
          <Download className="h-3.5 w-3.5" />
          <span>Download .sql</span>
        </BaseUIPopover.Close>
        <BaseUIPopover.Close
          onClick={onShareLink}
          data-testid="editor-share-link"
          className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-foreground/5 transition-colors text-left"
        >
          {shareCopied
            ? <Check className="h-3.5 w-3.5 text-accent" />
            : <Link2 className="h-3.5 w-3.5" />}
          <span>{shareCopied ? "Link copied" : "Copy link to this query"}</span>
        </BaseUIPopover.Close>
      </PopoverContent>
    </Popover>
  );
}
