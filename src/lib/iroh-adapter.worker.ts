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
 * bridge's own `vgi-*` messages, which may arrive before the node exists.
 */
import { createIrohNode, type IrohNode } from "@query-farm/vgi-rpc-iroh-browser";
import { installIrohVgiAdapter } from "@query-farm/vgi-rpc-iroh-browser/adapter-worker";

let start: (secretKey: string | undefined) => void = () => {};
const node = new Promise<IrohNode>((resolve, reject) => {
  start = (secretKey) => {
    start = () => {};
    createIrohNode({ secretKey }).then(resolve, reject);
  };
});

self.addEventListener("message", (event: MessageEvent) => {
  const data = event.data as { type?: string; secretKey?: string } | undefined;
  if (data?.type === "cupola-iroh-init") start(data.secretKey);
});

node.then(
  (iroh) => self.postMessage({ type: "cupola-iroh-node", endpointId: iroh.endpointId }),
  (error) => self.postMessage({ type: "cupola-iroh-node", error: String(error) }),
);

installIrohVgiAdapter(node);
