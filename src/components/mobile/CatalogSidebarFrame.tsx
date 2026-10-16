import type { ReactNode } from "react";
import { X } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "../ui/dialog";
import { BrandMark } from "../BrandMark";

export function CatalogSidebarFrame({ narrow, width, onClose, children }: { narrow: boolean; width: number; onClose: () => void; children: ReactNode }) {
  if (!narrow) return <div style={{ width, minWidth: width }} data-testid="catalog-sidebar">{children}</div>;
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent data-testid="catalog-sidebar" showCloseButton={false}
      className="flex flex-col gap-0 overflow-hidden rounded-none border-r border-border"
      style={{ left: 0, top: "var(--cupola-viewport-top, 0px)", transform: "none", translate: "none", width: "min(90vw,360px)", maxWidth: "none", height: "var(--cupola-viewport-height, 100dvh)", padding: 0 }}>
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 pt-[env(safe-area-inset-top)]">
        <BrandMark />
        <DialogTitle className="sr-only">Catalog sidebar</DialogTitle>
        <DialogClose className="flex size-11 items-center justify-center" aria-label="Close catalog sidebar"><X className="size-4" /></DialogClose>
      </div>
      <div className="min-h-0 flex-1 pb-[env(safe-area-inset-bottom)]">{children}</div>
    </DialogContent>
  </Dialog>;
}
