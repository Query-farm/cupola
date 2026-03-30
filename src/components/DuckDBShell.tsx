/**
 * DuckDB-WASM Shell React component.
 * Loads xterm.js + addons from CDN to avoid SSR/bundling issues.
 * Shell logic adapted from public/shell/index.html.
 */
import { useEffect, useRef, useState } from "react";
import { Maximize2, Minimize2, X } from "lucide-react";
import { getAuthToken } from "@/lib/auth";
import { useSettings } from "@/lib/settings";

interface Props {
  serviceUrl: string;
  catalogName: string;
  onClose: () => void;
  maximized: boolean;
  onToggleMaximize: () => void;
  /** Called when the shell is ready, with a function to insert text into the terminal. */
  onShellReady?: (insertText: (text: string) => void) => void;
}

// CDN script URLs (matching public/shell/index.html versions)
const CDN_SCRIPTS = [
  "https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js",
  "https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js",
  "https://cdn.jsdelivr.net/npm/xterm-addon-web-links@0.9.0/lib/xterm-addon-web-links.min.js",
  "https://cdn.jsdelivr.net/npm/xterm-addon-webgl@0.16.0/lib/xterm-addon-webgl.min.js",
];
const CDN_CSS = "https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.min.css";

// Module imports loaded dynamically
const ARROW_CDN = "https://cdn.jsdelivr.net/npm/apache-arrow@18.1.0/+esm";
const READLINE_CDN = "https://cdn.jsdelivr.net/npm/xterm-readline@1.1.2/+esm";

let scriptsLoaded = false;
let scriptsLoading: Promise<void> | null = null;

/** Load CDN scripts once (idempotent). */
function loadScripts(): Promise<void> {
  if (scriptsLoaded) return Promise.resolve();
  if (scriptsLoading) return scriptsLoading;

  scriptsLoading = (async () => {
    // CSS
    if (!document.querySelector(`link[href="${CDN_CSS}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = CDN_CSS;
      document.head.appendChild(link);
    }

    // Scripts (sequential — each depends on previous)
    for (const src of CDN_SCRIPTS) {
      if (document.querySelector(`script[src="${src}"]`)) continue;
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        script.src = src;
        script.crossOrigin = "anonymous";
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Failed to load ${src}`));
        document.head.appendChild(script);
      });
    }
    scriptsLoaded = true;
  })();

  return scriptsLoading;
}

