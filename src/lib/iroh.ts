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
 *
 * The node itself starts only when SQL first dials an Iroh target (see
 * ./iroh-adapter.worker). Until then the endpoint ID shown in Settings is
 * derived from the key here: an Iroh endpoint ID is the hex Ed25519 public key.
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

/** The hex Ed25519 public key of a hex secret key, which is the Iroh endpoint
 *  ID the node will have. Rejects where WebCrypto has no Ed25519. */
export async function irohEndpointIdFromSecretKey(secretKey: string): Promise<string> {
  // PKCS#8 wrapping of a raw Ed25519 seed (RFC 8410).
  const prefix = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];
  const seed = secretKey.match(/../g)!.map((h) => parseInt(h, 16));
  const key = await crypto.subtle.importKey("pkcs8", new Uint8Array([...prefix, ...seed]), { name: "Ed25519" }, true, ["sign"]);
  const { x } = await crypto.subtle.exportKey("jwk", key);
  const bytes = Uint8Array.from(atob(x!.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface IrohState {
  /** `idle`: the adapter is installed and the node will start on the first
   *  Iroh connection. */
  status: "unavailable" | "idle" | "starting" | "ready" | "error";
  /** This browser's Iroh endpoint ID: derived from the key while idle, the
   *  node's own once it is up. */
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
 * the AsyncDuckDB instance is created. The Iroh node inside it starts on the
 * first Iroh connection, not here. Never throws: a failure only disables
 * `iroh://` and is reported through `getIrohState()`.
 */
export function startIrohAdapter(duckdbWorker: Worker): void {
  if (typeof self === "undefined" || !self.crossOriginIsolated) return;
  try {
    const adapter = new Worker(new URL("./iroh-adapter.worker.ts", import.meta.url), { type: "module" });
    adapter.addEventListener("message", (event: MessageEvent) => {
      const data = event.data as { type?: string; endpointId?: string; error?: string } | undefined;
      if (data?.type === "cupola-iroh-starting") {
        publish({ ...state, status: "starting" });
      } else if (data?.type === "cupola-iroh-node") {
        if (data.error) {
          console.warn("[iroh] node failed:", data.error);
          publish({ status: "error", error: data.error });
        } else {
          publish({ status: "ready", endpointId: data.endpointId });
        }
      }
    });
    // Ephemeral when storage is unavailable, but generated here either way so
    // the ID can be shown before the node starts.
    const secretKey = getOrCreateIrohSecretKey() ?? generateIrohSecretKey();
    adapter.postMessage({ type: "cupola-iroh-init", secretKey });
    installVgiWebWorkerBridge({ irohAdapterWorker: adapter })(duckdbWorker);
    publish({ status: "idle" });
    irohEndpointIdFromSecretKey(secretKey).then(
      (endpointId) => {
        if (!state.endpointId && (state.status === "idle" || state.status === "starting")) publish({ ...state, endpointId });
      },
      (error) => console.warn("[iroh] could not derive the endpoint ID:", error),
    );
  } catch (error) {
    console.warn("[iroh] adapter unavailable:", error);
    publish({ status: "error", error: error instanceof Error ? error.message : String(error) });
  }
}
