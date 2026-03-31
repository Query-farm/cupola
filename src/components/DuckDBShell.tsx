/**
 * DuckDB-WASM Shell React component.
 * Loads xterm.js + addons from CDN to avoid SSR/bundling issues.
 * Shell logic adapted from public/shell/index.html.
 */
import { useEffect, useRef, useState, lazy, Suspense } from "react";
import { Maximize2, Minimize2, X } from "lucide-react";
import { getAuthToken } from "@/lib/auth";
import { useSettings } from "@/lib/settings";
import {
  runAgentTurn,
  buildSystemPrompt,
  executeListTables,
  executeDescribeTable,
  executeReadQueryResults,
  formatArrowTableAsJson,
  type MessageParam,
} from "@/lib/ai-agent";
import { createMarkdownRenderer } from "@/lib/markdown-ansi";

const KeplerMap = lazy(() => import("./KeplerMap").then((m) => ({ default: m.KeplerMap })));

import type { CatalogData } from "@/lib/service";

interface Props {
  serviceUrl: string;
  catalogName: string;
  onClose: () => void;
  maximized: boolean;
  onToggleMaximize: () => void;
  /** Called when the shell is ready, with a function to insert text into the terminal. */
  onShellReady?: (insertText: (text: string) => void) => void;
  /** Hide Perspective/Map tabs, show only the shell. Default false. */
  shellOnly?: boolean;
  /** Catalog metadata for AI agent tools. */
  catalogData?: CatalogData;
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

export function DuckDBShell({ serviceUrl, catalogName, onClose, maximized, onToggleMaximize, onShellReady, shellOnly, catalogData }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const perspectiveRef = useRef<HTMLDivElement>(null);
  const { settings } = useSettings();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const [activeTab, setActiveTab] = useState<"shell" | "perspective" | "map">("shell");
  const [perspectiveLoading, setPerspectiveLoading] = useState(false);

  // Expose a callback for the shell to trigger Perspective view
  useEffect(() => {
    (window as any).__showPerspective = async (arrowBuffer: Uint8Array) => {
      setActiveTab("perspective");
      setPerspectiveLoading(true);
      try {
        await loadPerspective(perspectiveRef.current!, arrowBuffer);
      } catch (e: any) {
        console.error("Perspective load error:", e);
      } finally {
        setPerspectiveLoading(false);
      }
    };
    (window as any).__showKepler = () => {
      setActiveTab("map");
    };
    return () => {
      delete (window as any).__showPerspective;
      delete (window as any).__showKepler;
    };
  }, []);

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
          { serviceUrl, catalogName, token: getAuthToken(), fontSize: settings.shellFontSize, catalogData, aiApiKey: settings.anthropicApiKey, aiModel: settings.aiModel },
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

  // Refit terminal when maximized/minimized or switching back to shell tab
  useEffect(() => {
    if (activeTab === "shell" && (window as any).__shellFitAddon) {
      setTimeout(() => (window as any).__shellFitAddon.fit(), 50);
    }
  }, [maximized, activeTab]);

  const tabCls = (tab: string) => {
    const active = activeTab === tab;
    return `px-4 py-1.5 text-sm font-semibold font-mono cursor-pointer transition-colors rounded-t-md ${
      active
        ? "bg-[#1a1a0e] text-[#6ba034] border border-[#3a3a28] border-b-0 relative z-10"
        : "bg-[#24241a] text-[#f5f0e0]/40 hover:text-[#f5f0e0]/70 border border-transparent hover:bg-[#2a2a1e]"
    }`;
  };

  return (
    <div className="flex flex-col h-full bg-[#1a1a0e]">
      {/* Tab bar */}
      <div className="flex items-center justify-between px-2 pt-1 bg-[#2a2a1e] shrink-0 border-b border-[#3a3a28]">
        <div className="flex items-end gap-0.5 -mb-px">
          <button className={tabCls("shell")} onClick={() => setActiveTab("shell")}>
            SQL Shell
          </button>
          {!shellOnly && (
            <>
              <button className={tabCls("perspective")} onClick={() => setActiveTab("perspective")}>
                Perspective
              </button>
              <button className={tabCls("map")} onClick={() => setActiveTab("map")}>
                Map
              </button>
            </>
          )}
        </div>
        <div className="flex items-center gap-1 pb-1">
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
      {loading && !error && activeTab === "shell" && (
        <div className="flex-1 flex items-center justify-center text-[#6ba034] text-sm">
          Loading DuckDB-WASM...
        </div>
      )}
      {error && activeTab === "shell" && (
        <div className="flex-1 flex items-center justify-center text-red-400 text-sm">
          {error}
        </div>
      )}
      <div
        ref={containerRef}
        className={`flex-1 min-h-0 overflow-hidden ${loading || activeTab !== "shell" ? "hidden" : ""}`}
        style={{ padding: "8px 12px 28px" }}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
        onDrop={(e) => {
          e.preventDefault();
          const data = e.dataTransfer.getData("text/plain");
          if (data) {
            const text = treeIdToShellText(data);
            if (text) {
              (window as any).__shellInsertText?.(text);
            }
          }
        }}
      />

      {/* Perspective viewer */}
      <div
        ref={perspectiveRef}
        className={`flex-1 min-h-0 overflow-hidden ${activeTab !== "perspective" ? "hidden" : ""}`}
      >
        {perspectiveLoading && (
          <div className="flex items-center justify-center h-full text-[#6ba034] text-sm">
            Loading Perspective...
          </div>
        )}
        {!perspectiveLoading && activeTab === "perspective" && !perspectiveRef.current?.querySelector("perspective-viewer") && (
          <div className="flex items-center justify-center h-full text-[#f5f0e0]/40 text-sm font-mono">
            Run a query then type .perspective to view results here
          </div>
        )}
      </div>

      {/* Kepler.gl map */}
      {activeTab === "map" && (
        <div className="flex-1 min-h-0 overflow-hidden">
          <Suspense fallback={
            <div className="flex items-center justify-center h-full text-gray-500 text-sm bg-white">
              Loading Kepler.gl...
            </div>
          }>
            <KeplerMap />
          </Suspense>
        </div>
      )}

    </div>
  );
}

// ---------------------------------------------------------------------------
// Shell initialization (adapted from public/shell/index.html)
// ---------------------------------------------------------------------------

function initShell(
  container: HTMLElement,
  config: { serviceUrl: string; catalogName: string; token: string | null; fontSize?: number; catalogData?: CatalogData; aiApiKey?: string; aiModel?: string },
  modules: { tableFromIPC: any; Readline: any }
): { cleanup: () => void; insertText: (text: string) => void } {
  const { tableFromIPC, Readline } = modules;
  const T = (window as any).Terminal;
  const FA = (window as any).FitAddon;
  const WLA = (window as any).WebLinksAddon;
  const WGA = (window as any).WebglAddon;

  // Singleton terminal — reuse across shell instances
  const isNewTerminal = !(window as any).__shellTerm;
  let term: any, fitAddon: any, rl: any;

  if (isNewTerminal) {
    term = new T({
      cursorBlink: true,
      fontSize: config.fontSize || 13,
      fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
      theme: { background: "#1a1a0e", foreground: "#f5f0e0", cursor: "#6ba034", selectionBackground: "#3a3a28" },
      allowProposedApi: true,
    });
    fitAddon = new FA.FitAddon();
    rl = new Readline();
    term.loadAddon(fitAddon);
    term.loadAddon(new WLA.WebLinksAddon());
    term.loadAddon(rl);
    term.open(container);
    try { term.loadAddon(new WGA.WebglAddon()); } catch { /* canvas fallback */ }

    // Ctrl+K clears the terminal
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.key === "k" && (e.ctrlKey || e.metaKey) && e.type === "keydown") {
        term.clear();
        return false;
      }
      return true;
    });

    (window as any).__shellTerm = term;
    (window as any).__shellFitAddon = fitAddon;
    (window as any).__shellReadline = rl;
  } else {
    term = (window as any).__shellTerm;
    fitAddon = (window as any).__shellFitAddon;
    rl = (window as any).__shellReadline;
    // Reparent the terminal DOM element to the new container
    const termEl = term.element?.parentElement;
    if (termEl && termEl !== container) {
      container.appendChild(termEl);
    }
  }

  const safeFit = () => { try { fitAddon?.fit(); } catch {} };
  const resizeObserver = new ResizeObserver(safeFit);
  resizeObserver.observe(container);

  // Fit after reparenting
  safeFit();
  requestAnimationFrame(safeFit);
  setTimeout(safeFit, 100);

  // Write helpers
  function writeln(msg: string, color?: string) {
    const c = color ? `\x1b[${color}m` : "";
    const r = color ? "\x1b[0m" : "";
    rl.println(c + msg + r);
  }

  // Progress bar
  let progressLine = false;
  function renderProgressBar(pct: number) {
    const label = ` ${String(Math.round(pct)).padStart(3)}%`;
    const barWidth = Math.max(10, term.cols - label.length - 2);
    const filled = Math.round((pct / 100) * barWidth);
    const bar = " \x1b[32m" + "█".repeat(filled) + "\x1b[2m" + "░".repeat(barWidth - filled) + "\x1b[0m";
    term.write(`\r${bar}${label}\x1b[K`);
    progressLine = true;
  }
  function clearProgressBar() {
    if (progressLine) {
      term.write("\r\x1b[K");
      progressLine = false;
    }
  }

  // Singleton worker — shared across all DuckDBShell instances
  const isNewWorker = !(window as any).__duckdbWorker;
  const worker = (window as any).__duckdbWorker || new Worker("/shell/worker.js");
  (window as any).__duckdbWorker = worker;

  // Only set up SABs and init for new workers
  if (isNewWorker) {
    const oauthSAB = typeof SharedArrayBuffer !== "undefined" ? new SharedArrayBuffer(8192) : null;
    if (oauthSAB) worker.postMessage({ type: "init-oauth-sab", sab: oauthSAB });

    const cancelSAB = typeof SharedArrayBuffer !== "undefined" ? new SharedArrayBuffer(4) : null;
    if (cancelSAB) worker.postMessage({ type: "init-cancel-sab", sab: cancelSAB });
  }

  let queryRunning = false;
  let outputMode: "box" | "line" = "box";
  let lastTable: any = null;
  let lastArrowBuffer: Uint8Array | null = null;

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
        // Shell is fully ready — expose runQuery for external callers
        (window as any).__shellRunQuery = runQuery;
        readLoop();
      })();
      return;
    }

    if (d.type === "progress") {
      if (queryRunning) renderProgressBar(d.percentage);
      // Also notify external listeners (e.g., KeplerMap loading overlay)
      const progressCb = (window as any).__duckdbProgress;
      if (progressCb) progressCb(d.percentage);
      return;
    }
  };

  // Query execution
  let nextQueryId = 1;
  function runQueryAsync(sql: string): Promise<any> {
    const queryId = nextQueryId++;
    return new Promise((resolve) => {
      const handler = (e: MessageEvent) => {
        if (e.data.type === "result" && e.data.queryId === queryId) {
          worker.removeEventListener("message", handler);
          resolve(e.data);
        }
      };
      worker.addEventListener("message", handler);
      worker.postMessage({ type: "query", sql, queryId });
    });
  }

  // Read loop
  let prefillText = "";
  let prefillCursorPos = -1;
  async function readLoop() {
    while (true) {
      const readPromise = rl.read("\x1b[32mD\x1b[0m > ");
      if (prefillText) {
        const text = prefillText;
        const cursorPos = prefillCursorPos;
        prefillText = "";
        prefillCursorPos = -1;
        setTimeout(() => {
          term.paste(text);
          // Move cursor to error position if specified
          if (cursorPos >= 0 && cursorPos < text.length) {
            const movesLeft = text.length - cursorPos;
            for (let i = 0; i < movesLeft; i++) {
              term.paste("\x1b[D"); // left arrow
            }
          }
        }, 10);
      }
      const sql = await readPromise;
      const trimmed = sql.trim();
      if (!trimmed) {
        // Remove blank entry that readline already pushed to history
        if (rl.history?.length) rl.history.pop();
        continue;
      }
      if (trimmed === ".exit" || trimmed === "\\q") {
        writeln("Use the X button to close the shell.", "33");
        continue;
      }
      if (trimmed === ".help" || trimmed === "\\?") {
        writeln(".help              Show this help");
        writeln(".ai                Enter AI assistant mode");
        writeln(".mode box          Table output with box drawing (default)");
        writeln(".mode line         One field per line, vertical display");
        writeln(".download csv      Download last result as CSV");
        writeln(".download excel    Download last result as Excel");
        writeln(".perspective       Open last result in Perspective viewer");
        writeln(".kepler            Switch to Map tab");
        continue;
      }
      if (trimmed.startsWith(".mode")) {
        const arg = trimmed.split(/\s+/)[1]?.toLowerCase();
        if (arg === "box" || arg === "line") {
          outputMode = arg;
          writeln(`Output mode: ${arg}`, "33");
        } else {
          writeln("Usage: .mode [box|line]", "33");
        }
        continue;
      }
      if (trimmed.startsWith(".download")) {
        const fmt = trimmed.split(/\s+/)[1]?.toLowerCase();
        if (!lastTable) {
          writeln("No result to download. Run a query first.", "31");
        } else if (fmt === "csv") {
          downloadFile(lastTable, "csv");
        } else if (fmt === "excel" || fmt === "xlsx") {
          downloadFile(lastTable, "excel");
        } else {
          writeln("Usage: .download [csv|excel]", "33");
        }
        continue;
      }
      if (trimmed === ".perspective") {
        if (!lastArrowBuffer) {
          writeln("No result to view. Run a query first.", "31");
        } else {
          (window as any).__showPerspective?.(lastArrowBuffer);
          writeln("Switched to Perspective viewer", "32");
        }
        continue;
      }
      if (trimmed === ".kepler") {
        (window as any).__showKepler?.();
        writeln("Switched to Map tab", "32");
        continue;
      }

      // -----------------------------------------------------------------------
      // AI mode
      // -----------------------------------------------------------------------
      if (trimmed === ".ai") {
        // Read API key fresh from localStorage (user may have set it after shell opened)
        let aiApiKey = config.aiApiKey || "";
        let aiModel = config.aiModel || "claude-sonnet-4-20250514";
        let aiMaxToolRounds = 20;
        try {
          const stored = localStorage.getItem("vgi-frontend-settings");
          if (stored) {
            const s = JSON.parse(stored);
            if (s.anthropicApiKey) aiApiKey = s.anthropicApiKey;
            if (s.aiModel) aiModel = s.aiModel;
            if (s.aiMaxToolRounds) aiMaxToolRounds = s.aiMaxToolRounds;
          }
        } catch {}

        if (!aiApiKey) {
          writeln("No API key configured. Set your Anthropic API key in Settings.", "31");
          continue;
        }
        if (!config.catalogData) {
          writeln("Catalog data not available. Try again after the catalog loads.", "31");
          continue;
        }

        writeln("Entering AI mode. Type .exit to return to SQL.", "35");
        writeln("");

        const aiMessages: MessageParam[] = [];
        const systemPrompt = buildSystemPrompt(config.catalogData, config.serviceUrl);
        let aiAbort: AbortController | null = null;

        // Braille spinner
        const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
        let spinnerInterval: ReturnType<typeof setInterval> | null = null;
        let spinnerFrame = 0;

        function startSpinner(label: string) {
          spinnerFrame = 0;
          spinnerInterval = setInterval(() => {
            const frame = spinnerFrames[spinnerFrame % spinnerFrames.length];
            term.write(`\r\x1b[2m${frame} ${label}\x1b[0m\x1b[K`);
            spinnerFrame++;
          }, 100);
        }

        function stopSpinner() {
          if (spinnerInterval) {
            clearInterval(spinnerInterval);
            spinnerInterval = null;
            term.write("\r\x1b[K"); // Clear the spinner line
          }
        }

        // Ctrl+D exits AI mode
        let ctrlDExit = false;
        const ctrlDDisposable = term.onData((data: string) => {
          if (data === "\x04") { // Ctrl+D
            ctrlDExit = true;
            // Submit empty line to unblock rl.read()
            term.paste("\r");
          }
        });

        // AI read loop
        aiLoop: while (true) {
          const userInput = await rl.read("\x1b[35mAI\x1b[0m > ");

          if (ctrlDExit) {
            ctrlDExit = false;
            ctrlDDisposable.dispose();
            writeln("Exiting AI mode.", "35");
            writeln("");
            break;
          }

          const aiTrimmed = userInput.trim();

          if (!aiTrimmed) {
            if (rl.history?.length) rl.history.pop();
            continue;
          }

          if (aiTrimmed === ".exit" || aiTrimmed === "/exit") {
            ctrlDDisposable.dispose();
            writeln("Exiting AI mode.", "35");
            writeln("");
            break;
          }

          if (aiTrimmed === ".help") {
            writeln(".exit              Return to SQL mode");
            writeln(".clear             Clear conversation history");
            writeln(".help              Show this help");
            continue;
          }

          if (aiTrimmed === ".clear") {
            aiMessages.length = 0;
            writeln("Conversation cleared.", "33");
            continue;
          }

          aiMessages.push({ role: "user", content: aiTrimmed });
          aiAbort = new AbortController();
          let firstText = true;
          const md = createMarkdownRenderer(term.cols);

          // Ctrl+C / Escape handler — abort the in-flight request
          const cancelDisposable = term.onData((data: string) => {
            if ((data === "\x03" || data === "\x1b") && aiAbort) { // Ctrl+C or Escape
              aiAbort.abort();
            }
          });

          startSpinner("Thinking...");

          try {
            // Tool executor
            const executeTool = async (name: string, input: any): Promise<string> => {
              if (name === "run_sql") {
                stopSpinner();
                queryRunning = true;
                const result = await runQueryAsync(input.sql);
                clearProgressBar();
                queryRunning = false;
                if (!result.ok) {
                  const errMsg = result.error || "Query failed";
                  rl.println(`\x1b[31m  Error: ${errMsg}\x1b[0m`);
                  throw new Error(errMsg);
                }
                if (!result.arrowBuffers?.length) {
                  rl.println(`\x1b[2m  OK (no results)\x1b[0m`);
                  return JSON.stringify({ ok: true, message: "Query executed successfully (no results)" });
                }
                const table = tableFromIPC(result.arrowBuffers[0]);
                await printTable(table);
                const { json } = formatArrowTableAsJson(table);
                return json;
              }
              if (name === "read_query_results") {
                return executeReadQueryResults(input.result_id, input.offset, input.limit);
              }
              if (name === "list_tables") {
                return executeListTables(config.catalogData!);
              }
              if (name === "describe_table") {
                return executeDescribeTable(config.catalogData!, input.schema, input.table);
              }
              if (name === "ask_user") {
                stopSpinner();
                // Display question and options
                rl.println("");
                rl.println(`\x1b[1m${input.question}\x1b[0m`);
                const options: string[] = input.options || [];
                for (let i = 0; i < options.length; i++) {
                  rl.println(`  \x1b[33m${i + 1}.\x1b[0m ${options[i]}`);
                }
                rl.println("");
                const choice = await rl.read("Select: ");
                const idx = parseInt(choice.trim(), 10) - 1;
                if (idx >= 0 && idx < options.length) {
                  return `User selected: ${options[idx]}`;
                }
                return `User responded: ${choice.trim()}`;
              }
              return JSON.stringify({ error: `Unknown tool: ${name}` });
            };

            await runAgentTurn(
              aiApiKey,
              aiModel,
              aiMessages,
              systemPrompt,
              executeTool,
              {
                onText: (chunk) => {
                  if (firstText) {
                    stopSpinner();
                    rl.println(""); // blank line before agent response
                    firstText = false;
                  }
                  const formatted = md.push(chunk);
                  if (formatted) term.write(formatted);
                },
                onToolCall: (name, input) => {
                  stopSpinner();
                  // Flush markdown and separate from preceding text
                  const remaining = md.end();
                  if (remaining) term.write(remaining);
                  if (!firstText) term.write("\r\n");
                  rl.println("");
                  if (name === "run_sql") {
                    const sqlLabel = "── SQL ";
                    const lineWidth = Math.max(0, term.cols - sqlLabel.length - 1);
                    rl.println(`\x1b[2m${sqlLabel}${"─".repeat(lineWidth)}\x1b[0m`);
                    rl.println(`\x1b[33m${input.sql}\x1b[0m`);
                    rl.println("");
                  } else if (name === "describe_table") {
                    rl.println(`\x1b[2m  📋 Describing ${input.schema}.${input.table}\x1b[0m`);
                  } else if (name === "list_tables") {
                    rl.println(`\x1b[2m  📋 Listing tables\x1b[0m`);
                  } else if (name === "ask_user") {
                    // Handled in executeTool
                  } else {
                    rl.println(`\x1b[2m  [${name}]\x1b[0m`);
                  }
                },
                onToolResult: () => {
                  rl.println("");
                  startSpinner("Thinking...");
                  firstText = true;
                },
                onDone: (usage) => {
                  stopSpinner();
                  // Flush any remaining buffered markdown
                  const remaining = md.end();
                  if (remaining) term.write(remaining);
                  rl.println("");
                  if (usage) {
                    // Estimate cost per million tokens (as of 2025)
                    const pricing: Record<string, [number, number]> = {
                      "claude-haiku-4-5-20251001": [1, 5],
                      "claude-sonnet-4-20250514": [3, 15],
                      "claude-opus-4-20250514": [15, 75],
                    };
                    const [inRate, outRate] = pricing[aiModel] || [3, 15];
                    const cost = (usage.inputTokens * inRate + usage.outputTokens * outRate) / 1_000_000;
                    const costStr = cost < 0.01 ? `<$0.01` : `~$${cost.toFixed(2)}`;
                    rl.println(`\x1b[2m  tokens: ${usage.inputTokens.toLocaleString()} in, ${usage.outputTokens.toLocaleString()} out (${costStr})\x1b[0m`);
                  }
                  rl.println("");
                  rl.println("");
                },
                onError: (error) => {
                  stopSpinner();
                  rl.println("");
                  writeln(`Error: ${error}`, "31");
                  rl.println("");
                },
              },
              aiAbort.signal,
              aiMaxToolRounds
            );
          } catch (err: any) {
            stopSpinner();
            if (err.name === "AbortError" || err.message === "Cancelled.") {
              rl.println("");
              writeln("Cancelled.", "33");
              rl.println("");
              // Remove the partial assistant message from history
              if (aiMessages.length && aiMessages[aiMessages.length - 1].role === "user") {
                // User message was added but no response — keep it for retry
              }
            } else {
              rl.println("");
              writeln(`Error: ${err.message || err}`, "31");
              rl.println("");
            }
          } finally {
            cancelDisposable.dispose();
          }
        }

        continue; // Back to SQL readLoop
      }

      queryRunning = true;
      const t0 = performance.now();
      const result = await runQueryAsync(trimmed);
      const elapsed = performance.now() - t0;
      clearProgressBar();
      queryRunning = false;

      if (!result.ok) {
        const errStr = result.error || "unknown";
        // Try to parse structured DuckDB error JSON
        let errMsg = errStr;
        let errPos = -1;
        try {
          const parsed = JSON.parse(errStr);
          if (parsed.exception_message) {
            errMsg = parsed.exception_message;
            if (parsed.position) errPos = parseInt(parsed.position, 10);
          }
        } catch {
          // Not JSON — check for plain position hint like "... at position 15"
        }

        writeln(`Error: ${errMsg}`, "31");

        // Show position indicator under the query
        if (errPos >= 0) {
          rl.println(`\x1b[2m${trimmed}\x1b[0m`);
          rl.println(`\x1b[31m${" ".repeat(Math.max(0, errPos - 1))}^\x1b[0m`);
          // Pre-fill next prompt with the query, cursor at error position
          prefillText = trimmed;
          prefillCursorPos = errPos - 1; // position is 1-based
        }
      } else if (result.arrowBuffers && result.arrowBuffers.length > 0) {
        try {
          lastArrowBuffer = result.arrowBuffers[0];
          const table = tableFromIPC(lastArrowBuffer);
          lastTable = table;
          if (outputMode === "line") {
            printLine(table, elapsed);
          } else {
            await printTable(table, elapsed);
          }
        } catch (err: any) {
          writeln(`Failed to render: ${err.message}`, "31");
        }
      } else {
        writeln("OK", "32");
      }
    }
  }

  // Format a value based on Arrow field type.
  // Arrow JS get() already converts Date/Timestamp to epoch milliseconds.
  function formatVal(val: any, field: any): string {
    if (val === null || val === undefined) return "NULL";
    if (val instanceof Uint8Array) return "[binary]";
    const typeStr: string = field.type?.toString() || "";
    const num = typeof val === "bigint" ? Number(val) : val;
    if (typeof num === "number" && !isNaN(num)) {
      if (typeStr.startsWith("Date")) {
        const d = new Date(num);
        if (!isNaN(d.getTime())) return d.toISOString().split("T")[0];
      }
      if (typeStr.startsWith("Timestamp")) {
        const d = new Date(num);
        if (!isNaN(d.getTime())) {
          const s = d.toISOString().replace("T", " ").replace("Z", "");
          return s.endsWith(".000") ? s.slice(0, -4) : s;
        }
      }
      if (typeStr.startsWith("Time")) {
        const totalSec = Math.floor(num / 1000);
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
      }
    }
    if (typeof val === "bigint") return val.toString();
    return String(val);
  }

  // Duckbox-style table rendering using cli-table3
  async function printTable(table: any, elapsedMs?: number) {
    const fields = table.schema.fields;
    const numRows = table.numRows;
    const totalCols = fields.length;
    if (totalCols === 0) { writeln("(empty)"); return; }

    const displayRows = Math.min(numRows, 500);

    // Build formatted string grid: rows[r][c]
    const grid: string[][] = [];
    for (let r = 0; r < displayRows; r++) {
      const row: string[] = [];
      for (let c = 0; c < totalCols; c++) {
        row.push(formatVal(table.getChildAt(c)?.get(r), fields[c]));
      }
      grid.push(row);
    }

    // Measure ideal widths and get type names
    const MAX_COL_WIDTH = 20;
    const names: string[] = fields.map((f: any) => f.name);
    const types: string[] = fields.map((f: any) => fieldToDuckDBType(f));
    const isNumeric: boolean[] = fields.map((f: any) => isNumericField(f));
    const idealWidths: number[] = [];
    for (let c = 0; c < totalCols; c++) {
      let w = Math.max(names[c].length, types[c].length);
      for (let r = 0; r < displayRows; r++) w = Math.max(w, grid[r][c].length);
      idealWidths.push(Math.min(w, MAX_COL_WIDTH));
    }

    // Determine which columns fit in terminal width
    // Each column uses: 1(pad) + width + 1(pad) + 1(border) = width + 3
    // Plus 1 for the left border
    const termW = term.cols;
    const calcTotal = (widths: number[]) => 1 + widths.reduce((s, w) => s + w + 3, 0);

    let visibleIndices: number[];
    let ellipsisPos: number | null = null; // insert position in visible array

    if (calcTotal(idealWidths) <= termW) {
      // All columns fit
      visibleIndices = idealWidths.map((_, i) => i);
    } else {
      // Zig-zag prune from middle
      const ELLIPSIS_COST = 4; // "│ … │" = 1 + 3
      const hidden = new Set<number>();
      const mid = Math.floor(totalCols / 2);
      // Build zig-zag order: mid, mid-1, mid+1, mid-2, mid+2, ...
      const order: number[] = [mid];
      for (let d = 1; d < totalCols; d++) {
        if (mid - d >= 0) order.push(mid - d);
        if (mid + d < totalCols) order.push(mid + d);
      }

      for (const idx of order) {
        hidden.add(idx);
        const remaining = idealWidths.filter((_, i) => !hidden.has(i));
        if (calcTotal(remaining) + ELLIPSIS_COST <= termW) break;
      }

      visibleIndices = [];
      let insertedEllipsis = false;
      for (let i = 0; i < totalCols; i++) {
        if (hidden.has(i)) {
          if (!insertedEllipsis) {
            ellipsisPos = visibleIndices.length;
            insertedEllipsis = true;
          }
        } else {
          visibleIndices.push(i);
        }
      }
      // If ellipsis not yet placed (all hidden cols were at end), place at end
      if (hidden.size > 0 && ellipsisPos === null) {
        ellipsisPos = visibleIndices.length;
      }
    }

    const shownCount = visibleIndices.length;
    const hiddenCount = totalCols - shownCount;

    try {
      const Table = (await import(/* @vite-ignore */ "cli-table3")).default;

      // Build colWidths and colAligns arrays, inserting ellipsis column
      const colWidths: number[] = [];
      const colAligns: ("left" | "right" | "center")[] = [];
      const headerRow: any[] = [];
      const typeRow: any[] = [];

      for (let vi = 0; vi < shownCount; vi++) {
        if (ellipsisPos === vi) {
          colWidths.push(3); // " … " = 1 pad + 1 char + 1 pad
          colAligns.push("center");
          headerRow.push({ content: "…", hAlign: "center" as const });
          typeRow.push({ content: " ", hAlign: "center" as const });
        }
        const ci = visibleIndices[vi];
        colWidths.push(idealWidths[ci] + 2); // +2 for padding
        colAligns.push(isNumeric[ci] ? "right" : "left");
        headerRow.push({ content: `\x1b[1m${truncStr(names[ci], idealWidths[ci])}\x1b[0m`, hAlign: "center" as const });
        typeRow.push({ content: `\x1b[2m${truncStr(types[ci], idealWidths[ci])}\x1b[0m`, hAlign: "center" as const });
      }
      // Ellipsis at end
      if (ellipsisPos === shownCount) {
        colWidths.push(3);
        colAligns.push("center");
        headerRow.push({ content: "…", hAlign: "center" as const });
        typeRow.push({ content: " ", hAlign: "center" as const });
      }

      const tableOpts = {
        colWidths,
        colAligns,
        chars: { "mid": "", "left-mid": "", "mid-mid": "", "right-mid": "" },
        style: { head: [], border: [], "padding-left": 1, "padding-right": 1, compact: true },
      };

      // Header table — bottom border uses ├┼┤ (separator style, not └┴┘)
      const hdrTbl = new Table({
        ...tableOpts,
        chars: { ...tableOpts.chars, "bottom": "─", "bottom-mid": "┼", "bottom-left": "├", "bottom-right": "┤" },
      });
      hdrTbl.push(headerRow);
      hdrTbl.push(typeRow);
      const hdrOutput = hdrTbl.toString();
      for (const line of hdrOutput.split("\n")) {
        rl.println(line);
      }

      // Data table — no top border (header's bottom is the separator)
      const dataTbl = new Table({
        ...tableOpts,
        chars: { ...tableOpts.chars, "top": "", "top-mid": "", "top-left": "", "top-right": "" },
      });
      for (let r = 0; r < displayRows; r++) {
        const row: any[] = [];
        for (let vi = 0; vi < shownCount; vi++) {
          if (ellipsisPos === vi) {
            row.push({ content: "…", hAlign: "center" as const });
          }
          const ci = visibleIndices[vi];
          const val = grid[r][ci];
          const display = val === "NULL"
            ? `\x1b[2mNULL\x1b[0m`
            : truncStr(val, idealWidths[ci]);
          row.push(isNumeric[ci] ? { content: display, hAlign: "right" as const } : display);
        }
        if (ellipsisPos === shownCount) {
          row.push({ content: "…", hAlign: "center" as const });
        }
        dataTbl.push(row);
      }
      const dataOutput = dataTbl.toString();
      for (const line of dataOutput.split("\n")) {
        rl.println(line);
      }

      // Footer
      const rowText = `${numRows} row${numRows !== 1 ? "s" : ""}`;
      const colText = hiddenCount > 0
        ? `${totalCols} columns (${shownCount} shown)`
        : `${totalCols} column${totalCols !== 1 ? "s" : ""}`;
      const timeText = elapsedMs != null
        ? (elapsedMs < 1000 ? `${Math.round(elapsedMs)}ms` : `${(elapsedMs / 1000).toFixed(2)}s`)
        : "";
      const footerParts = [rowText, totalCols > 1 ? colText : "", timeText].filter(Boolean);
      rl.println(`\x1b[2m${footerParts.join("    ")}\x1b[0m`);
    } catch (err: any) {
      // Fallback: simple pipe-separated
      for (const row of grid) {
        rl.println(row.join(" | "));
      }
      rl.println(`(${numRows} row${numRows !== 1 ? "s" : ""})`);
    }
  }

  /** Truncate a string to maxLen, appending … if needed. */
  function truncStr(s: string, maxLen: number): string {
    if (s.length <= maxLen) return s;
    return s.slice(0, maxLen - 1) + "…";
  }

  /** Check if an Arrow field represents a numeric type. */
  function isNumericField(field: any): boolean {
    const t = field.type?.toString() || "";
    return /^(Int|Uint|Float|Decimal|float|int|uint|double)/i.test(t) ||
      t.startsWith("Duration");
  }

  /** Map Arrow field to a short DuckDB type name for the type row. */
  function fieldToDuckDBType(field: any): string {
    const t = field.type?.toString() || "?";
    const map: Record<string, string> = {
      "Utf8": "varchar", "LargeUtf8": "varchar",
      "Int8": "tinyint", "Int16": "smallint", "Int32": "int32", "Int64": "int64",
      "Uint8": "utinyint", "Uint16": "usmallint", "Uint32": "uint32", "Uint64": "uint64",
      "Float16": "float", "Float32": "float", "Float64": "double",
      "Bool": "boolean", "Binary": "blob", "LargeBinary": "blob",
    };
    if (map[t]) return map[t];
    if (t.startsWith("Dictionary<")) {
      const inner = t.match(/,\s*(.+)>$/)?.[1];
      return inner && map[inner] ? map[inner] : "varchar";
    }
    if (t.startsWith("Timestamp")) return "timestamp";
    if (t.startsWith("Date")) return "date";
    if (t.startsWith("Time")) return "time";
    if (t.startsWith("Decimal")) return "decimal";
    if (t.startsWith("Struct")) return "struct";
    if (t.includes("List")) return "list";
    // Check extension metadata for geometry
    const ext = field.metadata?.get?.("ARROW:extension:name");
    if (ext?.startsWith("geoarrow.")) return "geometry";
    return t.toLowerCase();
  }

  /** Line mode: render each record vertically, one field per line. */
  function printLine(table: any, elapsedMs?: number) {
    const fields = table.schema.fields;
    const numRows = table.numRows;
    const totalCols = fields.length;
    if (totalCols === 0) { writeln("(empty)"); return; }

    const displayRows = Math.min(numRows, 500);
    const names: string[] = fields.map((f: any) => f.name);
    const maxNameLen = Math.max(...names.map((n: string) => n.length));
    const lineWidth = Math.min(term.cols, maxNameLen + 30);

    for (let r = 0; r < displayRows; r++) {
      // Record header
      const label = ` RECORD ${r + 1} `;
      const dashCount = Math.max(0, lineWidth - label.length - 1);
      rl.println(`\x1b[2m─${label}${"─".repeat(dashCount)}\x1b[0m`);
      // Fields
      for (let c = 0; c < totalCols; c++) {
        const val = formatVal(table.getChildAt(c)?.get(r), fields[c]);
        const name = names[c].padStart(maxNameLen);
        const display = val === "NULL" ? `\x1b[2mNULL\x1b[0m` : val;
        rl.println(`${name} = ${display}`);
      }
    }

    // Footer
    const rowText = `${numRows} row${numRows !== 1 ? "s" : ""}`;
    const colText = `${totalCols} column${totalCols !== 1 ? "s" : ""}`;
    const timeText = elapsedMs != null
      ? (elapsedMs < 1000 ? `${Math.round(elapsedMs)}ms` : `${(elapsedMs / 1000).toFixed(2)}s`)
      : "";
    const footerParts = [rowText, colText, timeText].filter(Boolean);
    rl.println(`\x1b[2m${footerParts.join("    ")}\x1b[0m`);
  }

  /** Download the last result as CSV or Excel. */
  function downloadFile(table: any, format: "csv" | "excel") {
    const fields = table.schema.fields;
    const numRows = table.numRows;
    const totalCols = fields.length;

    // Build CSV content
    const csvEscape = (s: string) => {
      if (s.includes(",") || s.includes('"') || s.includes("\n")) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    };

    const header = fields.map((f: any) => csvEscape(f.name)).join(",");
    const rows: string[] = [header];
    for (let r = 0; r < numRows; r++) {
      const cells: string[] = [];
      for (let c = 0; c < totalCols; c++) {
        cells.push(csvEscape(formatVal(table.getChildAt(c)?.get(r), fields[c])));
      }
      rows.push(cells.join(","));
    }

    const bom = format === "excel" ? "\uFEFF" : "";
    const content = bom + rows.join("\n") + "\n";
    const ext = format === "excel" ? "xlsx" : "csv";
    const mime = format === "excel"
      ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      : "text/csv;charset=utf-8";

    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `result.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    writeln(`Downloaded result.${ext} (${numRows} row${numRows !== 1 ? "s" : ""}, ${totalCols} column${totalCols !== 1 ? "s" : ""})`, "32");
  }

  // Expose query function and catalog name for kepler.gl's DuckDB adapter
  (window as any).__duckdbQuery = (sql: string) => runQueryAsync(sql);
  (window as any).__duckdbCatalogName = config.catalogName;

  if (isNewWorker) {
    // First shell: init worker, wait for ready, ATTACH, then start readLoop
    worker.postMessage({ type: "init" });
  }
  // If terminal already existed, everything (readLoop, handlers) is still running
  // — no need to reinitialize

  // Insert text into the terminal's current input line.
  // If the input is empty and the text looks like a table name, wrap it in SELECT * FROM.
  function insertText(text: string) {
    const isTable = text.includes(".") && !text.includes(" ") && !text.includes("(");
    if (isTable && isInputEmpty(term)) {
      term.paste(`SELECT * FROM ${text} LIMIT 100;`);
    } else {
      term.paste(text);
    }
    term.focus();
  }

  // Run a query: paste SQL then send Enter separately so readline processes it
  function runQuery(sql: string) {
    term.paste(sql);
    requestAnimationFrame(() => {
      term.paste("\r");
      term.focus();
    });
  }

  // Expose insertText immediately (for drag-drop from tree)
  (window as any).__shellInsertText = insertText;
  // __shellRunQuery is set later, after ATTACH completes and readLoop starts

  return {
    cleanup: () => {
      resizeObserver.disconnect();
      // Don't terminate shared worker or dispose shared terminal
      delete (window as any).__shellFitAddon;
      delete (window as any).__shellInsertText;
      delete (window as any).__shellRunQuery;
      delete (window as any).__duckdbQuery;
      delete (window as any).__duckdbCatalogName;
    },
    insertText,
  };
}

/** Check if the terminal's current input line is empty (just the prompt). */
function isInputEmpty(term: any): boolean {
  try {
    const buf = term.buffer?.active;
    if (!buf) return true;
    const line = buf.getLine(buf.cursorY)?.translateToString(true) || "";
    // The prompt is "D > " (4 visible chars). If the line is just the prompt, input is empty.
    const trimmed = line.trimEnd();
    return trimmed === "D >" || trimmed === "" || buf.cursorX <= 4;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Perspective viewer — loads CDN scripts and renders inline
// ---------------------------------------------------------------------------

const PERSPECTIVE_CDN = [
  "https://cdn.jsdelivr.net/npm/@perspective-dev/client/dist/cdn/perspective.js",
  "https://cdn.jsdelivr.net/npm/@perspective-dev/viewer/dist/cdn/perspective-viewer.js",
  "https://cdn.jsdelivr.net/npm/@perspective-dev/viewer-datagrid/dist/cdn/perspective-viewer-datagrid.js",
  "https://cdn.jsdelivr.net/npm/@perspective-dev/viewer-d3fc/dist/cdn/perspective-viewer-d3fc.js",
  "https://cdn.jsdelivr.net/npm/@perspective-dev/viewer-openlayers/dist/cdn/perspective-viewer-openlayers.js",
];
const PERSPECTIVE_CSS = "https://cdn.jsdelivr.net/npm/@finos/perspective-viewer@3.8.0/dist/css/pro.css";

let perspectiveLoaded = false;
let perspectiveWorker: any = null;

async function loadPerspective(container: HTMLElement, arrowBuffer: Uint8Array) {
  // Load base theme CSS + VGI overrides once
  if (!document.querySelector(`link[href="${PERSPECTIVE_CSS}"]`)) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = PERSPECTIVE_CSS;
    link.crossOrigin = "anonymous";
    document.head.appendChild(link);

  }

  // Load scripts via dynamic import (ES modules)
  if (!perspectiveLoaded) {
    const perspective = await import(/* @vite-ignore */ PERSPECTIVE_CDN[0]);
    // Import viewer + plugins (register custom elements)
    await Promise.all(PERSPECTIVE_CDN.slice(1).map(url => import(/* @vite-ignore */ url)));
    perspectiveWorker = await perspective.default.worker();
    perspectiveLoaded = true;
  }

  // Create or reuse the viewer element
  let viewer = container.querySelector("perspective-viewer") as any;
  if (!viewer) {
    viewer = document.createElement("perspective-viewer");
    viewer.setAttribute("theme", "Pro Light");
    viewer.style.width = "100%";
    viewer.style.height = "100%";
    container.appendChild(viewer);
  }

  // Load Arrow data
  const copy = new Uint8Array(arrowBuffer);
  const table = await perspectiveWorker.table(copy.buffer);
  await viewer.load(table);
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
