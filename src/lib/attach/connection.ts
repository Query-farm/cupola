/**
 * Where a catalog's attach options come from, and where they go back to.
 *
 * Sources, in increasing precedence: the workspace catalog's stored record
 * (structured options, plus raw text still awaiting migration), the secret
 * store, and the URL (`?attach_options=` raw text, `?data_version_spec=`, a
 * Grainlift `?target=`). The URL's plain literals apply at once; its
 * expressions wait for the reader's consent, then for the engine
 * (`prepare.ts`).
 *
 * Nothing is persisted until the catalog's specs are known, because only the
 * specs say which options are secret: `finalizeConnection` writes non-secret
 * values to the workspace catalog, secrets to the secret store (both through
 * its `OptionSink`), and only then strips `attach_options` from the address
 * bar. Before workspaces both went to the recent-services list, keyed by URL.
 */
import {
  getAttachOptionsFromUrl,
  getDataVersionSpecFromUrl,
  getTargetFromUrl,
  hasExplicitService,
  stripAttachOptionsFromUrl,
} from "../url-params";
import { parsePlainLiteral, splitLegacyOptions, type LegacyEntry, type OptionProblem } from "./legacy-options";
import { isSecretOption, missingRequiredOptions, partitionSecrets, type OptionSpecInfo } from "./options";

/** Where one catalog's options are stored: a workspace catalog's record and
 *  its secrets (`workspace/store.ts`'s `catalogOptionSink`). */
export interface OptionSink {
  /** Stored non-secret options and pending raw text. */
  stored(): { options: Record<string, string>; rawOptions?: string };
  /** Stored secrets, once the server's catalog name is known. */
  secrets(catalogName: string): Record<string, string>;
  /** Record the catalog's name and replace the given fields. */
  save(catalogName: string, update: { options?: Record<string, string>; rawOptions?: string }): void;
  saveSecrets(catalogName: string, values: Record<string, string>, opts?: { replace?: boolean }): void;
  /** Forget the options and secrets (an explicit empty `?attach_options=`). */
  clear(): void;
}

/** A sink that stores nothing: a catalog whose options are this page's only. */
export const NULL_SINK: OptionSink = {
  stored: () => ({ options: {} }),
  secrets: () => ({}),
  save: () => {},
  saveSecrets: () => {},
  clear: () => {},
};

export interface ConnectionInput {
  serviceUrl: string;
  /** Where its options are stored. */
  sink: OptionSink;
  /** Structured options from storage and the URL. Secrets are added by
   *  `finalizeConnection`, once the catalog name is known. */
  options: Record<string, string>;
  /** Options only for this page load (`?data_version_spec=`): applied to the
   *  ATTACH, never stored. */
  sessionOptions: Record<string, string>;
  /** Expressions to evaluate in the engine: stored raw text the user already
   *  entered, plus URL expressions once consented to. */
  pending: LegacyEntry[];
  /** URL expressions awaiting consent. */
  needsConsent: LegacyEntry[];
  /** What could not be used; reported to the user. */
  problems: OptionProblem[];
  /** Whether `?attach_options=` was present (and needs stripping). */
  fromUrl: boolean;
}

/** Read every option source for `serviceUrl`. Side effect: an explicit empty
 *  `?attach_options=` clears the stored options, as it always has. */
export function readConnectionInput(serviceUrl: string, { grainlift = false, sink = NULL_SINK }: { grainlift?: boolean; sink?: OptionSink } = {}): ConnectionInput {
  const explicit = hasExplicitService();
  const urlRaw = explicit ? getAttachOptionsFromUrl() : undefined;
  const input: ConnectionInput = {
    serviceUrl,
    sink,
    options: {},
    sessionOptions: {},
    pending: [],
    needsConsent: [],
    problems: [],
    fromUrl: urlRaw !== undefined,
  };

  if (urlRaw !== undefined && urlRaw.trim() === "") {
    sink.clear();
  } else {
    const recent = sink.stored();
    Object.assign(input.options, recent.options);
    if (recent.rawOptions) {
      const stored = splitLegacyOptions(recent.rawOptions);
      input.pending.push(...stored.entries);
      input.problems.push(...stored.problems);
    }
  }

  if (urlRaw?.trim()) {
    const fromUrl = splitLegacyOptions(urlRaw);
    input.problems.push(...fromUrl.problems);
    for (const entry of fromUrl.entries) {
      const plain = parsePlainLiteral(entry.expr);
      // The URL is newer than anything stored for the same option.
      input.pending = input.pending.filter((p) => p.name !== entry.name);
      if (plain !== null) input.options[entry.name] = plain;
      else input.needsConsent.push(entry);
    }
  }

  const target = grainlift && explicit ? getTargetFromUrl() : undefined;
  if (target) input.options.target = target;
  const dvs = getDataVersionSpecFromUrl();
  if (dvs) input.sessionOptions.data_version_spec = dvs;
  return input;
}

