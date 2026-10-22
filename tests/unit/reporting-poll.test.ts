import { test, expect, beforeAll, afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { nextPollDelay, pollAfter } from "../../src/lib/reporting/poll";

// happy-dom only for this file's lifetime: bun runs every test file in one global scope.
beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const setHidden = (hidden: boolean) => {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event("visibilitychange"));
};
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("a healthy poll keeps its interval; failures back off to five minutes", () => {
  expect(nextPollDelay(15_000, 0)).toBe(15_000);
  expect(nextPollDelay(15_000, 1, new Error("offline"))).toBe(30_000);
  expect(nextPollDelay(15_000, 3, new Error("offline"))).toBe(120_000);
  expect(nextPollDelay(15_000, 10, new Error("offline"))).toBe(300_000);
});

test("auth errors stop polling", () => {
  expect(nextPollDelay(5000, 1, { errorCode: "UNAUTHENTICATED" })).toBeNull();
  expect(nextPollDelay(5000, 1, { errorCode: "PERMISSION_DENIED" })).toBeNull();
  expect(nextPollDelay(5000, 1, { errorCode: "UNAVAILABLE" })).toBe(10_000);
});

test("a hidden tab defers the poll until it is shown, then runs it once", async () => {
  setHidden(true);
  let runs = 0;
  pollAfter(5, () => runs++, new AbortController().signal);
  await wait(20);
  expect(runs).toBe(0);
  setHidden(false);
  setHidden(true);
  setHidden(false);
  expect(runs).toBe(1);
});

test("aborting cancels a pending or deferred poll", async () => {
  setHidden(false);
  let runs = 0;
  const pending = new AbortController();
  pollAfter(5, () => runs++, pending.signal);
  pending.abort();
  setHidden(true);
  const deferred = new AbortController();
  pollAfter(5, () => runs++, deferred.signal);
  await wait(20);
  deferred.abort();
  setHidden(false);
  await wait(20);
  expect(runs).toBe(0);
});
