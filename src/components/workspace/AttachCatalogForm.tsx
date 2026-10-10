/**
 * "+ Attach a catalog…": the picker's inline form for adding catalogs to the
 * current workspace, attached into the running engine without a reload.
 *
 * The URL is asked what it serves (`fetchServiceCatalogs`) as it is typed,
 * and again on Test connection. A service listing several catalogs gets a
 * checkbox per catalog, all ticked. Each ticked catalog's declared options
 * get typed fields (`OptionsFields`: secrets masked, required ones marked).
 * One catalog takes an alias, prefilled with its server name and validated
 * against the workspace's; several are aliased by their names, de-duplicated
 * once. A server that cannot be reached, or wants a sign-in first, can still
 * be attached under an alias of the reader's choosing: the catalog then
 * shows its status with Retry or Sign in. A service behind OAuth lists its
 * catalogs only once signed in: "Sign in to list catalogs" (`onSignIn`)
 * signs in and comes back to this form.
 */
import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { CatalogListStatus, SignInToListPrompt } from "./SignInToListPrompt";
import { getUserInfo } from "@/lib/auth";
import { Button } from "../ui/button";
import { OptionsFields } from "../AttachOptions";
import { discoverCatalogs } from "@/lib/workspace/catalog-discovery";
import { collectFormOptions } from "@/lib/attach/form";
import { partitionSecrets, type OptionSpecInfo } from "@/lib/attach/options";
import { aliasProblem, assignAliases, isReservedAlias, isValidAlias, sanitizeAlias } from "@/lib/workspace/aliases";

export interface AttachRequest {
  url: string;
  catalogName: string;
  alias: string;
  /** Non-secret options. */
  options: Record<string, string>;
  rawOptions: string;
  secrets: Record<string, string>;
  specs: OptionSpecInfo[];
}

type Discovery =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ok"; catalogs: { name: string; specs: OptionSpecInfo[] }[] }
  | { state: "error"; error: string; signInRequired: boolean };

const SERVICE_URL = /^(?:https?|grainlift(?:\+(?:https?|iroh))?):\/\/\S+$/i;
const inputClass = "w-full px-2.5 py-1.5 rounded-md border border-input bg-card text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring";

