import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { ChatMarkdown } from "@/components/chat/ChatMarkdown";

interface Props {
  markdown: string;
  defaultOpen?: boolean;
}

export function DescriptionSection({ markdown, defaultOpen = true }: Props) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="mb-4">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors cursor-pointer mb-2"
      >
        <ChevronRight className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`} />
        Description
      </button>
      {open && (
        <div className="border rounded-md bg-card shadow-sm px-4 py-3">
          <ChatMarkdown content={markdown} />
        </div>
      )}
    </div>
  );
}
