/// <reference lib="webworker" />
/**
 * Application-owned Iroh adapter Worker (Haybarn's `irohAdapterWorker`).
 *
 * One browser Iroh node per tab. Extensions running in the DuckDB worker
 * (grainlift's `grainlift+iroh://` connections) reach remote endpoints through
 * SharedArrayBuffer rings that Haybarn's bridge hands to this Worker.
 *
 * The page sends `{type: "cupola-iroh-init", secretKey}` first; the adapter
 * ignores message types it does not know, so that cannot collide with the
 * bridge's own `vgi-*` messages.
 *
 * The node starts on the bridge's first `vgi-init` / `vgi-register-target`,
 * which Haybarn sends only when SQL dials an `iroh://` or `httpi://` target.
 * Starting it with the Worker cost every page load the 5MB wasm and a relay
 * connection that most sessions never use. This listener is added before
 * `installIrohVgiAdapter`'s, so the node exists by the time the adapter waits
 * on it, and the page's init message is posted before the bridge is
 * installed, so the key is always here first.
 */
import { createIrohNode, type IrohNode } from "@query-farm/vgi-rpc-iroh-browser";
import { installIrohVgiAdapter } from "@query-farm/vgi-rpc-iroh-browser/adapter-worker";

let secretKey: string | undefined;
let start: () => void = () => {};
const node = new Promise<IrohNode>((resolve, reject) => {
  start = () => {
    start = () => {};
    self.postMessage({ type: "cupola-iroh-starting" });
    createIrohNode({ secretKey }).then(resolve, reject);
  };
});

self.addEventListener("message", (event: MessageEvent) => {
  const data = event.data as { type?: string; secretKey?: string } | undefined;
  if (data?.type === "cupola-iroh-init") secretKey = data.secretKey;
  else if (data?.type === "vgi-init" || data?.type === "vgi-register-target") start();
});

node.then(
  (iroh) => self.postMessage({ type: "cupola-iroh-node", endpointId: iroh.endpointId }),
  (error) => self.postMessage({ type: "cupola-iroh-node", error: String(error) }),
);

installIrohVgiAdapter(node);
