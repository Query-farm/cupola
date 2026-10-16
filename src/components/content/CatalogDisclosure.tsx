import { useId, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { useMediaQuery } from "@/lib/use-media-query";

/** Keeps secondary catalog content available without taking the first phone screen. */
export function CatalogDisclosure({ title, children }: { title: string; children: ReactNode }) {
  const isMobile = useMediaQuery("(max-width: 767px)");
  const [open, setOpen] = useState(false);
  const id = useId();
  return <section className="catalog-disclosure min-w-0">
    {isMobile && <button type="button" className="flex min-h-11 w-full items-center gap-2 text-sm font-medium text-left" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
      <ChevronRight className={`size-4 shrink-0 ${open ? "rotate-90" : ""}`} />{title}
    </button>}
    <div id={id} hidden={isMobile && !open}>{children}</div>
  </section>;
}
