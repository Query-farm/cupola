import { useEffect, useState } from "react";
import { getEngineLifecycleSnapshot, onBootChange, type EngineLifecycleSnapshot } from "./shell-bridge";

/** React view of the application-owned data-engine lifecycle. The bridge is
 * intentionally framework-free; this hook keeps UI surfaces in sync without
 * each one inventing its own readiness checks. */
export function useEngineLifecycle(): EngineLifecycleSnapshot {
  const [snapshot, setSnapshot] = useState(getEngineLifecycleSnapshot);
  useEffect(() => onBootChange(() => setSnapshot(getEngineLifecycleSnapshot())), []);
  return snapshot;
}
