import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { ChatMarkdown } from "@/components/chat/ChatMarkdown";

/**
 * An object's `vgi.doc_md`: the long-form Markdown documentation. It sits
 * beside the one-line summary (the comment / description), never in place of
 * it: the VGI tag standard requires the two to complement each other (VGI102).
 */
interface Props {
  markdown: string;
  defaultOpen?: boolean;
}

export function DocumentationSection({ markdown, defaultOpen = true }: Props) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="mb-4">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors cursor-pointer mb-2"
      >
        <ChevronRight className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`} />
        Documentation
      </button>
      {open && (
        <div className="border rounded-md bg-card shadow-sm px-4 py-3">
          <ChatMarkdown content={markdown} />
        </div>
      )}
    </div>
  );
}
