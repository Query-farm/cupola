import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const credentials = {
  AWS_ACCESS_KEY_ID: "test-r2-access-key",
  AWS_SECRET_ACCESS_KEY: "test-r2-secret-key",
  CLOUDFLARE_API_TOKEN: "test-worker-token",
};

function configure(env: Record<string, string | undefined> = {}) {
  const result = Bun.spawnSync({
    cmd: [
      "bash",
      "-c",
      `set -euo pipefail
source ./scripts/publish-credentials.sh
configure_publish_credentials
printf 'profile=%s;default_profile=%s' "\${AWS_PROFILE:-unset}" "\${AWS_DEFAULT_PROFILE:-unset}"`,
    ],
    cwd: repoRoot,
    // Only synthetic credentials enter this process; don't inherit .env or CI secrets.
    env: { PATH: process.env.PATH, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("publish credential configuration", () => {
  test("CI reports every required secret instead of falling back to a local profile", () => {
    const result = configure({ CI: "true", AWS_PROFILE: "cupola" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("R2_ACCESS_KEY_ID");
    expect(result.stderr).toContain("R2_SECRET_ACCESS_KEY");
    expect(result.stderr).toContain("CLOUDFLARE_API_TOKEN");
    expect(result.stderr).toContain("GitHub production environment");
    expect(result.stdout).toBe("");
  });

  test.each(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "CLOUDFLARE_API_TOKEN"])(
    "CI rejects a missing %s without leaking the other credentials",
    (missing) => {
      const result = configure({ CI: "true", ...credentials, [missing]: "" });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(missing);
      for (const credential of Object.values(credentials)) {
        expect(result.stderr).not.toContain(credential);
      }
      expect(result.stdout).toBe("");
    },
  );

  test.each([{ CI: "true" }, { CI: "1" }, { GITHUB_ACTIONS: "true" }])(
    "CI accepts explicit credentials and clears stale profiles (%j)",
    (ci) => {
      const result = configure({
        ...ci,
        ...credentials,
        AWS_PROFILE: "nonexistent",
        AWS_DEFAULT_PROFILE: "also-nonexistent",
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("profile=unset;default_profile=unset");
      expect(result.stderr).toBe("");
    },
  );

  test("GitHub Actions requires a Worker token even when CI is unset", () => {
    const result = configure({ ...credentials, GITHUB_ACTIONS: "true", CLOUDFLARE_API_TOKEN: "" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("CLOUDFLARE_API_TOKEN");
  });

  test("local publishing keeps the default and explicitly selected AWS profiles", () => {
    expect(configure()).toEqual({ exitCode: 0, stdout: "profile=cupola;default_profile=unset", stderr: "" });
    expect(configure({ AWS_PROFILE: "custom" })).toEqual({
      exitCode: 0,
      stdout: "profile=custom;default_profile=unset",
      stderr: "",
    });
  });

  test("local explicit R2 credentials still allow interactive Wrangler authentication", () => {
    const result = configure({ ...credentials, CLOUDFLARE_API_TOKEN: "", AWS_PROFILE: "cupola" });
    expect(result).toEqual({ exitCode: 0, stdout: "profile=unset;default_profile=unset", stderr: "" });
  });

  test.each(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"])(
    "local publishing rejects an incomplete credential pair (%s)",
    (key) => {
      const result = configure({ [key]: "test-incomplete-credential" });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Set both AWS credential variables");
      expect(result.stderr).not.toContain("test-incomplete-credential");
    },
  );
});
