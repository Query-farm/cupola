/**
 * What the DuckDB engine actually is, this session.
 *
 * The AI system prompt used to assert three things as literals: that spatial
 * was available (`SPATIAL_ENABLED = true`), the exact list of loaded extensions
 * ("icu, json, httpfs, iceberg, spatial, ducklake"), and the DuckDB version
 * ("1.5.1"). None of those were checked against reality. `shell-init` treats a
 * failed INSTALL/LOAD as non-fatal for every extension except vgi and simply
 * continues, so the prompt could tell the model spatial was loaded when the
 * install had failed — and the model would then write ST_* calls that error.
 *
 * This module is the single source of truth instead: the extension list lives
 * here, the shell records what actually loaded, the worker boot records the
 * real version, and the prompt builder reads the result.
 *
 * Deliberately free of imports (no bridge, no service) so it stays trivially
 * unit-testable and can't create a cycle with the modules that write to it.
 */

export interface DuckDBExtension {
  name: string;
  /** FROM clause for INSTALL — omitted for core extensions. */
  source?: string;
  /** The shell cannot function without it; failure aborts the boot flow. */
  required?: boolean;
}

/**
 * Extensions the shell installs and loads at startup, in order.
 *
 * Autoload AND autoinstall are disabled at boot (a synchronous extension fetch
 * mid-statement could deadlock the wasm worker), so this list is the only way
 * an extension becomes available — nothing else can pull one in later.
 */
export const SHELL_EXTENSIONS: readonly DuckDBExtension[] = [
  { name: "icu" },
  { name: "json" },
  { name: "httpfs" },
  { name: "vgi", source: "community", required: true },
  { name: "iceberg" },
  { name: "spatial" },
  { name: "ducklake" },
  // autocomplete provides sql_auto_complete(), used by both the shell's Tab
  // completion and the SQL editor's CodeMirror completion source.
  { name: "autocomplete" },
];

/** Runtime facts about the engine, as observed rather than assumed. */
export interface EngineInfo {
  /** DuckDB version reported by the WASM build, e.g. "1.5.1". Empty until the
   *  worker has booted. */
  duckdbVersion: string;
  /** Extensions confirmed LOADed this session, in load order. */
  loadedExtensions: string[];
}

const loaded = new Set<string>();
let duckdbVersion = "";

/** Called by shell-init after a LOAD succeeds. */
export function recordExtensionLoaded(name: string): void {
  loaded.add(name);
}

/** Called by duckdb-worker-boot once AsyncDuckDB reports its version. Strips a
 *  leading "v" so the prompt reads "DuckDB 1.5.1", not "DuckDB v1.5.1". */
export function recordDuckDBVersion(version: string): void {
  duckdbVersion = version.replace(/^v/i, "").trim();
}

/** Snapshot of what the engine actually offers right now. */
export function getEngineInfo(): EngineInfo {
  return { duckdbVersion, loadedExtensions: [...loaded] };
}

/** True if the named extension loaded successfully this session. */
export function hasExtension(name: string): boolean {
  return loaded.has(name);
}

/** Test-only: clear recorded state between cases. */
export function resetEngineInfo(): void {
  loaded.clear();
  duckdbVersion = "";
}
