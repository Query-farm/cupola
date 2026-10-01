/**
 * Browser Iroh support for extensions that dial `iroh://` endpoints from the
 * DuckDB worker — today the grainlift extension (`ATTACH
 * 'grainlift+iroh://<endpoint-id>' AS db (TYPE grainlift, target '…')`).
 *
 * The page owns one Iroh node in an adapter Worker; Haybarn's
 * `installVgiWebWorkerBridge` connects it to the DuckDB worker through
 * SharedArrayBuffer rings. That needs cross-origin isolation, which Cupola
 * always serves (COOP/COEP), so on a non-isolated page this is a no-op and
 * `iroh://` connections fail with the extension's own "needs COI" error.
 *
 * The node's secret key is kept in localStorage so the browser has a stable
 * Iroh identity a gateway can authorize (grainlift-server `iroh.principals`).
 * Without storage (private window, blocked site data) the identity is
 * ephemeral for the tab.
 */
import { installVgiWebWorkerBridge } from "@haybarn/haybarn-wasm/vgi";

export const IROH_SECRET_KEY_STORAGE = "cupola-iroh-secret-key";

/** A 32-byte Ed25519 secret key as 64 lowercase hex characters. */
export function generateIrohSecretKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The persisted key, created on first use. `undefined` when storage is
 *  unavailable: the node then gets an ephemeral identity. */
export function getOrCreateIrohSecretKey(storage: Pick<Storage, "getItem" | "setItem"> | undefined = safeLocalStorage()): string | undefined {
  if (!storage) return undefined;
  try {
    const existing = storage.getItem(IROH_SECRET_KEY_STORAGE);
    if (existing && /^[0-9a-f]{64}$/.test(existing)) return existing;
    const key = generateIrohSecretKey();
    storage.setItem(IROH_SECRET_KEY_STORAGE, key);
    return key;
  } catch {
    return undefined;
  }
}

function safeLocalStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export interface IrohState {
  status: "unavailable" | "starting" | "ready" | "error";
  /** This browser's Iroh endpoint ID, once the node is up. */
  endpointId?: string;
  error?: string;
}

let state: IrohState = { status: "unavailable" };
const listeners = new Set<() => void>();

function publish(next: IrohState) {
  state = next;
  listeners.forEach((listener) => listener());
}

export function getIrohState(): IrohState {
  return state;
}

export function subscribeIroh(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Start the adapter Worker and bridge it to the DuckDB worker. Call before
 * the AsyncDuckDB instance is created. Never throws: a failure only disables
 * `iroh://` and is reported through `getIrohState()`.
 */
export function startIrohAdapter(duckdbWorker: Worker): void {
  if (typeof self === "undefined" || !self.crossOriginIsolated) return;
  try {
    const adapter = new Worker(new URL("./iroh-adapter.worker.ts", import.meta.url), { type: "module" });
    adapter.addEventListener("message", (event: MessageEvent) => {
      const data = event.data as { type?: string; endpointId?: string; error?: string } | undefined;
      if (data?.type !== "cupola-iroh-node") return;
      if (data.error) {
        console.warn("[iroh] node failed:", data.error);
        publish({ status: "error", error: data.error });
      } else {
        publish({ status: "ready", endpointId: data.endpointId });
      }
    });
    adapter.postMessage({ type: "cupola-iroh-init", secretKey: getOrCreateIrohSecretKey() });
    installVgiWebWorkerBridge({ irohAdapterWorker: adapter })(duckdbWorker);
    publish({ status: "starting" });
  } catch (error) {
    console.warn("[iroh] adapter unavailable:", error);
    publish({ status: "error", error: error instanceof Error ? error.message : String(error) });
  }
}
