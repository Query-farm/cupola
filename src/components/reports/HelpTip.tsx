import { useState } from "react";
import { CircleHelp } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * A "?" beside a setting that explains it. Opens on hover like a tooltip, and
 * on click, tap, or Enter too, since tooltips alone never open on touch
 * screens or for keyboard users who cannot hover.
 *
 * The trigger's name deliberately omits the setting's label: fields are found
 * by label text (`getByLabel("Title")` also matches aria-labels containing
 * it), and screen readers already hear this text as the control's
 * description.
 */
export function HelpTip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger
      type="button"
      openOnHover
      delay={150}
      aria-label="Explain this setting"
      data-report-help
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      // Escape here must close only the help, not the block editor around it.
      onKeyDown={(event) => { if (event.key === "Escape" && open) { event.stopPropagation(); setOpen(false); } }}
    >
      <CircleHelp className="h-3.5 w-3.5" aria-hidden="true" />
    </PopoverTrigger>
    <PopoverContent side="top" align="start" className="max-w-72 p-2.5 text-xs leading-relaxed">{text}</PopoverContent>
  </Popover>;
}