/** The options input for one catalog of a stored workspace: its own
 *  (non-secret, already DuckDB text) options, any raw text still awaiting
 *  evaluation, its Grainlift target and pinned data version. Its secrets are
 *  merged in by `finalizeConnection`. */
export function workspaceConnectionInput(catalog: {
  url: string;
  options: Record<string, string>;
  target?: string;
  dataVersionSpec?: string;
}, sink: OptionSink = NULL_SINK): ConnectionInput {
  const input: ConnectionInput = {
    serviceUrl: catalog.url,
    sink,
    options: { ...catalog.options, ...(catalog.target ? { target: catalog.target } : {}) },
    sessionOptions: catalog.dataVersionSpec ? { data_version_spec: catalog.dataVersionSpec } : {},
    pending: [],
    needsConsent: [],
    problems: [],
    fromUrl: false,
  };
  const raw = sink.stored().rawOptions;
  if (raw) {
    const stored = splitLegacyOptions(raw);
    input.pending.push(...stored.entries.filter((e) => !(e.name in input.options)));
    input.problems.push(...stored.problems);
  }
  return input;
}

/** Apply the reader's answer to the consent screen. */
export function applyConsent(input: ConnectionInput, granted: boolean): ConnectionInput {
  if (granted) {
    return { ...input, pending: [...input.pending, ...input.needsConsent], needsConsent: [] };
  }
  return {
    ...input,
    needsConsent: [],
    problems: [
      ...input.problems,
      ...input.needsConsent.map((e) => ({ name: e.name, text: `${e.name} ${e.expr}`, reason: "Not used: you chose not to evaluate it." })),
    ],
  };
}

/** Whether any option or expression is set, i.e. whether the catalog might
 *  attach differently from an option-less RPC attach. */
export function hasAnyOptions(input: ConnectionInput): boolean {
  return Object.keys(input.options).length > 0 || Object.keys(input.sessionOptions).length > 0
    || input.pending.length > 0 || input.needsConsent.length > 0;
}

export interface FinalizedConnection {
  /** Every value for the ATTACH, secrets included. */
  options: Record<string, string>;
  pending: LegacyEntry[];
  /** Required options with no value and no pending expression. */
  missing: OptionSpecInfo[];
}

/** Merge in the stored secrets, persist what may be persisted, and strip the
 *  URL. Called once the catalog's name and specs are known. */
export function finalizeConnection(
  input: ConnectionInput,
  catalogName: string,
  specs: readonly OptionSpecInfo[],
  { persist = hasExplicitService() || input.fromUrl }: { persist?: boolean } = {},
): FinalizedConnection {
  const options = { ...input.sink.secrets(catalogName), ...input.options };
  const { plain, secret } = partitionSecrets(options, specs);
  // Pending expressions for a secret option are evaluated this page load and
  // stored (as a secret) by `persistEvaluatedOptions`; their raw text is not
  // kept in the recent list.
  const rawOptions = input.pending
    .filter((e) => !isSecretOption(e.name, specs))
    .map((e) => `${e.name} ${e.expr}`)
    .join(", ");
  if (persist) {
    input.sink.save(catalogName, { options: plain, rawOptions });
    input.sink.saveSecrets(catalogName, secret, { replace: false });
  }
  if (input.fromUrl) stripAttachOptionsFromUrl();
  const all = { ...options, ...input.sessionOptions };
  const pendingNames = Object.fromEntries(input.pending.map((e) => [e.name, ""]));
  return {
    options: all,
    pending: input.pending,
    missing: missingRequiredOptions({ ...all, ...pendingNames }, specs),
  };
}

/** Store expressions the engine evaluated (structured from now on), and drop
 *  the raw text they came from. */
export function persistEvaluatedOptions(
  sink: OptionSink,
  catalogName: string,
  values: Record<string, string>,
  specs: readonly OptionSpecInfo[] | undefined,
): void {
  const { plain, secret } = partitionSecrets(values, specs);
  sink.save(catalogName, { options: { ...sink.stored().options, ...plain }, rawOptions: "" });
  if (Object.keys(secret).length) sink.saveSecrets(catalogName, secret);
}

/** Save options entered in the options form: non-secret values to the
 *  workspace catalog, secrets to the secret store (replacing that catalog's
 *  set), and the raw-text remainder as pending text. */
export function saveFormOptions(
  sink: OptionSink,
  catalogName: string,
  options: Record<string, string>,
  rawOptions: string,
  specs: readonly OptionSpecInfo[] | undefined,
): void {
  const { plain, secret } = partitionSecrets(options, specs);
  sink.save(catalogName, { options: plain, rawOptions });
  sink.saveSecrets(catalogName, secret, { replace: true });
}
