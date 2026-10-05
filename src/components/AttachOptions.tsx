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
import { Eye, EyeOff } from "lucide-react";
import { Switch } from "./ui/switch";
import { fieldKind, fieldPlaceholder, optionInputKind } from "@/lib/attach/form";
import type { OptionSpecInfo } from "@/lib/attach/options";
import type { LegacyEntry, OptionProblem } from "@/lib/attach/legacy-options";
import type { ActiveWorkspace } from "@/lib/workspace/spec";
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
  /** Prefix of the field ids, so several forms can share a page. */
  idPrefix?: string;
  /** The workspace manager's grid (`optionInputKind`): BOOLEAN as a switch,
   *  numbers as number inputs, nested types marked as DuckDB syntax, and a
   *  reveal toggle on secrets. The plain forms keep the simpler controls. */
  rich?: boolean;
}

/** One row per declared option, plus the raw-text fallback. */
export function OptionsFields({ specs, values, onChange, raw, onRawChange, showRaw = true, idPrefix = "attach-opt", rich = false }: OptionsFieldsProps) {
  const set = (name: string, value: string) => onChange({ ...values, [name]: value });
  return (
    <div className={rich ? "grid gap-3 sm:grid-cols-2" : "flex flex-col gap-3"} data-testid="attach-options-fields">
      {specs.map((spec) => {
        if (rich) return <RichOptionField key={spec.name} spec={spec} id={`${idPrefix}-${spec.name}`} value={values[spec.name] ?? ""} onChange={(v) => set(spec.name, v)} />;
        const id = `${idPrefix}-${spec.name}`;
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
        <div className={rich ? "flex flex-col gap-1 sm:col-span-2" : "flex flex-col gap-1"}>
          <label htmlFor={`${idPrefix}-raw`} className="text-xs font-medium text-foreground">
            {specs.length ? "Other options" : "Connection options"}
          </label>
          <textarea
            id={`${idPrefix}-raw`}
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

/** One option in the manager's grid. The label carries the name, type and
 *  a "required" marker in text (never colour alone); the description is the
 *  help text, tied to the control with `aria-describedby`. */
function RichOptionField({ spec, id, value, onChange }: { spec: OptionSpecInfo; id: string; value: string; onChange: (value: string) => void }) {
  const [revealed, setRevealed] = useState(false);
  const kind = optionInputKind(spec);
  const helpId = `${id}-help`;
  const describedBy = spec.description || kind === "duckdb" ? helpId : undefined;
  const label = (
    <label htmlFor={id} className="flex flex-wrap items-baseline gap-1.5 text-xs font-medium text-foreground">
      <code className="font-mono">{spec.name}</code>
      <span className="text-muted-foreground font-normal">{spec.duckdbType}</span>
      {spec.required && <span className="text-destructive" data-testid="option-required">* required</span>}
      {spec.secret && <span className="text-muted-foreground font-normal">· secret, kept in this browser</span>}
    </label>
  );
  const help = describedBy && (
    <p id={helpId} className="text-[11px] text-muted-foreground">
      {spec.description}
      {kind === "duckdb" && <>{spec.description ? " " : ""}DuckDB syntax, e.g. <code className="font-mono">{fieldPlaceholder(spec)}</code>.</>}
    </p>
  );
  if (kind === "switch") {
    const effective = value !== "" ? value === "true" : spec.defaultText === "true";
    return (
      <div className="flex flex-col gap-1" data-option={spec.name} data-kind={kind}>
        {label}
        <div className="flex items-center gap-2">
          <Switch id={id} checked={effective} onCheckedChange={(checked) => onChange(checked ? "true" : "false")} aria-describedby={describedBy} />
          <span className="text-xs text-muted-foreground">
            {value === "" ? (spec.defaultText != null ? `Default (${spec.defaultText})` : "Not set") : value}
          </span>
          {value !== "" && (
            <button type="button" className="text-[11px] text-muted-foreground underline-offset-2 hover:underline" onClick={() => onChange("")}>
              {spec.defaultText != null ? "Use default" : "Unset"}
            </button>
          )}
        </div>
        {help}
      </div>
    );
  }
  const type = kind === "secret" && !revealed ? "password" : kind === "date" ? "date" : kind === "integer" || kind === "number" ? "number" : "text";
  return (
    <div className="flex flex-col gap-1" data-option={spec.name} data-kind={kind}>
      {label}
      <div className="flex items-center gap-1">
        <input
          id={id}
          type={type}
          step={kind === "integer" ? 1 : kind === "number" ? "any" : undefined}
          autoComplete={kind === "secret" ? "new-password" : "off"}
          spellCheck={false}
          required={spec.required}
          aria-required={spec.required || undefined}
          aria-describedby={describedBy}
          value={value}
          placeholder={kind === "secret" ? "" : fieldPlaceholder(spec)}
          onChange={(e) => onChange(e.target.value)}
          className={`${inputClass} font-mono`}
        />
        {kind === "secret" && (
          <button
            type="button"
            onClick={() => setRevealed((r) => !r)}
            aria-pressed={revealed}
            aria-label={revealed ? `Hide ${spec.name}` : `Show ${spec.name}`}
            className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="option-reveal"
          >
            {revealed ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
          </button>
        )}
      </div>
      {help}
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

/** Shown before a workspace link attaches anything: which servers it
 *  connects to, under which names, with which options. A link can name any
 *  URL, and attaching sends this browser's requests (and stored credentials
 *  for that server) there, so the reader agrees first. */
export function CatalogsConsentPanel({
  workspace,
  onAnswer,
}: { workspace: ActiveWorkspace; onAnswer: (granted: boolean) => void }) {
  const count = workspace.catalogs.length;
  return (
    <div className="bg-card rounded-xl ring-1 ring-foreground/10 p-5 max-w-xl w-full" data-testid="workspace-consent">
      <h1 className="font-heading text-lg font-semibold text-foreground mb-2">
        This link wants to attach {count === 1 ? "1 catalog" : `${count} catalogs`}
      </h1>
      <p className="text-sm text-muted-foreground mb-3">
        {workspace.name ? <>Workspace <span className="font-medium text-foreground">{workspace.name}</span>. </> : null}
        Cupola connects to each server below from this browser. Links never carry secrets; any a server needs are asked for here.
      </p>
      <ul className="mb-3 space-y-2" aria-label="Catalogs to attach">
        {workspace.catalogs.map((c) => (
          <li key={c.id} className="text-xs rounded-md bg-muted px-2.5 py-1.5">
            <div className="font-mono font-semibold text-foreground break-all">
              {c.alias}
              {c.alias !== c.catalogName && <span className="font-normal text-muted-foreground"> (catalog {c.catalogName})</span>}
              {c.id === workspace.defaultCatalogId && <span className="ml-1.5 font-sans font-normal text-muted-foreground">default</span>}
            </div>
            <div className="font-mono text-muted-foreground break-all">{c.url}</div>
            {Object.keys(c.options).length > 0 && (
              <div className="font-mono text-muted-foreground break-all">
                {Object.entries(c.options).map(([k, v]) => `${k} = ${v}`).join(", ")}
              </div>
            )}
          </li>
        ))}
      </ul>
      {workspace.notes.length > 0 && (
        <ul className="mb-3 space-y-0.5 text-xs text-muted-foreground list-disc pl-4">
          {workspace.notes.map((n) => <li key={n}>{n}</li>)}
        </ul>
      )}
      <div className="flex flex-wrap gap-2 justify-end">
        <Button variant="outline" onClick={() => onAnswer(false)}>Don't attach</Button>
        <Button onClick={() => onAnswer(true)}>Attach {count === 1 ? "catalog" : `${count} catalogs`}</Button>
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
    if (!detail?.ran && detail?.stage !== "fetch") return;
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
            {detail?.stage === "fetch"
              ? "Cupola could not read this catalog from its server, so it was not attached. Check that the server is running and the URL is right."
              : detail?.ran
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
          {(detail?.ran || detail?.stage === "fetch") && (
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
