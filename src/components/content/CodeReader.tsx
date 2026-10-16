import { useState, type ReactNode } from "react";
import { Maximize2, WrapText } from "lucide-react";
import { useMediaQuery } from "@/lib/use-media-query";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";

/** Presentation-only wrapping: copying and running still use the original text. */
export function CodeReader({ children, actions, title = "SQL" }: { children: ReactNode; actions?: ReactNode; title?: string }) {
  const isMobile = useMediaQuery("(max-width: 767px)");
  const [wrap, setWrap] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const controls = <>
    <Button variant="ghost" size="icon-sm" aria-label="Wrap lines" title="Wrap lines" aria-pressed={wrap} onClick={() => setWrap(value => !value)}><WrapText /></Button>
    {actions}
  </>;
  return <div className="code-reader min-w-0" data-wrap={isMobile && wrap}>
    {(isMobile || actions) && <div className="code-reader-toolbar flex items-center justify-end gap-1 mb-1">
      {isMobile && <>
        <Button variant="ghost" size="icon-sm" aria-label="Wrap lines" title="Wrap lines" aria-pressed={wrap} onClick={() => setWrap(value => !value)}><WrapText /></Button>
        <Button variant="ghost" size="icon-sm" aria-label={`Expand ${title}`} title={`Expand ${title}`} onClick={() => setExpanded(true)}><Maximize2 /></Button>
      </>}
      {actions}
    </div>}
    <div className="code-reader-content min-w-0">{children}</div>
    <Dialog open={expanded} onOpenChange={setExpanded}>
      <DialogContent className="catalog-reader-dialog" showCloseButton={false}>
        <div className="flex items-center justify-between gap-3">
          <DialogTitle>{title}</DialogTitle>
          <DialogClose render={<Button variant="outline" className="min-h-11" />}>Done</DialogClose>
        </div>
        <div className="code-reader min-h-0 flex flex-1 flex-col" data-wrap={wrap}>
          <div className="code-reader-toolbar flex items-center justify-end gap-1 mb-2">{controls}</div>
          <div className="code-reader-content min-h-0 flex-1 overflow-auto">{children}</div>
        </div>
      </DialogContent>
    </Dialog>
  </div>;
}
