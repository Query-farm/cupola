import { test, expect, describe, beforeEach } from "bun:test";
import { waitForTableReady } from "../../src/lib/table-ready";
import { bridge, notifyQueryChange } from "../../src/lib/shell-bridge";

// Resolves true if `p` is still pending after `ms`, false if it settled first.
// Uses a real timer so microtask-ordering can't make a pending promise look
// settled (or vice-versa).
function isPending(p: Promise<unknown>, ms = 40): Promise<boolean> {
  const sentinel = Symbol("pending");
  return Promise.race([
    p.then(() => false),
    new Promise<typeof sentinel>((res) => setTimeout(() => res(sentinel), ms)),
  ]).then((r) => r === sentinel);
}

const noopQuery = async () => ({ ok: true });

beforeEach(() => {
  bridge.query = null;
  bridge.catalogName = null;
  bridge.resetAttached?.(); // fresh pending attached + markAttached resolver
});

describe("waitForTableReady", () => {
  test("provably non-primary table resolves on query alone (no ATTACH wait)", async () => {
    bridge.query = noopQuery;
    bridge.catalogName = "vgi"; // known primary catalog
    // attached intentionally left pending (markAttached not called)
    const p = waitForTableReady("memory.main.t");
    expect(await isPending(p)).toBe(false); // resolves without markAttached
  });

  test("primary-catalog table waits for ATTACH, then resolves", async () => {
    bridge.query = noopQuery;
    bridge.catalogName = "vgi";
    const p = waitForTableReady("vgi.main.parcels");
    expect(await isPending(p)).toBe(true); // blocked on attached
    bridge.markAttached?.();
    expect(await isPending(p)).toBe(false);
  });

  test("regression: null catalogName (shell not initialized) still waits for ATTACH", async () => {
    // The bug: bridge.query goes live at eager worker boot while catalogName is
    // still null. The old gate read null as "memory table, skip the wait" and
    // queried the un-attached catalog → empty preview until the shell was opened.
    bridge.query = noopQuery;
    bridge.catalogName = null;
    const p = waitForTableReady("vgi.main.parcels");
    expect(await isPending(p)).toBe(true); // must wait, not race ahead
    bridge.markAttached?.();
    expect(await isPending(p)).toBe(false);
  });

  test("waits for bridge.query to become available, then proceeds", async () => {
    bridge.query = null;
    bridge.catalogName = "vgi";
    bridge.markAttached?.(); // ATTACH already done; only query is missing
    const p = waitForTableReady("vgi.main.parcels");
    expect(await isPending(p)).toBe(true); // blocked on query
    bridge.query = noopQuery;
    notifyQueryChange();
    expect(await isPending(p)).toBe(false);
  });
});
