/* ── Mosaic spec JSON-schema validation ──
 *
 * Validates a Mosaic vgplot spec against the schema shipped by
 * @uwdata/mosaic-spec (draft-07). Used as a pre-flight check in the
 * `generate_chart` tool so the agent gets *structural* errors (wrong
 * attribute names, type mismatches, missing required keys) before we
 * waste a full parse + DuckDB query roundtrip on a hopeless spec.
 *
 * Both Ajv and the 8.6 MB schema are dynamic-imported so they only
 * load on the first chart attempt of a session. After the first call,
 * the compiled validator is cached at module scope — Ajv's compile()
 * is the expensive part (re-parsing 8 MB of $refs), so we do it once.
 *
 * Designed for agent feedback, not human display. Every error includes:
 *   - JSON pointer to the failing location
 *   - The Ajv keyword that fired (so the agent can pattern-match)
 *   - A description carrying the actually-relevant context: offending
 *     value, allowed alternatives, missing key, etc.
 * For `anyOf`/`oneOf` failures we surface the *best-matching branch's*
 * sub-errors instead of the useless "must match a schema in anyOf"
 * parent. With 80+ anyOf branches in the Mosaic schema (one per mark
 * type), this is the only way the agent gets actionable feedback.
 */

let _validatorPromise: Promise<(spec: unknown) => RawValidation> | null = null;

interface RawAjvError {
  instancePath?: string;
  schemaPath?: string;
  message?: string;
  keyword?: string;
  params?: Record<string, unknown>;
}

/**
 * Extract the definition name from an Ajv schemaPath like
 *   "#/definitions/MarkPlot/properties/mark/const"  →  "MarkPlot"
 * Returns null if the schemaPath isn't anchored at a named definition
 * (e.g. top-level anyOf branches in the Mosaic schema aren't named — the
 * agent has to fall back to listing definitions and picking by name).
 *
 * Kept inline here (rather than imported from mosaic-schema-tools.ts) so
 * the validator stays self-contained — the schema-tools module's lazy
 * import doesn't need to be paid just for the hint extraction.
 */
function definitionFromSchemaPath(schemaPath: string | undefined): string | undefined {
  if (!schemaPath) return undefined;
  const m = schemaPath.match(/\/definitions\/([A-Za-z0-9_]+)/);
  return m ? m[1] : undefined;
}

interface RawValidation {
  valid: boolean;
  errors: RawAjvError[];
}

export interface MosaicValidationError {
  /** JSON pointer to the failing location in the spec, e.g. `/plot/0/mark`. */
  path: string;
  /** Human description of the violation, with offending value and any
   *  allowed alternatives baked in. Designed to be readable on its own. */
  description: string;
  /** Ajv keyword that fired — useful when the agent wants to pattern-match
   *  on error category (e.g. `enum`, `required`, `type`). */
  keyword: string;
  /** Ajv's raw `params` object. Retained for downstream callers that want
   *  to render the error differently. */
  params?: Record<string, unknown>;
  /** The actual value present at `path` in the spec, when resolvable. Lets
   *  the agent see what they wrote without re-locating the JSON pointer. */
  value?: unknown;
  /** Best-guess named schema definition the agent should fetch via the
   *  `read_chart_schema` tool to see the exact shape requirement. Extracted
   *  from the error's `schemaPath` when it contains `/definitions/Name`. */
  definitionHint?: string;
}

export interface MosaicValidation {
  valid: boolean;
  errors: MosaicValidationError[];
}