export function DuckDBShell({ serviceUrl, catalogName, onClose, maximized, onToggleMaximize, onShellReady }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { settings } = useSettings();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        await loadScripts();
        if (cancelled || !containerRef.current) return;

        // Dynamic ESM imports
        const [{ tableFromIPC }, { Readline }] = await Promise.all([
          import(/* @vite-ignore */ ARROW_CDN),
          import(/* @vite-ignore */ READLINE_CDN),
        ]);
        if (cancelled || !containerRef.current) return;

        setLoading(false);

        const { cleanup, insertText } = initShell(
          containerRef.current,
          { serviceUrl, catalogName, token: getAuthToken(), fontSize: settings.shellFontSize },
          { tableFromIPC, Readline }
        );
        cleanupRef.current = cleanup;
        onShellReady?.(insertText);
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load shell");
      }
    })();

    return () => {
      cancelled = true;
      cleanupRef.current?.();
    };
  }, [serviceUrl, catalogName]);

  // Refit terminal when maximized/minimized
  useEffect(() => {
    if ((window as any).__shellFitAddon) {
      setTimeout(() => (window as any).__shellFitAddon.fit(), 50);
    }
  }, [maximized]);

  return (
    <div className="flex flex-col h-full bg-[#1a1a0e]">
      {/* Header bar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-[#2a2a1e] bg-[#1a1a0e] shrink-0">
        <span className="text-xs font-mono text-[#6ba034]">
          DuckDB Shell — {catalogName}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={onToggleMaximize}
            className="p-1 text-[#f5f0e0]/40 hover:text-[#f5f0e0] transition-colors"
            title={maximized ? "Restore" : "Maximize"}
          >
            {maximized ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
          <button
            onClick={onClose}
            className="p-1 text-[#f5f0e0]/40 hover:text-[#f5f0e0] transition-colors"
            title="Close shell"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Terminal container */}
      {loading && !error && (
        <div className="flex-1 flex items-center justify-center text-[#6ba034] text-sm">
          Loading DuckDB-WASM...
        </div>
      )}
      {error && (
        <div className="flex-1 flex items-center justify-center text-red-400 text-sm">
          {error}
        </div>
      )}
      <div
        ref={containerRef}
        className={`flex-1 min-h-0 overflow-hidden ${loading ? "hidden" : ""}`}
        style={{ padding: "8px 12px 4px" }}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
        onDrop={(e) => {
          e.preventDefault();
          const data = e.dataTransfer.getData("text/plain");
          if (data && cleanupRef.current) {
            // Parse tree item ID → useful text
            const text = treeIdToShellText(data);
            if (text) {
              // Use the insertText from the shell
              (window as any).__shellInsertText?.(text);
            }
          }
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shell initialization (adapted from public/shell/index.html)
// ---------------------------------------------------------------------------

function initShell(
  container: HTMLElement,
  config: { serviceUrl: string; catalogName: string; token: string | null; fontSize?: number },
  modules: { tableFromIPC: any; Readline: any }
): { cleanup: () => void; insertText: (text: string) => void } {
  const { tableFromIPC, Readline } = modules;
  const T = (window as any).Terminal;
  const FA = (window as any).FitAddon;
  const WLA = (window as any).WebLinksAddon;
  const WGA = (window as any).WebglAddon;

  const term = new T({
    cursorBlink: true,
    fontSize: config.fontSize || 13,
    fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
    theme: { background: "#1a1a0e", foreground: "#f5f0e0", cursor: "#6ba034", selectionBackground: "#3a3a28" },
    allowProposedApi: true,
  });

  const fitAddon = new FA.FitAddon();
  const rl = new Readline();
  term.loadAddon(fitAddon);
  term.loadAddon(new WLA.WebLinksAddon());
  term.loadAddon(rl);
  term.open(container);
  try { term.loadAddon(new WGA.WebglAddon()); } catch { /* canvas fallback */ }

  // Store for resize handling and drag-drop
  (window as any).__shellFitAddon = fitAddon;

  const resizeObserver = new ResizeObserver(() => fitAddon.fit());
  resizeObserver.observe(container);

  // Delayed fit — container may not have final dimensions on first render
  fitAddon.fit();
  requestAnimationFrame(() => fitAddon.fit());
  setTimeout(() => fitAddon.fit(), 100);

  // Write helpers
  function writeln(msg: string, color?: string) {
    const c = color ? `\x1b[${color}m` : "";
    const r = color ? "\x1b[0m" : "";
    rl.println(c + msg + r);
  }

  // Worker
  const worker = new Worker("/shell/worker.js");

  // OAuth SAB
  const oauthSAB = typeof SharedArrayBuffer !== "undefined" ? new SharedArrayBuffer(8192) : null;
  if (oauthSAB) worker.postMessage({ type: "init-oauth-sab", sab: oauthSAB });

  // Cancel SAB
  const cancelSAB = typeof SharedArrayBuffer !== "undefined" ? new SharedArrayBuffer(4) : null;
  if (cancelSAB) worker.postMessage({ type: "init-cancel-sab", sab: cancelSAB });

  let queryRunning = false;

  worker.onmessage = (e: MessageEvent) => {
    const d = e.data;

    if (d.type === "open-auth-url") {
      if (config.token && oauthSAB) {
        // Token interception — pass cached token directly
        const int32 = new Int32Array(oauthSAB);
        const bytes = new Uint8Array(oauthSAB);
        const encoded = new TextEncoder().encode(config.token);
        new DataView(oauthSAB).setInt32(4, encoded.length, true);
        bytes.set(encoded, 8);
        Atomics.store(int32, 0, 1);
        Atomics.notify(int32, 0);
      } else {
        window.open(d.url, "_blank", "popup,width=500,height=700");
      }
      return;
    }

    if (d.type === "log") {
      const colorMap: Record<string, string> = { ok: "32", err: "31", info: "33" };
      if (d.msg) writeln(d.msg, colorMap[d.cls]);
      return;
    }

    if (d.type === "ready") {
      (async () => {
        if (config.serviceUrl && config.catalogName) {
          writeln(`Connecting to ${config.catalogName}...`, "33");
          const result = await runQueryAsync(`ATTACH '${config.catalogName}' AS ${config.catalogName} (TYPE vgi, LOCATION '${config.serviceUrl}')`);
          if (result.ok) {
            await runQueryAsync(`USE ${config.catalogName}`);
            writeln(`Connected to ${config.catalogName}`, "32");
          } else {
            writeln(`Attach failed: ${result.error}`, "31");
          }
          writeln("");
        } else {
          writeln("");
          writeln("Type SQL queries below.", "33");
          writeln("");
        }
        readLoop();
      })();
      return;
    }

    if (d.type === "progress") {
      // Could render a progress bar — skip for now
      return;
    }
  };

  // Query execution
  function runQueryAsync(sql: string): Promise<any> {
    return new Promise((resolve) => {
      const handler = (e: MessageEvent) => {
        if (e.data.type === "result") {
          worker.removeEventListener("message", handler);
          resolve(e.data);
        }
      };
      worker.addEventListener("message", handler);
      worker.postMessage({ type: "query", sql });
    });
  }

  // Read loop
  async function readLoop() {
    while (true) {
      const sql = await rl.read("\x1b[32mD\x1b[0m > ");
      const trimmed = sql.trim();
      if (!trimmed) continue;
      if (trimmed === ".exit" || trimmed === "\\q") {
        // Don't actually exit — just print hint
        writeln("Use the X button to close the shell.", "33");
        continue;
      }

      queryRunning = true;
      const result = await runQueryAsync(trimmed);
      queryRunning = false;

      if (!result.ok) {
        writeln(`Error: ${result.error || "unknown"}`, "31");
      } else if (result.arrowBuffers && result.arrowBuffers.length > 0) {
        try {
          const table = tableFromIPC(result.arrowBuffers[0]);
          printTable(table);
        } catch (err: any) {
          writeln(`Failed to render: ${err.message}`, "31");
        }
      } else {
        writeln("OK", "32");
      }
    }
  }

  // Table rendering
  function printTable(table: any) {
    const fields = table.schema.fields;
    const numRows = table.numRows;
    const numCols = fields.length;
    if (numCols === 0) { writeln("(empty)"); return; }

    const headers = fields.map((f: any) => f.name);
    const colWidths = headers.map((h: string) => h.length);
    const rows: string[][] = [];

    for (let r = 0; r < Math.min(numRows, 500); r++) {
      const row: string[] = [];
      for (let c = 0; c < numCols; c++) {
        const val = table.getChildAt(c)?.get(r);
        let str: string;
        if (val === null || val === undefined) str = "NULL";
        else if (val instanceof Uint8Array) str = "[binary]";
        else if (typeof val === "bigint") str = val.toString();
        else str = String(val);
        row.push(str);
        colWidths[c] = Math.max(colWidths[c], Math.min(str.length, 50));
      }
      rows.push(row);
    }

    const pad = (s: string, w: number) => s.length > w ? s.slice(0, w - 1) + "~" : s.padEnd(w);
    const sep = " \x1b[2m|\x1b[0m ";

    rl.println("\x1b[1m" + headers.map((h: string, i: number) => pad(h, colWidths[i])).join(sep) + "\x1b[0m");
    rl.println(colWidths.map((w: number) => "\x1b[2m" + "-".repeat(w) + "\x1b[0m").join("\x1b[2m-+-\x1b[0m"));

    for (const row of rows) {
      rl.println(row.map((v, i) => {
        const s = pad(v, colWidths[i]);
        return v === "NULL" ? "\x1b[2m" + s + "\x1b[0m" : s;
      }).join(sep));
    }

    rl.println(`\x1b[2m(${numRows} row${numRows !== 1 ? "s" : ""})\x1b[0m`);
  }

  worker.postMessage({ type: "init" });

  // Insert text into the terminal's current input line
  function insertText(text: string) {
    term.paste(text);
    term.focus();
  }

  // Expose for drag-drop from tree
  (window as any).__shellInsertText = insertText;

  return {
    cleanup: () => {
      resizeObserver.disconnect();
      worker.terminate();
      term.dispose();
      delete (window as any).__shellFitAddon;
      delete (window as any).__shellInsertText;
    },
    insertText,
  };
}

/**
 * Convert a tree item ID to text suitable for pasting into the shell.
 * IDs: "catalog::schema::t:table" → "schema.table"
 *      "catalog::schema::c:table/column" → "column"
 */
function treeIdToShellText(id: string): string | null {
  const parts = id.split("::");
  if (parts.length === 3) {
    const schema = parts[1];
    const rest = parts[2];
    if (rest.startsWith("t:")) return `${schema}.${rest.slice(2)}`;
    if (rest.startsWith("c:")) {
      const colParts = rest.slice(2).split("/");
      return colParts[1] || colParts[0];
    }
    if (rest.startsWith("v:")) return `${schema}.${rest.slice(2)}`;
    if (rest.startsWith("f:")) return rest.slice(2);
  }
  return null;
}
