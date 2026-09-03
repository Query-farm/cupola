#!/usr/bin/env bun
/** Vendor the latest build-time VGI tag contract from vgi-lint-check. */
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const check = process.argv.includes("--check");
const target = resolve(import.meta.dir, "../src/lib/vgi-tag-contract.json");
const lockTarget = resolve(import.meta.dir, "../src/lib/vgi-tag-contract.lock.json");
const command = process.env.VGI_LINT_BIN || "vgi-lint";
const proc = Bun.spawnSync([command, "spec", "--format", "json"], { stdout: "pipe", stderr: "pipe" });
if (proc.exitCode !== 0) {
  console.error(new TextDecoder().decode(proc.stderr).trim() || `${command} spec failed`);
  process.exit(proc.exitCode || 1);
}

const parsed = JSON.parse(new TextDecoder().decode(proc.stdout));
const payload = `${JSON.stringify(parsed, null, 2)}\n`;
const lock = `${JSON.stringify({
  contract_revision: parsed.contract_revision,
  sha256: createHash("sha256").update(payload).digest("hex"),
}, null, 2)}\n`;

if (check) {
  const [current, currentLock] = await Promise.all([
    Bun.file(target).text().catch(() => ""),
    Bun.file(lockTarget).text().catch(() => ""),
  ]);
  if (current !== payload || currentLock !== lock) {
    console.error("Vendored VGI tag contract is stale; run `bun run tags:sync`.");
    process.exit(1);
  }
} else {
  await Promise.all([Bun.write(target, payload), Bun.write(lockTarget, lock)]);
  console.log(`Vendored VGI tag contract revision ${parsed.contract_revision}.`);
}
