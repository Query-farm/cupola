import { expect, test } from "bun:test";
import { createHash } from "node:crypto";

test("vendored VGI tag contract matches its lock", async () => {
  const url = new URL("../../src/lib/vgi-tag-contract.json", import.meta.url);
  const payload = await Bun.file(url).text();
  const lock = await Bun.file(new URL("../../src/lib/vgi-tag-contract.lock.json", import.meta.url)).json();
  const contract = JSON.parse(payload);
  expect(lock.contract_revision).toBe(contract.contract_revision);
  expect(lock.sha256).toBe(createHash("sha256").update(payload).digest("hex"));
});
