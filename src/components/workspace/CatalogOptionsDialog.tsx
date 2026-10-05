/**
 * "Edit options…" for one catalog of the workspace: the typed options form
 * (`OptionsFields`) over that catalog's stored options and secrets. Saving
 * stores them (non-secret values in the workspace record, secrets in the
 * secret store) and re-attaches only that catalog; the others stay attached.
 * Phase 1 had no way to change one catalog's options in a multi-catalog
 * workspace short of a new link.
 */
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { OptionsFields } from "../AttachOptions";
import { fetchServiceCatalogs } from "@/lib/service";
import { collectFormOptions, optionRows } from "@/lib/attach/form";
import type { OptionSpecInfo } from "@/lib/attach/options";

export interface OptionsEditTarget {
  catalogId: string;
  alias: string;
  url: string;
  catalogName: string;
  /** Specs already known from loading it; fetched when absent. */
  specs?: OptionSpecInfo[];
  options: Record<string, string>;
  secrets: Record<string, string>;
  rawOptions: string;
}

export function CatalogOptionsDialog({
  target,
  onClose,
  onSave,
}: {
  target: OptionsEditTarget | null;
  onClose: () => void;
  /** Store and re-attach; resolves with an error to show, or null. */
  onSave: (target: OptionsEditTarget, options: Record<string, string>, rawOptions: string, specs: OptionSpecInfo[]) => Promise<string | null>;
}) {
  const [specs, setSpecs] = useState<OptionSpecInfo[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [raw, setRaw] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!target) return;
    setValues({ ...target.options, ...target.secrets });
    setRaw(target.rawOptions);
    setErrors([]);
    if (target.specs) { setSpecs(target.specs); return; }
    setSpecs(null);
    let live = true;
    void fetchServiceCatalogs(target.url).then((found) => {
      if (!live) return;
      const match = found.ok ? found.catalogs.find((c) => c.name === target.catalogName) ?? found.catalogs[0] : undefined;
      setSpecs(match?.specs ?? []);
    });
    return () => { live = false; };
  }, [target]);

  const rows = optionRows(specs ?? [], values);
  const save = async () => {
    if (!target || !specs) return;
    const collected = collectFormOptions(values, raw, rows);
    if (collected.errors.length) { setErrors(collected.errors); return; }
    setBusy(true);
    const error = await onSave(target, collected.options, collected.rawOptions, rows);
    setBusy(false);
    if (error) setErrors([error]);
    else onClose();
  };

  return (
    <Dialog open={!!target} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg" data-testid="catalog-options-dialog">
        <DialogHeader>
          <DialogTitle>Options for {target?.alias}</DialogTitle>
          <DialogDescription className="font-mono text-xs break-all">{target?.url}</DialogDescription>
        </DialogHeader>
        {specs === null ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Reading the server's options…</p>
        ) : (
          <form id="catalog-options-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <OptionsFields idPrefix={`catalog-opt-${target?.catalogId ?? ""}`} specs={rows} values={values} onChange={setValues} raw={raw} onRawChange={setRaw} showRaw />
            <p className="mt-3 text-[11px] text-muted-foreground">Secret values stay in this browser and are never put in links. Saving re-attaches this catalog only.</p>
          </form>
        )}
        {errors.length > 0 && (
          <ul role="alert" className="text-xs text-destructive space-y-0.5">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="catalog-options-form" disabled={busy || specs === null} data-testid="catalog-options-save">
            {busy && <Loader2 className="size-3.5 animate-spin" />}Save and re-attach
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