async function getValidator(): Promise<(spec: unknown) => RawValidation> {
  if (_validatorPromise) return _validatorPromise;
  _validatorPromise = (async () => {
    // The schema is a verbatim copy of node_modules/@uwdata/mosaic-spec/
    // dist/mosaic-schema.json, pinned in our repo because the package's
    // exports field doesn't expose nested subpaths. Re-copy it when bumping
    // the mosaic-spec dependency to keep validation in lockstep with the
    // parser shipped to runtime.
    const [{ default: Ajv }, schemaModule] = await Promise.all([
      import("ajv"),
      import("./mosaic-schema.json"),
    ]);
    const schema = (schemaModule as any).default ?? schemaModule;

    // strict: false — the Mosaic schema has draft-07 idioms Ajv 8 warns
    //   about under strict mode (it's draft-2020 by default).
    // allErrors: true — return every error per call. The agent benefits
    //   from seeing all problems at once instead of fix-rerun-fix-rerun.
    // verbose: true — populate `schemaPath` on each error so we can
    //   group anyOf branches by their `#/.../anyOf/N/...` prefix and pick
    //   the closest-matching branch.
    // allowUnionTypes: true — union types appear in the schema for
    //   "string | number" style attributes.
    // logger: false — the schema declares "format": "uri" in ~80 places;
    //   without an explicit format registration Ajv emits one warning
    //   per occurrence (~160 lines of noise) at every compile. The format
    //   itself is non-validating here, so silence the logger entirely.
    const ajv = new Ajv({
      strict: false,
      allErrors: true,
      verbose: true,
      allowUnionTypes: true,
      logger: false,
    });
    const validate = ajv.compile(schema);

    return (spec: unknown): RawValidation => {
      const ok = validate(spec) as boolean;
      if (ok) return { valid: true, errors: [] };
      return { valid: false, errors: (validate.errors || []) as RawAjvError[] };
    };
  })();
  return _validatorPromise;
}

/**
 * Validate a spec against the bundled Mosaic JSON schema. Returns
 * `{ valid: true, errors: [] }` on success and `{ valid: false, errors: [...] }`
 * on failure.
 *
 * Strategy for the (numerous, noisy) Ajv error stream:
 *
 *  1. Drop child errors that share an `anyOf` parent path EXCEPT those from
 *     the best-matching branch. With ~80 branches in the Mosaic schema,
 *     surfacing every branch's failure produces hundreds of lines of "must
 *     have property foo" for branches the user never intended. Picking the
 *     branch with the fewest sub-errors typically lands on the one the
 *     user was reaching for — its errors are the actionable ones.
 *  2. Dedupe identical `(path, keyword, message)` entries.
 *  3. Resolve the JSON pointer for each remaining error against the actual
 *     spec and attach the offending value, so the agent doesn't have to
 *     reverse-engineer what it wrote.
 *  4. Synthesize a human description per error using Ajv's `params` field
 *     (allowed enum values, missing required key, offending additional
 *     property, expected type, etc.).
 *  5. Cap at 25 entries so a wildly malformed spec doesn't drown out the
 *     other tool-result content.
 */
