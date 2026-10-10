import { useState, type ReactNode } from 'react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { reportError } from '../../lib/reporting/client';

export interface ReportDetailsValues { name: string; description: string; tags: string[] }
export function ReportDetailsDialog({ initial, location, identity, blocked, onSave, onTransferOwnership, onClose }: {
  initial: ReportDetailsValues; location: string; identity?: ReactNode; blocked?: boolean;
  onSave?: (values: ReportDetailsValues) => void | Promise<void>; onTransferOwnership?: () => void; onClose: () => void;
}) {
  const [name, setName] = useState(initial.name), [description, setDescription] = useState(initial.description), [tags, setTags] = useState(initial.tags.join(', '));
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent className="sm:max-w-lg">
    <DialogHeader><DialogTitle>Report details</DialogTitle><DialogDescription>{location}</DialogDescription></DialogHeader>
    <form className="space-y-4" onSubmit={async e => { e.preventDefault(); if (!onSave || blocked || busy) return; setBusy(true); setError(''); try { await onSave({ name: name.trim(), description, tags: tags.split(',').map(t => t.trim()).filter(Boolean) }); onClose(); } catch (e) { setError(reportError(e)); } finally { setBusy(false); } }}>
      <label className="block space-y-1 text-sm">Name<Input aria-label="Name" required readOnly={!onSave} disabled={Boolean(onSave && blocked) || busy} value={name} onChange={e => setName(e.target.value)} /></label>
      <label className="block space-y-1 text-sm">Description<textarea aria-label="Description" readOnly={!onSave} disabled={Boolean(onSave && blocked) || busy} className="min-h-20 w-full rounded border bg-background p-2 disabled:opacity-50" value={description} onChange={e => setDescription(e.target.value)} /></label>
      <label className="block space-y-1 text-sm">Tags, separated by commas<Input aria-label="Tags" readOnly={!onSave} disabled={Boolean(onSave && blocked) || busy} value={tags} onChange={e => setTags(e.target.value)} /></label>
      {identity && <section aria-label="Report ownership" className="space-y-2 border-t pt-3 text-sm">{identity}{onTransferOwnership && <Button type="button" size="sm" variant="outline" disabled={blocked || busy} onClick={onTransferOwnership}>Transfer ownership…</Button>}</section>}
      {blocked && onSave && <p role="status" className="text-sm text-muted-foreground">Finish saving or resolve pending changes before changing report details.</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={onClose}>Close</Button>{onSave && <Button type="submit" disabled={blocked || busy || !name.trim()}>{busy ? 'Saving…' : 'Save changes'}</Button>}</DialogFooter>
    </form>
  </DialogContent></Dialog>;
}
