/**
 * The attach-options UI: the typed options fields (connect form, required
 * options screen), the consent panel for a link whose options need
 * evaluating, the attach-error panel and the dropped-options notice.
 *
 * Deliberately plain: phase 2/3 of the multi-catalog work builds richer
 * editors on these (docs/multi-catalog.md).
 */
import { useEffect, useState } from "react";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { fieldKind, fieldPlaceholder } from "@/lib/attach/form";
import type { OptionSpecInfo } from "@/lib/attach/options";
import type { LegacyEntry, OptionProblem } from "@/lib/attach/legacy-options";
import { probeService, statusFromError, type AttachErrorDetail, type ServiceProbe } from "@/lib/attach/error-detail";

const inputClass =
  "w-full px-2.5 py-1.5 rounded-md border border-input bg-card text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring";

export interface OptionsFieldsProps {
  specs: readonly OptionSpecInfo[];
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
  raw: string;
  onRawChange: (raw: string) => void;
  /** Show the raw-text box. Always shown when there are no specs. */
  showRaw?: boolean;
}

/** One row per declared option, plus the raw-text fallback. */
export function OptionsFields({ specs, values, onChange, raw, onRawChange, showRaw = true }: OptionsFieldsProps) {
  const set = (name: string, value: string) => onChange({ ...values, [name]: value });
  return (
    <div className="flex flex-col gap-3" data-testid="attach-options-fields">
      {specs.map((spec) => {
        const id = `attach-opt-${spec.name}`;
        const kind = fieldKind(spec);
        const value = values[spec.name] ?? "";
        return (
          <div key={spec.name} className="flex flex-col gap-1" data-option={spec.name}>
            <label htmlFor={id} className="flex items-baseline gap-1.5 text-xs font-medium text-foreground">
              <code className="font-mono">{spec.name}</code>
              <span className="text-muted-foreground font-normal">{spec.duckdbType}</span>
              {spec.required && <span className="text-destructive" title="Required">required</span>}
              {spec.secret && <span className="text-muted-foreground font-normal">· secret, not shared</span>}
            </label>
            {kind === "boolean" ? (
              <select id={id} value={value} onChange={(e) => set(spec.name, e.target.value)} className={inputClass}>
                <option value="">{spec.defaultText != null ? `Default (${spec.defaultText})` : "Not set"}</option>
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : (
              <input
                id={id}
                type={kind === "secret" ? "password" : kind === "date" ? "date" : "text"}
                inputMode={kind === "integer" ? "numeric" : kind === "number" ? "decimal" : undefined}
                autoComplete={kind === "secret" ? "new-password" : "off"}
                spellCheck={false}
                required={spec.required}
                value={value}
                placeholder={kind === "secret" ? "" : fieldPlaceholder(spec)}
                onChange={(e) => set(spec.name, e.target.value)}
                className={`${inputClass} font-mono`}
              />
            )}
            {spec.description && <p className="text-[11px] text-muted-foreground">{spec.description}</p>}
          </div>
        );
      })}
      {(showRaw || specs.length === 0) && (
        <div className="flex flex-col gap-1">
          <label htmlFor="attach-opt-raw" className="text-xs font-medium text-foreground">
            {specs.length ? "Other options" : "Connection options"}
          </label>
          <textarea
            id="attach-opt-raw"
            value={raw}
            onChange={(e) => onRawChange(e.target.value)}
            placeholder="e.g. opt_string 'hello', opt_int64 42, opt_bool true"
            rows={2}
            spellCheck={false}
            className={`${inputClass} text-xs font-mono resize-y`}
          />
          <p className="text-[11px] text-muted-foreground">
            <code className="font-mono">name value</code> pairs, comma-separated. Values are DuckDB constants;
            nothing here runs as SQL.
          </p>
        </div>
      )}
    </div>
  );
}

/** Shown before attaching when a link's options need evaluating. */
export function ConsentPanel({
  serviceUrl,
  entries,
  onAnswer,
}: { serviceUrl: string; entries: readonly LegacyEntry[]; onAnswer: (granted: boolean) => void }) {
  return (
    <div className="bg-card rounded-xl ring-1 ring-foreground/10 p-5 max-w-lg w-full" data-testid="attach-options-consent">
      <h1 className="font-heading text-lg font-semibold text-foreground mb-2">This link sets connection options</h1>
      <p className="text-sm text-muted-foreground mb-3">
        The link to <span className="font-mono break-all">{serviceUrl}</span> gives these options as SQL expressions.
        Cupola evaluates only constants (values, casts, lists, structs and maps), and refuses anything else.
      </p>
      <ul className="mb-4 space-y-1">
        {entries.map((e) => (
          <li key={e.name} className="text-xs font-mono bg-muted rounded px-2 py-1 break-all">
            {e.name} {e.expr}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2 justify-end">
        <Button variant="outline" onClick={() => onAnswer(false)}>Connect without them</Button>
        <Button onClick={() => onAnswer(true)}>Use these options</Button>
      </div>
    </div>
  );
}

/** Lists options that were not used. */
export function OptionsNoticeDialog({ problems, onClose }: { problems: OptionProblem[]; onClose: () => void }) {
  return (
    <Dialog open={problems.length > 0} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-xl" data-testid="attach-options-notice">
        <DialogHeader>
          <DialogTitle>Some connection options were not used</DialogTitle>
          <DialogDescription>
            These were dropped rather than sent to the server. Edit the connection to set them again.
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-2 max-h-80 overflow-auto">
          {problems.map((p, i) => (
            <li key={i} className="text-xs">
              <code className="font-mono bg-muted rounded px-1.5 py-0.5 break-all">{p.text}</code>
              <span className="block mt-0.5 text-muted-foreground">{p.reason}</span>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button onClick={onClose}>OK</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">{title}</div>
      {children}
    </div>
  );
}

const preClass = "text-xs bg-muted p-3 rounded-md overflow-auto max-h-60 whitespace-pre-wrap break-all font-mono";

/** The panel for a failed (or refused) ATTACH. */
export function AttachErrorDialog({
  detail,
  onClose,
  onEditOptions,
}: { detail: AttachErrorDetail | null; onClose: () => void; onEditOptions: () => void }) {
  const [probe, setProbe] = useState<ServiceProbe | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    setProbe(null);
    if (!detail?.ran) return;
    let live = true;
    void probeService(detail.serviceUrl).then((p) => { if (live) setProbe(p); });
    return () => { live = false; };
  }, [detail]);

  const copy = (label: string, text?: string) => {
    if (!text) return;
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    }).catch(() => {});
  };
  const quotedStatus = detail ? statusFromError(detail.message) : null;
  const v = detail?.versions;

  return (
    <Dialog open={!!detail} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[90dvh] overflow-y-auto" data-testid="attach-error-panel">
        <DialogHeader>
          <DialogTitle>{detail?.title ?? "Connection failed"}</DialogTitle>
          <DialogDescription>
            {detail?.ran
              ? "DuckDB rejected the ATTACH statement. This is usually a missing, misspelled or mistyped connection option."
              : "Cupola checked the connection options before attaching and did not run the ATTACH."}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {detail?.problems?.length ? (
            <Section title="Options">
              <ul className="space-y-1">
                {detail.problems.map((p, i) => (
                  <li key={i} className="text-xs"><code className="font-mono">{p.name ?? p.text}</code>: {p.reason}</li>
                ))}
              </ul>
            </Section>
          ) : (
            <Section title="Error">
              <pre className={preClass}>{detail?.message}</pre>
            </Section>
          )}
          {detail?.sql && (
            <Section title={detail.ran ? "Statement (secrets redacted)" : "Statement that would run (secrets redacted)"}>
              <pre className={preClass} data-testid="attach-error-sql">{detail.sql}</pre>
            </Section>
          )}
          {detail?.ran && (
            <Section title="Server">
              <div className="text-xs space-y-0.5">
                <div>
                  HTTP status:{" "}
                  {probe ? (probe.status ?? `unreachable (${probe.error ?? "no response"})`) : "checking…"}
                  {quotedStatus !== null && <> · quoted in the error: {quotedStatus}</>}
                </div>
                {probe?.headers.map(([name, value]) => (
                  <div key={name} className="font-mono break-all">{name}: {value}</div>
                ))}
              </div>
            </Section>
          )}
          {v && (
            <Section title="Versions">
              <div className="text-xs font-mono">
                Cupola {v.cupola} · DuckDB {v.duckdb ?? "?"} · extension {v.vgiExtension ?? "?"}
                {v.server ? ` · server ${v.server}` : ""}
              </div>
            </Section>
          )}
        </div>
        <DialogFooter className="flex-wrap gap-2">
          <Button variant="outline" onClick={() => copy("error", detail?.message)}>
            {copied === "error" ? "Copied" : "Copy error"}
          </Button>
          {detail?.cliScript && (
            <Button variant="outline" onClick={() => copy("cli", detail.cliScript)}>
              {copied === "cli" ? "Copied" : "Copy as duckdb CLI"}
            </Button>
          )}
          <Button onClick={onEditOptions}>Edit connection options</Button>
          <Button variant="ghost" onClick={onClose}>Dismiss</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
