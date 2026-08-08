import { test, expect, describe, beforeEach } from "bun:test";
import { waitForTableReady } from "../../src/lib/table-ready";
import { engine, notifyQueryChange } from "../../src/lib/shell-bridge";

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
  engine.query = null;
  engine.catalogName = null;
  engine.resetAttached?.(); // fresh pending attached + markAttached resolver
});

describe("waitForTableReady", () => {
  test("provably non-primary table resolves on query alone (no ATTACH wait)", async () => {
    engine.query = noopQuery;
    engine.catalogName = "vgi"; // known primary catalog
    // attached intentionally left pending (markAttached not called)
    const p = waitForTableReady("memory.main.t");
    expect(await isPending(p)).toBe(false); // resolves without markAttached
  });

  test("primary-catalog table waits for ATTACH, then resolves", async () => {
    engine.query = noopQuery;
    engine.catalogName = "vgi";
    const p = waitForTableReady("vgi.main.parcels");
    expect(await isPending(p)).toBe(true); // blocked on attached
    engine.markAttached?.();
    expect(await isPending(p)).toBe(false);
  });

  test("regression: null catalogName (shell not initialized) still waits for ATTACH", async () => {
    // The bug: engine.query goes live at eager worker boot while catalogName is
    // still null. The old gate read null as "memory table, skip the wait" and
    // queried the un-attached catalog → empty preview until the shell was opened.
    engine.query = noopQuery;
    engine.catalogName = null;
    const p = waitForTableReady("vgi.main.parcels");
    expect(await isPending(p)).toBe(true); // must wait, not race ahead
    engine.markAttached?.();
    expect(await isPending(p)).toBe(false);
  });

  test("waits for engine.query to become available, then proceeds", async () => {
    engine.query = null;
    engine.catalogName = "vgi";
    engine.markAttached?.(); // ATTACH already done; only query is missing
    const p = waitForTableReady("vgi.main.parcels");
    expect(await isPending(p)).toBe(true); // blocked on query
    engine.query = noopQuery;
    notifyQueryChange();
    expect(await isPending(p)).toBe(false);
  });
});
