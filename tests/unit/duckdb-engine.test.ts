/**
 * Tests for the engine-facts registry.
 *
 * The AI system prompt tells the model which DuckDB version it's on and which
 * extensions are loaded. Those were hardcoded literals; shell-init skips any
 * non-required extension whose INSTALL or LOAD fails and keeps going, so the
 * prompt could claim spatial was available when it wasn't — and the model
 * would then emit ST_* calls that error.
 *
 * The invariant under test: an extension appears here only if it actually
 * loaded.
 */
import { test, expect, describe, beforeEach } from "bun:test";
import {
  SHELL_EXTENSIONS,
  extensionInstallSql,
  shellExtensionsForVgiVersion,
  recordExtensionLoaded,
  recordDuckDBVersion,
  getEngineInfo,
  hasExtension,
  resetEngineInfo,
} from "../../src/lib/duckdb-engine";

beforeEach(() => resetEngineInfo());

describe("SHELL_EXTENSIONS", () => {
  test("vgi is the only required extension", () => {
    const required = SHELL_EXTENSIONS.filter((e) => e.required).map((e) => e.name);
    expect(required).toEqual(["vgi"]);
  });

  test("vgi installs unpinned from the community repo", () => {
    // No VERSION clause by default: a pin froze both the extension fixes and
    // the wire protocol, so the servers Cupola could talk to froze with it.
    const vgi = SHELL_EXTENSIONS.find((e) => e.name === "vgi");
    expect(vgi).toMatchObject({ source: "community", required: true });
    expect(vgi).not.toHaveProperty("version");
    expect(extensionInstallSql(vgi!)).toBe("INSTALL vgi FROM community");
  });

  test("core extensions keep their unversioned INSTALL syntax", () => {
    expect(extensionInstallSql(SHELL_EXTENSIONS.find((e) => e.name === "icu")!)).toBe(
      "INSTALL icu"
    );
  });

  test("supports a session-specific exact pin, and leaves the default unpinned", () => {
    const vgiOf = (list: readonly { name: string }[]) =>
      list.find((extension) => extension.name === "vgi")! as Parameters<typeof extensionInstallSql>[0];
    expect(extensionInstallSql(vgiOf(shellExtensionsForVgiVersion("v1.2.3")))).toBe(
      "INSTALL vgi FROM community VERSION 'v1.2.3'"
    );
    // Both spellings of "latest" — explicit and absent — omit the clause.
    expect(extensionInstallSql(vgiOf(shellExtensionsForVgiVersion(null)))).toBe(
      "INSTALL vgi FROM community"
    );
    expect(extensionInstallSql(vgiOf(shellExtensionsForVgiVersion(undefined)))).toBe(
      "INSTALL vgi FROM community"
    );
    // An exact pin must not leak into the shared default list.
    expect(SHELL_EXTENSIONS.find((extension) => extension.name === "vgi")?.version).toBeUndefined();
  });

  test("includes the extensions other subsystems depend on", () => {
    const names = SHELL_EXTENSIONS.map((e) => e.name);
    // spatial gates the prompt's geometry guidance; autocomplete backs both
    // the shell's Tab completion and the editor's CodeMirror source.
    expect(names).toContain("spatial");
    expect(names).toContain("autocomplete");
    expect(names).toContain("icu");
  });

  test("names are unique", () => {
    const names = SHELL_EXTENSIONS.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("engine facts", () => {
  test("reports nothing before the shell has booted", () => {
    expect(getEngineInfo()).toEqual({ duckdbVersion: "", loadedExtensions: [] });
    expect(hasExtension("spatial")).toBe(false);
  });

  test("records only the extensions that actually loaded", () => {
    recordExtensionLoaded("icu");
    recordExtensionLoaded("vgi");
    // spatial deliberately NOT recorded — simulating a failed install.
    const info = getEngineInfo();
    expect(info.loadedExtensions).toEqual(["icu", "vgi"]);
    expect(hasExtension("spatial")).toBe(false);
  });

  test("is idempotent — a re-recorded extension appears once", () => {
    recordExtensionLoaded("json");
    recordExtensionLoaded("json");
    expect(getEngineInfo().loadedExtensions).toEqual(["json"]);
  });

  test("strips a leading v from the reported version", () => {
    // AsyncDuckDB reports e.g. "v1.5.1"; the prompt should read "DuckDB 1.5.1".
    recordDuckDBVersion("v1.5.1");
    expect(getEngineInfo().duckdbVersion).toBe("1.5.1");
  });

  test("leaves an already-bare version alone and trims whitespace", () => {
    recordDuckDBVersion("  1.5.1  ");
    expect(getEngineInfo().duckdbVersion).toBe("1.5.1");
  });

  test("getEngineInfo returns a snapshot, not a live view", () => {
    recordExtensionLoaded("icu");
    const snapshot = getEngineInfo();
    recordExtensionLoaded("spatial");
    // The earlier snapshot must not gain the later extension.
    expect(snapshot.loadedExtensions).toEqual(["icu"]);
    expect(getEngineInfo().loadedExtensions).toEqual(["icu", "spatial"]);
  });
});
