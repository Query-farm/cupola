import { useState } from 'react';
import { Download, FileDown, FolderInput, Share2 } from 'lucide-react';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '../ui/dialog';

export function ReportSharing({ canExportPdf, pending, onPdf, onFile, onSaveToLibrary }: {
  canExportPdf: boolean; pending: boolean; onPdf: () => void; onFile: () => void; onSaveToLibrary?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger render={<Button variant="outline" />}><Share2 />Share</DialogTrigger>
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Share report</DialogTitle>
        <DialogDescription>This report is saved on this device. Save a copy to a report library or download a copy to share.</DialogDescription>
      </DialogHeader>
      {onSaveToLibrary && <section className="space-y-2 rounded-lg border p-3"><h3 className="font-medium">Share from a report library</h3><p className="text-sm text-muted-foreground">Choose a library and folder. The local original stays on this device; the library controls who can access the copy.</p><Button onClick={() => { setOpen(false); onSaveToLibrary(); }}><FolderInput />Save to a report library…</Button></section>}
      <section className="space-y-2 rounded-lg border p-3">
        <h3 className="font-medium">For someone to read</h3>
        <p className="text-sm text-muted-foreground">A PDF contains the displayed results and applied filters. Recipients can read it without a data connection.</p>
        {pending && <p role="status" className="text-sm text-amber-800 dark:text-amber-300">Apply your changes before downloading a PDF so it matches the latest selections.</p>}
        <Button variant="outline" disabled={!canExportPdf || pending} onClick={onPdf}><FileDown />Download PDF</Button>
      </section>
      <section className="space-y-2 rounded-lg border p-3">
        <h3 className="font-medium">For someone to edit or refresh</h3>
        <p className="text-sm text-muted-foreground">An editable report file contains the latest saved or unsaved definition, selected filters, and saved history. Query results are refreshed when opened.</p>
        <p className="text-sm text-muted-foreground">The recipient opens Reports → Import and connects to the same data service with their own access.</p>
        <Button variant="outline" onClick={onFile}><Download />Download editable report</Button>
      </section>
      <p className="text-xs text-muted-foreground">Copies do not receive later edits. The address in your browser only opens reports already stored in that browser.</p>
    </DialogContent>
  </Dialog>;
}
