import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import { EngineStatusRibbon } from "../../src/components/EngineStatusRibbon";
import { getEngineLifecycleSnapshot, setBootPhase, setEngineLifecycleError, waitForEngineReady } from "../../src/lib/shell-bridge";

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  setBootPhase(null);
});
afterAll(() => GlobalRegistrator.unregister());

describe("shared data-engine lifecycle", () => {
  test("does not become ready until the complete attach flow finishes", async () => {
    setBootPhase("Downloading Haybarn", 42);
    expect(getEngineLifecycleSnapshot()).toMatchObject({ status: "starting", phase: "Downloading Haybarn", progress: 42 });

    let resolved = false;
    const ready = waitForEngineReady().then(() => { resolved = true; });
    setBootPhase("Connecting to weather", null, "attaching");
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(getEngineLifecycleSnapshot().status).toBe("attaching");

    setBootPhase(null);
    await ready;
    expect(resolved).toBe(true);
    expect(getEngineLifecycleSnapshot().status).toBe("ready");
  });

  test("rejects queued work immediately when startup fails", async () => {
    setBootPhase("Loading vgi extension", null, "attaching");
    const ready = waitForEngineReady();
    setEngineLifecycleError("INSTALL vgi failed");
    expect(await ready.then(() => "resolved", (error) => error.message)).toBe("INSTALL vgi failed");
  });

  test("renders progress globally, then exposes a recoverable failure", async () => {
    setBootPhase("Downloading Haybarn", 37);
    const view = render(<EngineStatusRibbon />);
    expect(view.getByTestId("engine-status-ribbon").getAttribute("data-engine-status")).toBe("starting");
    expect(view.getByText("37%")).toBeTruthy();

    await act(async () => setBootPhase("Connecting to weather", null, "attaching"));
    expect(view.getByTestId("engine-status-ribbon").getAttribute("data-engine-status")).toBe("attaching");
    expect(view.getByText("Connecting to weather")).toBeTruthy();

    await act(async () => setEngineLifecycleError("Catalog attach failed"));
    expect(view.getByText("Data engine failed to start")).toBeTruthy();
    expect(view.getByText("Catalog attach failed")).toBeTruthy();
    expect(view.getByRole("button", { name: "Retry" })).toBeTruthy();

    await act(async () => setBootPhase(null));
    expect(view.queryByTestId("engine-status-ribbon")).toBeNull();
  });
});
