#!/usr/bin/env bun
/** Vendor the latest build-time VGI tag contract from vgi-lint-check. */
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const check = process.argv.includes("--check");
const target = resolve(import.meta.dir, "../src/lib/vgi-tag-contract.json");
const lockTarget = resolve(import.meta.dir, "../src/lib/vgi-tag-contract.lock.json");
const command = process.env.VGI_LINT_BIN || "vgi-lint";
const repo = process.env.VGI_LINT_REPO;
const argv = repo
  ? ["uv", "run", "--directory", repo, "vgi-lint", "spec", "--format", "json"]
  : [command, "spec", "--format", "json"];
const proc = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
if (proc.exitCode !== 0) {
  console.error(new TextDecoder().decode(proc.stderr).trim() || `${command} spec failed`);
  process.exit(proc.exitCode || 1);
}

const exported = JSON.parse(new TextDecoder().decode(proc.stdout));
const { semantic_schemas: embeddedSchemas, ...contractOnly } = exported;
const parsed = exported.tag_contract ?? contractOnly;
const semanticSchemas = embeddedSchemas ?? {};
const payload = `${JSON.stringify(parsed, null, 2)}\n`;
const schemasPayload = `${JSON.stringify(semanticSchemas, null, 2)}\n`;
const schemasTarget = resolve(import.meta.dir, "../src/lib/vgi-semantic-schemas.json");
const lock = `${JSON.stringify({
  contract_revision: parsed.contract_revision,
  sha256: createHash("sha256").update(payload).digest("hex"),
  semantic_schemas_sha256: createHash("sha256").update(schemasPayload).digest("hex"),
}, null, 2)}\n`;

if (check) {
  const [current, currentSchemas, currentLock] = await Promise.all([
    Bun.file(target).text().catch(() => ""),
    Bun.file(schemasTarget).text().catch(() => ""),
    Bun.file(lockTarget).text().catch(() => ""),
  ]);
  if (current !== payload || currentSchemas !== schemasPayload || currentLock !== lock) {
    console.error("Vendored VGI tag contract is stale; run `bun run tags:sync`.");
    process.exit(1);
  }
} else {
  await Promise.all([
    Bun.write(target, payload),
    Bun.write(schemasTarget, schemasPayload),
    Bun.write(lockTarget, lock),
  ]);
  console.log(`Vendored VGI tag contract revision ${parsed.contract_revision}.`);
}
