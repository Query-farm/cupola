import { useState, type ReactNode } from "react";
import { SlidersHorizontal } from "lucide-react";
import { useMediaQuery } from "@/lib/use-media-query";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";

/** The same parameter form, with a focused sheet instead of a tall phone header. */
export function MobileReportFilters({ children, summary, pending }: { children: ReactNode; summary?: string; pending: boolean }) {
  const mobile = useMediaQuery("(max-width: 767px)");
  const [open, setOpen] = useState(false);
  if (!mobile) return children;
  return <>
    <div className="mobile-report-filter-bar">
      <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog"><SlidersHorizontal size={16} />Filters{pending && <span className="mobile-filter-pending" aria-label="Unapplied changes" />}</button>
      <p>{summary ? `Results use: ${summary}` : "Choose filters for this report"}</p>
    </div>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="mobile-more-sheet mobile-report-filters" onSubmit={() => setOpen(false)}>
        <DialogHeader><DialogTitle>Report filters</DialogTitle><DialogDescription>Choose values, then apply them to update the report.</DialogDescription></DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  </>;
}