export function AttachCatalogForm({
  takenAliases,
  onAttach,
  onCancel,
  onSignIn,
  initial,
}: {
  takenAliases: readonly string[];
  /** Start with this URL (and alias), ticking only `catalogName` when the service lists several:
   *  a report's Attach for a catalog it reads. Read on mount; key the form to change it. */
  initial?: { url: string; catalogName?: string; alias?: string };
  /** Resolves with an error to show, or null once attached. */
  onAttach: (requests: AttachRequest[]) => Promise<string | null>;
  onCancel: () => void;
  /** Sign in to the service, then come back to this form with `url`. */
  onSignIn?: (url: string) => Promise<unknown>;
}) {
  const [url, setUrl] = useState(initial?.url ?? "");
  const [discovery, setDiscovery] = useState<Discovery>({ state: "idle" });
  const [tested, setTested] = useState(false);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [alias, setAlias] = useState(initial?.alias ?? "");
  const [aliasEdited, setAliasEdited] = useState(Boolean(initial?.alias));
  const [values, setValues] = useState<Record<string, Record<string, string>>>({});
  const [raws, setRaws] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const target = url.trim();
  const discover = async (which: string) => {
    setDiscovery({ state: "loading" });
    const found = await discoverCatalogs(which);
    if (which !== url.trim()) return found;
    if (found.state === "ok") {
      setDiscovery({ state: "ok", catalogs: found.catalogs });
      const wanted = initial?.catalogName && found.catalogs.find((c) => c.name.toLowerCase() === initial.catalogName!.toLowerCase());
      setTicked(new Set(wanted ? [wanted.name] : found.catalogs.map((c) => c.name)));
    } else {
      setDiscovery(found);
    }
    return found;
  };

  // Ask the server as the URL is typed (debounced), like the connect form.
  useEffect(() => {
    setTested(false);
    if (!SERVICE_URL.test(target) || /^grainlift/i.test(target)) {
      setDiscovery({ state: "idle" });
      return;
    }
    const timer = setTimeout(() => void discover(target), 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const catalogs = discovery.state === "ok" ? discovery.catalogs : [];
  const chosen = catalogs.filter((c) => ticked.has(c.name));
  // The alias follows the server's name until the reader edits it.
  const single = catalogs.length <= 1 || chosen.length === 1;
  useEffect(() => {
    if (aliasEdited) return;
    const name = chosen[0]?.name;
    if (name && single) setAlias(assignAliases([{ catalogName: name }], takenAliases).aliases[0]);
    else if (!name && discovery.state === "error") setAlias("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosen[0]?.name, single, discovery.state]);

  const autoAliases = useMemo(
    () => assignAliases(chosen.map((c) => ({ catalogName: c.name })), takenAliases).aliases,
    [chosen, takenAliases],
  );
  const aliasError = single ? aliasProblem(alias, takenAliases) : null;

  const submit = async () => {
    setErrors([]);
    if (!SERVICE_URL.test(target)) {
      setErrors(["Enter an http(s) or grainlift URL."]);
      return;
    }
    const requests: AttachRequest[] = [];
    const problems: string[] = [];
    const list = catalogs.length ? chosen : [{ name: "", specs: [] as OptionSpecInfo[] }];
    if (!list.length) {
      setErrors(["Tick at least one catalog."]);
      return;
    }
    if (single && aliasError) {
      setErrors([aliasError]);
      return;
    }
    list.forEach((c, i) => {
      const collected = collectFormOptions(values[c.name] ?? {}, raws[c.name] ?? "", c.specs);
      problems.push(...collected.errors.map((e) => (list.length > 1 ? `${c.name}: ${e}` : e)));
      const { plain, secret } = partitionSecrets(collected.options, c.specs);
      requests.push({
        url: target,
        catalogName: c.name,
        alias: single ? alias : autoAliases[i],
        options: plain,
        rawOptions: collected.rawOptions,
        secrets: secret,
        specs: c.specs,
      });
    });
    if (problems.length) {
      setErrors(problems);
      return;
    }
    setBusy(true);
    const error = await onAttach(requests);
    setBusy(false);
    if (error) setErrors([error]);
  };

  return (
    <form
      className="flex flex-col gap-2.5 px-4 py-3"
      data-testid="attach-catalog-form"
      aria-label="Attach a catalog"
      onSubmit={(e) => { e.preventDefault(); void submit(); }}
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onCancel(); } }}
    >
      <label className="flex flex-col gap-1 text-xs font-medium text-foreground">
        Service URL
        <input
          type="url"
          autoFocus
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://my-server.example.com"
          className={inputClass}
          data-testid="attach-catalog-url"
        />
      </label>

      <div className="flex items-center gap-2 text-xs" aria-live="polite">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!SERVICE_URL.test(target) || discovery.state === "loading"}
          onClick={() => { setTested(true); void discover(target); }}
          data-testid="attach-catalog-test"
        >
          Test connection
        </Button>
        {discovery.state === "loading" && <span className="flex items-center gap-1 text-muted-foreground"><Loader2 className="size-3 animate-spin" />Checking…</span>}
        {discovery.state === "ok" && (tested || catalogs.length > 0) && (
          <span className="text-accent" data-testid="attach-catalog-test-result">
            Reachable: {catalogs.length} {catalogs.length === 1 ? "catalog" : "catalogs"}
          </span>
        )}
        {discovery.state === "error" && !discovery.signInRequired && (
          <span className="text-destructive line-clamp-2" data-testid="attach-catalog-test-result">
            Not reachable: {discovery.error}
          </span>
        )}
      </div>

      {discovery.state === "error" && discovery.signInRequired && (
        <SignInToListPrompt
          layout="stacked"
          url={target}
          hint={onSignIn ? "Or attach it now and sign in from its row." : "Attach it now and sign in from its row."}
          onSignIn={onSignIn}
        />
      )}

      {catalogs.length > 1 && (
        <fieldset className="flex flex-col gap-1" data-testid="attach-catalog-choices">
          <legend className="text-xs font-medium text-foreground mb-1">Catalogs on this service</legend>
          <CatalogListStatus user={getUserInfo(target)} />
          {catalogs.map((c, i) => (
            <label key={c.name} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={ticked.has(c.name)}
                onChange={(e) => setTicked((prev) => {
                  const next = new Set(prev);
                  if (e.target.checked) next.add(c.name); else next.delete(c.name);
                  return next;
                })}
              />
              <span className="font-mono">{c.name}</span>
              {!single && ticked.has(c.name) && <span className="text-xs text-muted-foreground">as {autoAliases[chosen.findIndex((x) => x.name === c.name)] ?? c.name}</span>}
              {i === 0 && <span className="text-[11px] text-muted-foreground">(first)</span>}
            </label>
          ))}
        </fieldset>
      )}

      {single && (
        <label className="flex flex-col gap-1 text-xs font-medium text-foreground">
          Alias <span className="font-normal text-muted-foreground">the name SQL uses for it, e.g. <code>{alias || "sales"}.main.orders</code></span>
          <input
            value={alias}
            onChange={(e) => { setAlias(e.target.value); setAliasEdited(true); }}
            onBlur={() => { if (alias && !isValidAlias(alias) && !isReservedAlias(alias)) setAlias(sanitizeAlias(alias)); }}
            placeholder="sales"
            spellCheck={false}
            aria-invalid={Boolean(alias && aliasError)}
            aria-describedby="attach-catalog-alias-error"
            className={`${inputClass} font-mono`}
            data-testid="attach-catalog-alias"
          />
          {alias && aliasError && <span id="attach-catalog-alias-error" className="text-[11px] font-normal text-destructive">{aliasError}</span>}
        </label>
      )}

      {chosen.filter((c) => c.specs.length > 0).map((c) => (
        <details key={c.name} open className="rounded-md border border-border p-2">
          <summary className="text-xs font-medium cursor-pointer">
            Options{chosen.length > 1 ? ` for ${c.name}` : ""}{c.specs.some((s) => s.required) ? "" : " (optional)"}
          </summary>
          <div className="mt-2">
            <OptionsFields
              idPrefix={`attach-catalog-${c.name}`}
              specs={c.specs}
              values={values[c.name] ?? {}}
              onChange={(next) => setValues((prev) => ({ ...prev, [c.name]: next }))}
              raw={raws[c.name] ?? ""}
              onRawChange={(next) => setRaws((prev) => ({ ...prev, [c.name]: next }))}
              showRaw={false}
            />
          </div>
        </details>
      ))}

      {errors.length > 0 && (
        <ul role="alert" className="text-xs text-destructive space-y-0.5">
          {errors.map((e) => <li key={e}>{e}</li>)}
        </ul>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" size="sm" disabled={busy || !target || discovery.state === "loading"} data-testid="attach-catalog-submit">
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
          Attach{chosen.length > 1 ? ` ${chosen.length} catalogs` : ""}
        </Button>
      </div>
    </form>
  );
}