export async function validateMosaicSpec(spec: unknown): Promise<MosaicValidation> {
  const validate = await getValidator();
  const raw = validate(spec);
  if (raw.valid) return raw as MosaicValidation;

  // Order matters: collapse FIRST on the raw Ajv stream, before the picker.
  //   - collapseAnyOfNoise needs the anyOf parent errors intact so it can
  //     identify which instancePaths the schema declared as alternatives.
  //     Once it knows those paths, it suppresses every per-branch failure
  //     at exactly those paths (they're all noise — Ajv reports each
  //     branch's individual requirements and the agent can't choose
  //     between branches by name).
  //   - Then the picker selects the best inner branch for any anyOfs that
  //     remain at sub-paths (the parent for those was already kept by the
  //     collapse step).
  //   - Then merge collapses `const`/`enum`/`type` alternatives at one
  //     path into a single readable "one of [list]" line.
  const collapsed = collapseAnyOfNoise(raw.errors);
  const picked = pickBestBranchErrors(collapsed);
  const merged = mergeAlternativeErrors(picked);
  const pruned = suppressRedundantAnyOfParents(merged);
  const seen = new Set<string>();
  const out: MosaicValidationError[] = [];
  for (const e of pruned) {
    const path = e.instancePath || "/";
    const description = describeError(e, spec);
    const key = `${path}|${e.keyword}|${description}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      path,
      description,
      keyword: e.keyword || "",
      params: e.params,
      value: resolveJsonPointer(spec, path),
      definitionHint: definitionFromSchemaPath(e.schemaPath),
    });
    if (out.length >= 25) break;
  }
  return { valid: false, errors: out };
}

/**
 * Drop `anyOf` / `oneOf` parent errors at path P when there are concrete
 * (non-anyOf) errors at any descendant path P/foo, P/foo/bar, etc. The
 * deeper error already explains what to change; the parent's "doesn't
 * match any allowed shape" is just structural scaffolding the agent
 * doesn't need to read twice.
 *
 * Keep the parent when it's the ONLY signal at its sub-tree (e.g. value
 * at P is a number where the schema wants an object — no descendant
 * errors are possible, the anyOf parent is all we have).
 */
function suppressRedundantAnyOfParents(errors: RawAjvError[]): RawAjvError[] {
  // Set of paths where there's at least one non-anyOf error.
  const concretePaths = new Set<string>();
  for (const e of errors) {
    if (e.keyword !== "anyOf" && e.keyword !== "oneOf") {
      concretePaths.add(e.instancePath || "");
    }
  }
  return errors.filter((e) => {
    if (e.keyword !== "anyOf" && e.keyword !== "oneOf") return true;
    const p = e.instancePath || "";
    // Does any concrete error live UNDER this anyOf parent's path?
    for (const cp of concretePaths) {
      if (cp === p) continue;
      if (cp.startsWith(p === "" ? "/" : p + "/")) return false;
    }
    return true;
  });
}

/**
 * When the schema declares an `anyOf` at instancePath P, a non-matching
 * value at P produces:
 *   1. An `anyOf` parent error at P  ("must match a schema in anyOf")
 *   2. Many per-branch errors ALSO at P (required/additionalProperties from
 *      each candidate shape's own constraints)
 *   3. Child errors at P/foo, P/bar (specific value mismatches inside each
 *      branch — e.g. mark="dot" vs const "barY")
 *
 * Categories 1 and 2 share a path and together produce a wall of "branch X
 * needed key Y" lines that don't help the agent — the schema has dozens of
 * branches and the agent didn't choose any of them by name. Category 3 IS
 * actionable: it pinpoints exactly what value at a specific sub-path
 * triggered the branch rejection.
 *
 * So when an anyOf/oneOf parent exists at exactly P, drop every OTHER error
 * at exactly P (the per-branch noise) and KEEP the parent (synthesized
 * into a brief "doesn't match any allowed shape" message) plus all errors
 * with deeper paths (P/foo, P/foo/bar, …).
 */
function collapseAnyOfNoise(errors: RawAjvError[]): RawAjvError[] {
  const anyOfPaths = new Set<string>();
  for (const e of errors) {
    if (e.keyword === "anyOf" || e.keyword === "oneOf") {
      anyOfPaths.add(e.instancePath || "");
    }
  }
  if (anyOfPaths.size === 0) return errors;

  // At each anyOf path, count how many branches flag each property name as
  // `additionalProperties`. A property flagged by MANY branches is one no
  // branch accepts — that's a TRUE statement about the spec, worth keeping.
  // A property flagged by FEW branches is accepted by most branches; the
  // "unknown property" message would be misleading there.
  //
  // The keep-threshold is `ceil(maxCountAtPath / 2)`: adaptive to the
  // schema's actual branch count at this path. If the max is 8 flags for
  // some property, keep any property with ≥4. If max is 2, keep ≥1.
  //
  // `required` errors at anyOf paths are *always* branch-specific (each
  // branch wants its own required keys) and never carry true information
  // about the user's spec — drop them all. Same for `type` errors at
  // anyOf paths — they're collapsed into the merged enum/type step later
  // through the `mergeAlternativeErrors` pass on errors at sub-paths.
  const apCounts = new Map<string, Map<string, number>>();  // path → propName → count
  const apReps   = new Map<string, Map<string, RawAjvError>>();
  for (const e of errors) {
    const p = e.instancePath || "";
    if (!anyOfPaths.has(p)) continue;
    if (e.keyword !== "additionalProperties") continue;
    const prop = String((e.params as any)?.additionalProperty ?? "");
    if (!prop) continue;
    const pc = apCounts.get(p) || new Map();
    pc.set(prop, (pc.get(prop) || 0) + 1);
    apCounts.set(p, pc);
    const pr = apReps.get(p) || new Map();
    if (!pr.has(prop)) pr.set(prop, e);
    apReps.set(p, pr);
  }

  // Compute the per-path threshold (half of the max-count, rounded up).
  const thresholds = new Map<string, number>();
  for (const [p, pc] of apCounts) {
    let max = 0;
    for (const c of pc.values()) if (c > max) max = c;
    thresholds.set(p, Math.max(1, Math.ceil(max / 2)));
  }

  const out: RawAjvError[] = [];
  const emitted = new Set<string>();
  for (const e of errors) {
    const p = e.instancePath || "";
    if (!anyOfPaths.has(p)) {
      out.push(e);
      continue;
    }
    if (e.keyword === "anyOf" || e.keyword === "oneOf") {
      const k = `parent|${p}`;
      if (!emitted.has(k)) { emitted.add(k); out.push(e); }
      continue;
    }
    if (e.keyword === "additionalProperties") {
      const prop = String((e.params as any)?.additionalProperty ?? "");
      const cnt = apCounts.get(p)?.get(prop) || 0;
      const thresh = thresholds.get(p) || 1;
      if (cnt < thresh) continue;
      const k = `${p}|ap|${prop}`;
      if (emitted.has(k)) continue;
      emitted.add(k);
      const rep = apReps.get(p)?.get(prop);
      if (rep) out.push(rep);
      continue;
    }
    // Drop required + type errors at anyOf paths — they're per-branch and
    // the agent can't act on them. (e.g. "branch X needs `channels`" while
    // the user wrote a different branch.) The anyOf parent message at this
    // path carries the high-level signal.
    if (e.keyword === "required" || e.keyword === "type") continue;
    // Anything else at an anyOf path — keep one copy.
    const vk = `${e.keyword}|${JSON.stringify(e.params || {})}`;
    const k = `${p}|other|${vk}`;
    if (emitted.has(k)) continue;
    emitted.add(k);
    out.push(e);
  }
  return out;
}

/**
 * When the Mosaic schema rejects a value, many branches typically fail at
 * the same instancePath with `const` — one branch per allowed literal.
 * Collapse all `const` failures sharing a path into a single synthetic
 * `enum`-style error whose `params.allowedValues` lists every literal that
 * branch was looking for. Same trick for `enum` (multiple enum constraints
 * at one path) and `type` (when several alternative types are allowed).
 *
 * This converts what would be 50 lines of "must equal X" / "must equal Y"
 * into one line: "Got Z but must be one of: X, Y, …".
 */
function mergeAlternativeErrors(errors: RawAjvError[]): RawAjvError[] {
  const byPath = new Map<string, RawAjvError[]>();
  for (const e of errors) {
    const k = e.instancePath || "";
    const list = byPath.get(k) || [];
    list.push(e);
    byPath.set(k, list);
  }
  const out: RawAjvError[] = [];
  for (const list of byPath.values()) {
    const consts = list.filter((e) => e.keyword === "const");
    const enums = list.filter((e) => e.keyword === "enum");
    const types = list.filter((e) => e.keyword === "type");
    const others = list.filter(
      (e) => e.keyword !== "const" && e.keyword !== "enum" && e.keyword !== "type",
    );
    // Collapse const + enum into a single synthetic enum entry covering
    // every literal/branch that was rejected at this path.
    if (consts.length + enums.length > 0) {
      const allowed: unknown[] = [];
      const seen = new Set<string>();
      const add = (v: unknown) => {
        const k = JSON.stringify(v);
        if (seen.has(k)) return;
        seen.add(k);
        allowed.push(v);
      };
      for (const e of consts) add(e.params?.allowedValue);
      for (const e of enums) {
        const vs = (e.params?.allowedValues as unknown[]) || [];
        for (const v of vs) add(v);
      }
      out.push({
        instancePath: consts[0]?.instancePath ?? enums[0]?.instancePath,
        schemaPath: consts[0]?.schemaPath ?? enums[0]?.schemaPath,
        keyword: "enum",
        message: "must be one of the allowed values",
        params: { allowedValues: allowed },
      });
    }
    // Collapse multiple `type` errors into one listing every accepted type.
    if (types.length > 1) {
      const accepted: string[] = [];
      const seen = new Set<string>();
      for (const e of types) {
        const t = e.params?.type;
        const vals = Array.isArray(t) ? t : t != null ? [t] : [];
        for (const v of vals) {
          const s = String(v);
          if (!seen.has(s)) { seen.add(s); accepted.push(s); }
        }
      }
      out.push({
        instancePath: types[0].instancePath,
        schemaPath: types[0].schemaPath,
        keyword: "type",
        message: `must be ${accepted.join(" or ")}`,
        params: { type: accepted },
      });
    } else if (types.length === 1) {
      out.push(types[0]);
    }
    out.push(...others);
  }
  return out;
}

/**
 * For each `anyOf`/`oneOf` parent, find the branch with the fewest
 * sub-errors and KEEP only that branch's errors (plus errors that don't
 * belong to any anyOf branch). The parent error itself ("must match a
 * schema in anyOf") is dropped — its message is useless without context.
 *
 * Why this works: Ajv's `schemaPath` for each error looks like
 *   `#/definitions/Plot/anyOf/3/properties/mark/enum`
 * which lets us group errors by their immediate `anyOf/N` ancestor. The
 * branch with the smallest error count is the one the user *almost*
 * matched — its errors point at the specific tweaks needed to validate.
 */
function pickBestBranchErrors(errors: RawAjvError[]): RawAjvError[] {
  // Group errors by their nearest `anyOf/N` (or `oneOf/N`) ancestor in the
  // schema path. An error with no such ancestor is its own group (key=null).
  interface Group {
    instancePath: string;
    /** Schema-path prefix up to and including `anyOf` (or `oneOf`). Two
     *  errors share a group iff their schemaPath has this exact prefix. */
    prefix: string;
    /** Map branch index → errors in that branch. */
    branches: Map<string, RawAjvError[]>;
    /** Errors at this anyOf path that ARE the parent ("must match a schema in anyOf"). */
    parents: RawAjvError[];
  }
  const groups = new Map<string, Group>();
  const ungrouped: RawAjvError[] = [];

  for (const err of errors) {
    const sp = err.schemaPath || "";
    // Match the LAST anyOf/N or oneOf/N segment — outer anyOf groupings
    // are subsumed by the inner ones (we want the most-specific branch).
    const match = sp.match(/^(.+\/(?:anyOf|oneOf))\/(\d+)(?:\/|$)/);
    if (!match) {
      // Errors not under any anyOf branch — and the bare anyOf parent
      // errors themselves — go through unchanged. We'll filter parents
      // out below if their group's children survive.
      if (err.keyword === "anyOf" || err.keyword === "oneOf") {
        // parent — handled per-group below
        const parentKey = `${err.instancePath || ""}|${sp}`;
        const g = groups.get(parentKey) || {
          instancePath: err.instancePath || "",
          prefix: sp,
          branches: new Map(),
          parents: [],
        };
        g.parents.push(err);
        groups.set(parentKey, g);
        continue;
      }
      ungrouped.push(err);
      continue;
    }
    const [, prefix, branchIdx] = match;
    const key = `${err.instancePath || ""}|${prefix}`;
    const g = groups.get(key) || {
      instancePath: err.instancePath || "",
      prefix,
      branches: new Map(),
      parents: [],
    };
    const list = g.branches.get(branchIdx) || [];
    list.push(err);
    g.branches.set(branchIdx, list);
    groups.set(key, g);
  }

  const out: RawAjvError[] = [...ungrouped];
  for (const g of groups.values()) {
    if (g.branches.size === 0) {
      // anyOf parent with no children we could attribute — keep the parent
      // so the agent at least sees the path.
      out.push(...g.parents);
      continue;
    }
    // Pick the user's closest miss. Score each branch by:
    //   1. PRIMARY: max instancePath depth among its errors. A branch
    //      failing only deep inside (e.g. /plot/0/mark) matched the
    //      surrounding structure — that's a near-miss the agent can fix.
    //      A branch failing at the SHALLOW level (e.g. requiring an
    //      `hconcat` key on root) means none of the user's structure
    //      matched, so its errors are misleading noise.
    //   2. TIE-BREAKER: fewer errors wins among branches with the same
    //      deepest-failure depth.
    let bestKey = "";
    let bestDepth = -1;
    let bestCount = Infinity;
    for (const [k, list] of g.branches) {
      let depth = 0;
      for (const e of list) {
        const d = (e.instancePath || "").split("/").length;
        if (d > depth) depth = d;
      }
      if (depth > bestDepth || (depth === bestDepth && list.length < bestCount)) {
        bestKey = k;
        bestDepth = depth;
        bestCount = list.length;
      }
    }
    out.push(...(g.branches.get(bestKey) || []));
  }
  return out;
}

/**
 * Synthesize a human-readable description from an Ajv error, baking the
 * actual offending value (resolved from the spec) and any allowed
 * alternatives into the message. This is what the agent reads — Ajv's
 * default `message` is too terse on its own ("must be equal to one of
 * the allowed values" without saying *which* values).
 */
function describeError(err: RawAjvError, spec: unknown): string {
  const params = err.params || {};
  const path = err.instancePath || "/";
  const value = resolveJsonPointer(spec, path);
  const valuePreview = previewValue(value);

  switch (err.keyword) {
    case "enum": {
      const allowed = (params.allowedValues as unknown[]) || [];
      const allowedStr = formatAllowed(allowed);
      return `Got ${valuePreview} but must be one of: ${allowedStr}`;
    }
    case "const": {
      return `Got ${valuePreview} but must equal ${previewValue(params.allowedValue)}`;
    }
    case "type": {
      const expected = params.type;
      return `Got ${valuePreview} but expected ${
        Array.isArray(expected) ? expected.join(" or ") : expected
      }`;
    }
    case "required": {
      const missing = params.missingProperty;
      const presentKeys = value && typeof value === "object" && !Array.isArray(value)
        ? Object.keys(value as object)
        : [];
      const haveStr = presentKeys.length > 0 ? ` (present keys: ${presentKeys.join(", ")})` : "";
      return `Missing required property "${missing}"${haveStr}`;
    }
    case "additionalProperties": {
      const extra = params.additionalProperty;
      return `Unknown property "${extra}" — not allowed on this object${
        value && typeof value === "object" ? ". Did you mean a different attribute name?" : ""
      }`;
    }
    case "minimum":
    case "maximum":
    case "exclusiveMinimum":
    case "exclusiveMaximum": {
      const limit = params.limit;
      return `Got ${valuePreview} but ${err.message} (${err.keyword} ${limit})`;
    }
    case "minLength":
    case "maxLength": {
      return `String ${valuePreview} fails ${err.keyword}: ${err.message}`;
    }
    case "minItems":
    case "maxItems": {
      const len = Array.isArray(value) ? value.length : "?";
      return `Array has ${len} items but ${err.message}`;
    }
    case "pattern": {
      return `String ${valuePreview} does not match pattern ${params.pattern}`;
    }
    case "format": {
      return `Got ${valuePreview} but expected format ${params.format}`;
    }
    case "anyOf":
    case "oneOf": {
      // Bare parent — the schema declared a union of acceptable shapes at
      // this path and the value matched none of them. We strip Ajv's
      // "must match a schema in anyOf" suffix because it's noise; the
      // per-sub-path child errors that survived the collapse step carry
      // the actionable specifics.
      return `Got ${valuePreview} but does not match any allowed shape at this path. Look at the more specific errors at sub-paths below for what to change.`;
    }
    default:
      // Fallback: include both the raw Ajv message and the value at the
      // path so the agent gets at least one piece of useful context.
      return `${err.message || "validation failed"}${
        value !== undefined ? ` — got ${valuePreview}` : ""
      }`;
  }
}

/** Format the list of allowed enum values, truncating long lists with a tail count. */
function formatAllowed(allowed: unknown[]): string {
  if (allowed.length === 0) return "(no values allowed)";
  if (allowed.length <= 12) return allowed.map((v) => previewValue(v)).join(", ");
  const head = allowed.slice(0, 10).map((v) => previewValue(v)).join(", ");
  return `${head}, ... (${allowed.length - 10} more)`;
}

/**
 * Format a JSON value as a compact string for inclusion in an error
 * message. Strings get quoted, objects/arrays show their shape.
 */
function previewValue(value: unknown): string {
  if (value === undefined) return "<missing>";
  if (value === null) return "null";
  if (typeof value === "string") {
    return value.length > 60 ? JSON.stringify(value.slice(0, 60) + "…") : JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[${value.length} items]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as object);
    if (keys.length === 0) return "{}";
    const shown = keys.slice(0, 5).join(", ");
    return `{${shown}${keys.length > 5 ? ", …" : ""}}`;
  }
  return String(value);
}

/**
 * Resolve a JSON pointer (RFC 6901) against a value. Returns the value
 * at the pointer, or `undefined` if any segment doesn't exist.
 */
function resolveJsonPointer(value: unknown, pointer: string): unknown {
  if (!pointer || pointer === "/") return value;
  const parts = pointer.split("/").slice(1).map((p) =>
    p.replace(/~1/g, "/").replace(/~0/g, "~")
  );
  let cur: unknown = value;
  for (const part of parts) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      cur = cur[Number(part)];
    } else if (typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cur;
}

/**
 * Format validation errors as a single human-readable string suitable
 * for sending back to the agent as a tool error. Each error becomes
 * one line: `  <path>: <description>` — newline-separated.
 *
 * Example output:
 *   /plot/0/mark: Got "definitelyNotARealMark" but must be one of:
 *     "areaX", "areaY", "arrow", "axisFx", … (75 more)
 *   /data/cities: Got [3 items] but expected object — inline arrays
 *     aren't a valid data source shape
 *   /width: Got "not-a-number" but expected number
 */
export function formatValidationErrors(errors: MosaicValidationError[]): string {
  if (errors.length === 0) return "(no errors)";
  const body = errors.map((e) => `  ${e.path}: ${e.description}`).join("\n");

  // Always tell the agent that two recovery tools exist. The Mosaic schema
  // inlines its top-level alternatives rather than $ref-ing them, so most
  // errors don't carry a useful `/definitions/X` schemaPath — but the agent
  // can still browse `list_chart_schema_definitions` to find the right
  // named shape. When we DID extract specific definitionHints, lead with
  // those (they're the precise pointers); else point only at the index.
  const hints = new Set<string>();
  for (const e of errors) {
    if (e.definitionHint) hints.add(e.definitionHint);
  }
  if (hints.size > 0) {
    const list = Array.from(hints).slice(0, 6).join(", ");
    return (
      body +
      `\n\nFor the exact shape requirement, call read_chart_schema with one of: ${list}.\n` +
      `If none match what you intended, call list_chart_schema_definitions to browse all 216 named definitions.`
    );
  }
  return (
    body +
    `\n\nTo get the exact JSON-schema shape for what you're trying to write, call ` +
    `list_chart_schema_definitions (browses the 216 named definitions) then read_chart_schema(name) ` +
    `to fetch the one that matches your intent.`
  );
}
