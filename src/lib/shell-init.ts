/**
 * Imperative DuckDB shell initialization — terminal setup, ATTACH flow,
 * read loop, dot-command + AI-mode dispatch, query rendering, CSV/XLSX
 * download. Lives outside DuckDBShell.tsx so the React component is only
 * responsible for state, refs, JSX, and the useEffect that calls in here.
 *
 * Boundary: this module knows about xterm, the DuckDB worker, and the
 * shared `bridge` singleton — never about React. It returns a handle with
 * `cleanup` and `insertText`; the React layer wires those to its lifecycle.
 *
 * Singleton terminal: the xterm Terminal + FitAddon + Readline are created
 * once (first call) and reattached to the new container on subsequent calls,
 * so panel/full-screen mode transitions don't tear down the SQL session.
 */
import { formatCellValue, safeGetArrowValue } from "./format";
import { printBoxTable, printLineTable, type TerminalOutput } from "./shell-table-renderer";
import { handleDotCommand, type ShellState, type ShellIO } from "./shell-commands";
import { runAIMode, type AIConversationState, type AITerminal, type AIShellOps } from "./shell-ai-mode";
import { attachInputHandlers, type CompletionItem } from "./shell-input";
import { bridge, recordQuery, notifyQueryChange, setBootPhase } from "./shell-bridge";
import { getOAuthMeta, redirectToAuth } from "./auth";
import { ensureDuckDB } from "./duckdb-worker-boot";
import { getTerminalTheme } from "./theme";
import { getColumns, type CatalogData } from "./service";

export interface ShellConfig {
  serviceUrl: string;
  catalogName: string;
  token: string | null;
  fontSize?: number;
  threadCount?: number;
  catalogData?: CatalogData;
  aiApiKey?: string;
  aiModel?: string;
  attachOptions?: string;
}

export interface ShellModules {
  tableFromIPC: any;
  Readline: any;
}

export interface ShellCallbacks {
  onAuthError?: (title: string, message: string) => void;
  onAttachError?: (title: string, message: string) => void;
}

export interface ShellHandle {
  cleanup: () => void;
  insertText: (text: string) => void;
}

export function initShell(
  container: HTMLElement,
  config: ShellConfig,
  modules: ShellModules,
  callbacks: ShellCallbacks = {}
): ShellHandle {
  const { onAuthError, onAttachError } = callbacks;
  const { tableFromIPC, Readline } = modules;
  const T = (window as any).Terminal;
  const FA = (window as any).FitAddon;
  const WLA = (window as any).WebLinksAddon;
  const WGA = (window as any).WebglAddon;

  // Singleton terminal — reuse across shell instances
  const isNewTerminal = !bridge.shellTerm;
  let term: any, fitAddon: any, rl: any;
  let shellInputHandlers: ReturnType<typeof attachInputHandlers>;

  if (isNewTerminal) {
    term = new T({
      cursorBlink: true,
      fontSize: config.fontSize || 13,
      fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
      theme: (() => { const t = getTerminalTheme(); return { background: t.background, foreground: t.foreground, cursor: t.cursor, selectionBackground: t.selection }; })(),
      allowProposedApi: true,
    });
    fitAddon = new FA.FitAddon();
    rl = new Readline();
    term.loadAddon(fitAddon);
    term.loadAddon(new WLA.WebLinksAddon());
    term.loadAddon(rl);
    term.open(container);
    try { term.loadAddon(new WGA.WebglAddon()); } catch { /* canvas fallback */ }

    // Batch writes within the same microtask to prevent flicker.
    // xterm-readline clears + redraws the line in separate write() calls;
    // this combines them into a single write so they render in one frame.
    const _origWrite = term.write.bind(term);
    let _writeBuf = "";
    let _flushScheduled = false;
    term.write = function(data: any) {
      _writeBuf += data;
      if (!_flushScheduled) {
        _flushScheduled = true;
        queueMicrotask(() => {
          _origWrite(_writeBuf);
          _writeBuf = "";
          _flushScheduled = false;
        });
      }
    };

    // Tab completion + Ctrl+R reverse search (delegated to shell-input.ts).
    // sql_auto_complete autoloads on first call against haybarn's default
    // repository — no explicit INSTALL/LOAD needed.
    shellInputHandlers = attachInputHandlers(term, rl, async (text) => {
      const q = bridge.query;
      if (!q) {
        shellInputHandlers?.onCompletions([]);
        return;
      }
      const sql = `CALL sql_auto_complete('${text.replace(/'/g, "''")}')`;
      const result = await q(sql);
      const completions: CompletionItem[] = [];
      if (result.ok && result.arrowBuffers?.length) {
        try {
          const table = tableFromIPC(new Uint8Array(result.arrowBuffers[0]));
          const sugCol = table.getChild("suggestion");
          const startCol = table.getChild("suggestion_start");
          const scoreCol = table.getChild("suggestion_score");
          for (let i = 0; i < table.numRows; i++) {
            completions.push({
              suggestion: sugCol ? String(sugCol.get(i)) : "",
              start: startCol ? Number(startCol.get(i)) : 0,
              score: scoreCol ? Number(scoreCol.get(i)) : 0,
            });
          }
        } catch { /* ignore parse errors */ }
      }
      shellInputHandlers?.onCompletions(completions);
    });

    bridge.shellTerm = term;
    bridge.shellFitAddon = fitAddon;
    bridge.shellReadline = rl;
  } else {
    term = bridge.shellTerm;
    fitAddon = bridge.shellFitAddon;
    rl = bridge.shellReadline;
    // Reparent the terminal DOM element to the new container
    const termEl = term.element?.parentElement;
    if (termEl && termEl !== container) {
      container.appendChild(termEl);
    }
  }

  let fitTimer: ReturnType<typeof setTimeout> | null = null;
  const safeFit = () => {
    try {
      if (container.offsetWidth > 0 && container.offsetHeight > 0) {
        fitAddon?.fit();
      }
    } catch {}
  };
  const debouncedFit = () => {
    if (fitTimer) clearTimeout(fitTimer);
    fitTimer = setTimeout(safeFit, 50);
  };
  const resizeObserver = new ResizeObserver(debouncedFit);
  resizeObserver.observe(container);

  // Fit after reparenting. ResizeObserver above handles ongoing reflows; this
  // one-shot rAF catches the initial paint without the prior magic-number
  // setTimeout ladder (50/100/300ms) that was guessing at layout settling.
  requestAnimationFrame(safeFit);

  // Write helpers
  function writeln(msg: string, color?: string) {
    const c = color ? `\x1b[${color}m` : "";
    const r = color ? "\x1b[0m" : "";
    rl.println(c + msg + r);
  }

  // Progress bar
  let progressLine = false;
  function renderProgressBar(pct: number) {
    // DuckDB's get_query_progress returns -1 when progress reporting is
    // disabled (we disable C++ enable_progress_bar to avoid a Safari
    // Embind crash), NaN if the query hasn't started, or a finite value
    // in [0,100] during a running query. Clamp to [0,100] so downstream
    // Math.round + String.repeat can't receive anything out of range.
    if (!Number.isFinite(pct)) return;
    const clamped = Math.max(0, Math.min(100, pct));
    const label = ` ${String(Math.round(clamped)).padStart(3)}%`;
    const barWidth = Math.max(10, term.cols - label.length - 2);
    const filled = Math.max(0, Math.min(barWidth, Math.round((clamped / 100) * barWidth)));
    const empty = Math.max(0, barWidth - filled);
    const bar = " \x1b[32m" + "█".repeat(filled) + "\x1b[2m" + "░".repeat(empty) + "\x1b[0m";
    term.write(`\r${bar}${label}\x1b[K`);
    progressLine = true;
  }
  function clearProgressBar() {
    if (progressLine) {
      term.write("\r\x1b[K");
      progressLine = false;
    }
  }
  // Tie the progress bar into the existing bridge callback so other code paths
  // (haybarn boot, deferred installs) can also feed it. Held back as a ref so
  // we can restore on cleanup.
  const prevBridgeProgress = bridge.progress;
  bridge.progress = renderProgressBar;

  // ensureDuckDB is called below inside the isNewTerminal branch (idempotent)
  // so the boot fires lazily on first shell open, not on every initShell.
  let currentWasmVersion = "";

  let queryRunning = false;
  let outputMode: "box" | "line" = "box";
  let maxDisplayRows = 40;
  let lastTable: any = null;
  let lastArrowBuffer: Uint8Array | null = null;

  /** Handle the VGI extension's interactive OAuth popup request. Opens a
   *  popup window, waits for oauth-callback.html to post the real code back
   *  via BroadcastChannel, then writes it into the shared SAB so the
   *  extension's blocking _duckdb_wasm_open_auth_url() returns it.
   *
   *  SAB protocol (see duckdb-coi.js, _duckdb_wasm_open_auth_url):
   *    flag = 1   → byte[4..7] holds length, byte[8..] holds the code
   *    flag = -1  → byte[4..7] holds length, byte[8..] holds the error msg
   *    flag = 0   → extension is still waiting (Atomics.wait on this) */
  function handleAuthUrl(url: string): void {
    const oauthSAB = (bridge as unknown as { _oauthSAB?: SharedArrayBuffer })._oauthSAB ?? null;
    if (!oauthSAB) {
      console.error("[shell] No oauth SAB — can't route auth code back to extension");
      return;
    }

    const writeSab = (flag: 1 | -1, payload: string) => {
      const int32 = new Int32Array(oauthSAB);
      const bytes = new Uint8Array(oauthSAB);
      const encoded = new TextEncoder().encode(payload);
      const maxBytes = oauthSAB.byteLength - 8;
      if (encoded.length > maxBytes) {
        console.error(`[shell] SAB payload too large (${encoded.length} > ${maxBytes}), truncating`);
        encoded.subarray(0, maxBytes).forEach((b, i) => { bytes[8 + i] = b; });
        new DataView(oauthSAB).setInt32(4, maxBytes, true);
      } else {
        new DataView(oauthSAB).setInt32(4, encoded.length, true);
        bytes.set(encoded, 8);
      }
      Atomics.store(int32, 0, flag);
      Atomics.notify(int32, 0);
    };

    const popup = window.open(url, "_blank", "popup,width=500,height=700");
    if (!popup) {
      writeSab(-1, "Popup blocked by browser");
      return;
    }
    console.log("[shell] Opened OAuth popup:", url.slice(0, 80));

    const bc = new BroadcastChannel("vgi-oauth");
    let settled = false;

    const cleanup = () => {
      settled = true;
      try { bc.close(); } catch { /* already closed */ }
      clearTimeout(timeoutTimer);
    };

    bc.onmessage = (ev: MessageEvent) => {
      if (settled) return;
      const m = ev.data;
      if (!m || m.type !== "oauth-callback") return;
      cleanup();
      if (m.code) {
        console.log("[shell] Received auth code from popup, delivering to extension");
        writeSab(1, m.code);
      } else {
        const err = m.errorDescription || m.error || "Authentication failed";
        console.warn("[shell] OAuth popup reported error:", err);
        writeSab(-1, err);
      }
      try { popup.close(); } catch { /* already closed */ }
    };

    // We intentionally do NOT poll `popup.closed`. With COOP: same-origin
    // (required for SharedArrayBuffer / DuckDB-WASM threads), navigating the
    // popup cross-origin severs the browsing context group, and the
    // disconnected WindowProxy reports `closed === true` immediately — even
    // while the user is still mid-login. The BroadcastChannel message from
    // oauth-callback.html (same-origin) is the only reliable signal. The
    // timeout below bounds the worker's Atomics.wait if no callback arrives.
    const timeoutTimer = setTimeout(() => {
      if (settled) return;
      cleanup();
      console.warn("[shell] OAuth popup timed out after 60s");
      writeSab(-1, "Authentication timed out");
      try { popup.close(); } catch { /* already closed */ }
    }, 60_000);
  }

  /** Build the ATTACH SQL for the VGI catalog, forwarding whichever token
   *  the catalog fetch was already using.
   *
   *  Two auth shapes the frontend supports:
   *  - SPA / PKCE popup: tokens (incl. refresh) live in sessionStorage.
   *    `getOAuthMeta` returns {refreshToken, tokenEndpoint, clientId, ...}
   *    which we forward as `oauth_refresh_token` so the VGI extension can
   *    refresh on 401 without prompting again.
   *  - Server-side redirect + cookie / URL fragment: refresh token isn't
   *    exposed to JS — only the access token is (via the `_vgi_auth` cookie
   *    or `#token=` fragment). Forward it as `bearer_token` so the extension
   *    uses it as-is; once the token expires the extension falls back to
   *    its own PKCE popup, but at least the FIRST ATTACH after sign-in
   *    doesn't double-prompt the user.
   *
   *  `bearer_token` and `oauth_refresh_token` are mutually exclusive per
   *  the VGI extension (vgi_extension.cpp:701) — refresh wins.
   */
  function buildAttachSql(): string {
    const esc = (s: string) => s.replace(/'/g, "''");
    const oauthMeta = getOAuthMeta(config.serviceUrl);
    // config.token is whichever bearer the catalog fetch ended up using
    // (SPA access token, cookie, or fragment) — captured by CatalogApp
    // when it constructed the shell config.
    const accessToken = config.token;
    let sql = `ATTACH OR REPLACE '${esc(config.catalogName)}' AS "${config.catalogName.replace(/"/g, '""')}" (TYPE vgi, LOCATION '${esc(config.serviceUrl)}'`;
    if (oauthMeta?.refreshToken) {
      sql += `, oauth_refresh_token '${esc(oauthMeta.refreshToken)}'`;
    } else if (accessToken) {
      sql += `, bearer_token '${esc(accessToken)}'`;
    }
    const userOpts = config.attachOptions?.trim().replace(/^,\s*/, "");
    if (userOpts) {
      sql += `, ${userOpts}`;
    }
    console.log("[shell] ATTACH auth:", {
      refreshToken: oauthMeta?.refreshToken ? "<present>" : "missing",
      bearerToken: accessToken && !oauthMeta?.refreshToken ? `<present (${accessToken.length} chars)>` : "skipped",
      tokenEndpoint: oauthMeta?.tokenEndpoint ?? "n/a",
    });
    return sql + `)`;
  }

  /**
   * Classify an ATTACH error and route it.
   *
   * - "surfaced": the error came from the IdP rejecting our credentials
   *   (token exchange or refresh failed, invalid_grant). Re-running the
   *   same auth flow would hit the same wall — we show the full error
   *   in a modal via onAuthError instead.
   * - "redirected": the error is a recoverable pre-exchange auth state
   *   (no token yet, bare 401/403). We send the user back through the
   *   VGI server's auth flow to get fresh credentials. Caller should
   *   return immediately.
   * - "unhandled": not auth-related. Caller should fall through to its
   *   normal error rendering.
   */
  function handleAttachError(errStr: string, title: string): "surfaced" | "redirected" | "unhandled" {
    // Unrecoverable IdP rejections — the tokens we have are bad and the
    // front-end can't fix them by retrying. Surface via modal, don't loop.
    const isUnrecoverable = /token exchange failed|token refresh failed|invalid_grant|AADSTS\d+/i.test(errStr);
    if (isUnrecoverable) {
      console.log("[shell] Unrecoverable auth error, surfacing to modal:", errStr);
      onAuthError?.(title, errStr);
      return "surfaced";
    }
    // Recoverable pre-exchange auth state — we need fresh credentials.
    const isRecoverableAuth = /oauth|auth|401|403|token.*expired/i.test(errStr);
    if (isRecoverableAuth) {
      console.log("[shell] Recoverable auth error, redirecting. config.token:",
                  config.token ? config.token.substring(0, 20) + "..." : "NONE");
      redirectToAuth(config.serviceUrl);
      return "redirected";
    }
    // Non-auth ATTACH failure (typically a malformed user-supplied option).
    // Surface via modal so users notice with the shell minimized; the
    // terminal also receives the error via the caller's writeln fallback.
    onAttachError?.(title, errStr);
    return "unhandled";
  }

  // Runs the post-ready flow (INSTALL vgi + ATTACH + timezone + readLoop).
  // Invoked once AsyncDuckDB.instantiate has resolved and bridge.query is live.
  let postReadyInvoked = false;
  const runPostReady = (readyWasmVersion: string) => {
    if (postReadyInvoked) return;
    postReadyInvoked = true;
    currentWasmVersion = readyWasmVersion;
    (async () => {
      // Disable both autoload AND autoinstall so subsequent queries can
      // never trigger a synchronous extension fetch mid-statement. We saw
      // `SET TimeZone='America/...'` deadlock the wasm worker when it tried
      // to autoload ICU during the SET — an Emscripten/sync-wait quirk
      // against Cloudflare-served extensions. With both disabled, missing
      // extensions surface as a normal SQL error we can route through
      // try/catch, and the only way an extension gets loaded is via our
      // explicit INSTALL/LOAD calls below.
      await bridge.query!("SET autoload_known_extensions = false");
      await bridge.query!("SET autoinstall_known_extensions = false");

      // Extensions to pre-load at shell startup. Each gets an explicit
      // INSTALL + LOAD pair so no user query triggers a sync autoload.
      // `source` is the FROM clause for the INSTALL — omitted for core
      // extensions, `community` for community ones. `required: true` means
      // the shell can't function without it (currently just VGI).
      const extensions: Array<{ name: string; source?: string; required?: boolean }> = [
        { name: "icu" },
        { name: "json" },
        { name: "vgi", source: "community", required: true },
        { name: "iceberg" },
        { name: "spatial" },
        { name: "ducklake" },
      ];
      for (const ext of extensions) {
        writeln(`Loading ${ext.name} extension...`, "33");
        setBootPhase(`Loading ${ext.name} extension`);
        const fromClause = ext.source ? ` FROM ${ext.source}` : "";
        const install = await bridge.query!(`INSTALL ${ext.name}${fromClause}`);
        if (!install.ok) {
          const msg = `INSTALL ${ext.name} failed: ${install.error ?? ""}`;
          if (ext.required) {
            console.error("[shell]", msg);
            writeln(msg, "31");
            writeln("The haybarn extension repository may be unreachable.", "31");
            return;
          }
          console.warn("[shell]", msg, "(continuing)");
          continue;
        }
        const load = await bridge.query!(`LOAD ${ext.name}`);
        if (!load.ok) {
          const msg = `LOAD ${ext.name} failed: ${load.error ?? ""}`;
          if (ext.required) {
            console.error("[shell]", msg);
            writeln(msg, "31");
            return;
          }
          console.warn("[shell]", msg, "(continuing)");
        }
      }

      if (config.serviceUrl && config.catalogName) {
        writeln(`Connecting to ${config.catalogName}...`, "33");
        setBootPhase(`Connecting to ${config.catalogName}`);
        const attachSql = buildAttachSql();
        console.log("[shell] ATTACH SQL:", attachSql.replace(/(oauth_refresh_token|bearer_token) '[^']*'/g, "$1 '***'"));
        const result = await bridge.query!(attachSql);
        if (result.ok) {
          await bridge.query!(`USE ${config.catalogName}`);
          writeln(`Connected to ${config.catalogName}`, "32");
          // Wake up consumers (column stats, data preview) that were awaiting
          // ATTACH completion. They block on bridge.attached so they don't
          // race the boot-phase exposure of bridge.query.
          bridge.markAttached?.();
        } else {
          const errStr = result.error ?? "";
          console.log("[shell] ATTACH failed:", errStr);
          const handled = handleAttachError(errStr, "Attach failed");
          if (handled === "redirected") return;
          if (handled !== "surfaced") {
            writeln(`Attach failed: ${errStr}`, "31");
          }
          // Resolve attached even on failure so downstream consumers fail
          // fast with their own "catalog not found" error instead of hanging.
          bridge.markAttached?.();
        }
        writeln("");
      } else {
        // No VGI catalog configured — resolve attached immediately so any
        // consumer that races here (shouldn't, but be defensive) doesn't hang.
        bridge.markAttached?.();
        writeln("");
        writeln("Type SQL queries below.", "33");
        writeln("");
      }

      // Sync timezone: push the browser's IANA zone (e.g. "America/New_York")
      // into DuckDB and into the format renderer. DuckDB-WASM defaults to a
      // fixed-offset zone like "Etc/GMT+5" which doesn't observe DST, so
      // timestamp_tz values render off by an hour during DST. The browser's
      // Intl-resolved zone is the one users expect to see.
      console.log("[shell] syncing timezone…");
      setBootPhase("Syncing timezone");
      const tzSync = (async () => {
        try {
          const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
          const { setDuckDBTimezone } = await import("./format");
          if (browserTz) {
            const r = await bridge.query!(`SET TimeZone='${browserTz.replace(/'/g, "''")}'`);
            if (!r.ok) console.warn("[shell] SET TimeZone failed:", r.error);
            setDuckDBTimezone(browserTz);
            console.log("[shell] timezone set to", browserTz);
          } else {
            const tzResult = await bridge.query!("SELECT current_setting('TimeZone') as tz");
            if (tzResult.ok && tzResult.arrowBuffers?.length) {
              const tzTable = tableFromIPC(tzResult.arrowBuffers[0]);
              const tzVal = tzTable.getChildAt(0)?.get(0);
              if (tzVal) setDuckDBTimezone(String(tzVal));
            }
          }
        } catch (err) {
          console.warn("[shell] timezone sync error:", err);
        }
      })();
      // Race tzSync against a timeout. Cancel the timer when tzSync wins so
      // the warning doesn't fire spuriously after a successful sync.
      let tzTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        tzSync.finally(() => { if (tzTimer) clearTimeout(tzTimer); }),
        new Promise<void>((resolve) => {
          tzTimer = setTimeout(() => {
            console.warn("[shell] timezone sync did not complete within 5s; continuing");
            resolve();
          }, 5000);
        }),
      ]);

      // Shell is fully ready — expose runQuery for external callers
      console.log("[shell] post-ready: handing off to readLoop");
      setBootPhase(null);
      bridge.runQuery = runQuery;
      notifyQueryChange();
      bridge.onAttachedCatalogsChanged?.();
      window.dispatchEvent(new Event("duckdb-ready"));
      readLoop();
    })();
  };

  // Query execution. Both async (streaming-shape) and sync (single-buffer for
  // Perspective) collapse to AsyncDuckDB.runQuery, which always returns a
  // single File-format Arrow IPC buffer.
  function runQueryAsync(sql: string): Promise<{ ok: boolean; arrowBuffers?: ArrayBuffer[]; error?: string }> {
    const q = bridge.query;
    if (!q) return Promise.resolve({ ok: false, error: "duckdb not ready" });
    return q(sql);
  }
  const runQuerySync = runQueryAsync;

  // Current catalog/schema for prompt
  let currentCatalog = "";
  let currentSchema = "";
  async function refreshCatalog() {
    try {
      const r = await runQueryAsync("SELECT current_catalog(), current_schema()");
      if (r.ok && r.arrowBuffers?.length) {
        const t = tableFromIPC(r.arrowBuffers[0]);
        if (t.numRows > 0) {
          currentCatalog = String(t.getChildAt(0)?.get(0) ?? "");
          currentSchema = String(t.getChildAt(1)?.get(0) ?? "");
        }
      }
    } catch {}
  }

  // Persistent AI conversation state (survives across .ai mode entries)
  const aiConv: AIConversationState = {
    messages: [],
    conversationId: `ai-${Date.now()}`,
    conversationName: "",
  };

  // Read loop
  let prefillText = "";
  let prefillCursorPos = -1;
  let promptInputEmpty = true;
  // Track whether user has typed anything at the current prompt
  const inputTracker = term.onData((data: string) => {
    // Printable characters (not control sequences) mean the user typed something
    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      promptInputEmpty = false;
    }
  });

  async function readLoop() {
    await refreshCatalog();
    while (true) {
      promptInputEmpty = true;
      const ctx = currentCatalog
        ? `\x1b[2m${currentCatalog}.${currentSchema}\x1b[0m`
        : "";
      const prompt = ctx ? `\x1b[32mD\x1b[0m ${ctx} > ` : `\x1b[32mD\x1b[0m > `;
      const readPromise = rl.read(prompt);
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
      // Dot-command dispatch (delegated to shell-commands.ts)
      if (trimmed.startsWith(".") || trimmed.startsWith("\\")) {
        const shellState: ShellState = {
          get maxDisplayRows() { return maxDisplayRows; },
          set maxDisplayRows(n) { maxDisplayRows = n; },
          get outputMode() { return outputMode; },
          set outputMode(m) { outputMode = m; },
          lastTable,
          lastArrowBuffer,
          currentWasmVersion,
        };
        const shellIO: ShellIO = { writeln, serviceUrl: config.serviceUrl, runQueryAsync, tableFromIPC, downloadFile };
        if (await handleDotCommand(trimmed, shellState, shellIO)) continue;
      }

      // AI mode (delegated to shell-ai-mode.ts)
      if (trimmed === ".ai" || trimmed === ".ai new" || trimmed.startsWith(".ai name ")) {
        const aiTerm: AITerminal = {
          get cols() { return term.cols; },
          write: (data: string) => term.write(data),
          paste: (text: string) => term.paste(text),
          println: (line: string) => rl.println(line),
          writeln,
          read: (prompt: string) => rl.read(prompt),
          onData: (handler: (data: string) => void) => term.onData(handler),
          get history() { return rl.history; },
        };
        const aiOps: AIShellOps = {
          catalogData: config.catalogData!,
          serviceUrl: config.serviceUrl,
          runQueryAsync,
          tableFromIPC,
          printTable,
          clearProgressBar,
          setQueryRunning: (running: boolean) => { queryRunning = running; },
          resetCancelFlag: () => { if (bridge.cancelInt32) Atomics.store(bridge.cancelInt32, 0, 0); },
        };
        await runAIMode(trimmed, aiConv, aiTerm, aiOps, { apiKey: config.aiApiKey || "", model: config.aiModel || "claude-sonnet-4-20250514" });
        continue;
      }

      queryRunning = true;
      const t0 = performance.now();
      const result = await runQueryAsync(trimmed);
      const elapsed = performance.now() - t0;
      clearProgressBar();
      queryRunning = false;
      if (bridge.cancelInt32) Atomics.store(bridge.cancelInt32, 0, 0); // reset cancel flag for next query

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
          const fields = table.schema.fields;
          const fieldNames = fields.map((f: any) => f.name);

          // DDL statements (CREATE, DROP, ALTER) return a single "Count" column — just show OK
          if (fields.length === 1 && fieldNames[0] === "Count" && table.numRows <= 1) {
            const elapsedStr = elapsed >= 1000 ? `${(elapsed / 1000).toFixed(1)}s` : `${Math.round(elapsed)}ms`;
            writeln(`OK (${elapsedStr})`, "32");
            // DDL — refresh sidebar and handle navigation
            bridge.refreshMemoryTables?.().then?.(() => {
              const createMatch = trimmed.match(/CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?(?:TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:memory\.)?(?:(\w+)\.)?(\w+)/i);
              if (createMatch) {
                const schema = createMatch[1] || "main";
                const name = createMatch[2];
                bridge.navigateToSelection?.({ type: "table", name, schema, catalog: "memory" });
              }
              const dropMatch = trimmed.match(/DROP\s+(?:TABLE|VIEW|SCHEMA)\s+(?:IF\s+EXISTS\s+)?(?:memory\.)?(?:(\w+)\.)?(\w+)/i);
              if (dropMatch) {
                const isSchemaLevel = /DROP\s+SCHEMA/i.test(trimmed);
                if (isSchemaLevel) {
                  bridge.navigateToSelection?.({ type: "catalog", name: "memory", catalog: "memory" });
                } else {
                  const schema = dropMatch[1] || "main";
                  bridge.navigateToSelection?.({ type: "schema", name: schema, schema, catalog: "memory" });
                }
              }
            });

          // EXPLAIN returns explain_key + explain_value — render as plain text
          } else if (fieldNames.includes("explain_key") && fieldNames.includes("explain_value")) {
            const keyIdx = fieldNames.indexOf("explain_key");
            const valIdx = fieldNames.indexOf("explain_value");
            for (let r = 0; r < table.numRows; r++) {
              const key = String(table.getChildAt(keyIdx)?.get(r) ?? "");
              const val = String(table.getChildAt(valIdx)?.get(r) ?? "");
              if (key) rl.println(`\x1b[1m${key}\x1b[0m`);
              for (const line of val.split("\n")) {
                rl.println(`\x1b[2m${line}\x1b[0m`);
              }
            }
            const elapsedStr = elapsed >= 1000 ? `${(elapsed / 1000).toFixed(1)}s` : `${Math.round(elapsed)}ms`;
            rl.println(`\x1b[2m(${elapsedStr})\x1b[0m`);

          } else if (outputMode === "line") {
            printLine(table, elapsed);
          } else {
            await printTable(table, elapsed);
          }

          recordQuery({ sql: trimmed, executionTimeMs: elapsed, success: true, rowCount: table.numRows });
        } catch (err: any) {
          writeln(`Failed to render: ${err.message}`, "31");
        }
      } else {
        writeln("OK", "32");
        recordQuery({ sql: trimmed, executionTimeMs: elapsed, success: true, rowCount: 0 });
      }

      // Refresh prompt catalog if the query might have changed it
      const upper = trimmed.toUpperCase();
      if (upper.startsWith("USE ") || upper.startsWith("ATTACH ") || upper.startsWith("SET SCHEMA") || upper.startsWith("SET SEARCH_PATH")) {
        await refreshCatalog();
      }
      // Sync sidebar with the live set of attached VGI catalogs whenever
      // the user ran an ATTACH or DETACH.
      if (/^\s*(ATTACH|DETACH)\b/i.test(trimmed)) {
        bridge.onAttachedCatalogsChanged?.();
      }
    }
  }

  // Use shared safeGetArrowValue from format.ts
  const safeGet = safeGetArrowValue;

  function formatVal(val: any, field: any): string {
    if (val === null || val === undefined) return "NULL";
    return formatCellValue(val, field?.name, field);
  }

  // Terminal output adapter for shell-table-renderer
  const termOutput: TerminalOutput = {
    get cols() { return term.cols; },
    println: (line: string) => rl.println(line),
  };

  async function printTable(table: any, elapsedMs?: number) {
    return printBoxTable(table, termOutput, maxDisplayRows, elapsedMs);
  }

  function printLine(table: any, elapsedMs?: number) {
    return printLineTable(table, termOutput, maxDisplayRows, elapsedMs);
  }

  /** Download the last result as CSV or Excel. */
  async function downloadFile(table: any, format: "csv" | "excel") {
    const fields = table.schema.fields;
    const numRows = table.numRows;
    const totalCols = fields.length;

    // Build row data
    const headers = fields.map((f: any) => f.name);
    const data: any[][] = [];
    for (let r = 0; r < numRows; r++) {
      const row: any[] = [];
      for (let c = 0; c < totalCols; c++) {
        const val = safeGet(table.getChildAt(c), r, fields[c]);
        row.push(val instanceof Uint8Array ? "[binary]" : formatVal(val, fields[c]));
      }
      data.push(row);
    }

    if (format === "excel") {
      // Real .xlsx via SheetJS
      const XLSX = await import("xlsx");
      const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Result");
      const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
      const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "result.xlsx";
      a.click();
      URL.revokeObjectURL(url);
      writeln(`Downloaded result.xlsx (${numRows} row${numRows !== 1 ? "s" : ""}, ${totalCols} column${totalCols !== 1 ? "s" : ""})`, "32");
    } else {
      // CSV
      const csvEscape = (s: string) => {
        if (s.includes(",") || s.includes('"') || s.includes("\n")) {
          return '"' + s.replace(/"/g, '""') + '"';
        }
        return s;
      };
      const csvRows = [headers.map(csvEscape).join(",")];
      for (const row of data) {
        csvRows.push(row.map((v: any) => csvEscape(String(v))).join(","));
      }
      const blob = new Blob([csvRows.join("\n") + "\n"], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "result.csv";
      a.click();
      URL.revokeObjectURL(url);
      writeln(`Downloaded result.csv (${numRows} row${numRows !== 1 ? "s" : ""}, ${totalCols} column${totalCols !== 1 ? "s" : ""})`, "32");
    }
  }

  // bridge.query and bridge.querySync are set by ensureDuckDB once AsyncDuckDB
  // has instantiated. Only catalogName is shell-config-specific.
  bridge.catalogName = config.catalogName;

  if (isNewTerminal) {
    // First initShell call this page load — wait for ensureDuckDB to resolve
    // (it kicked off when the shell first mounted) then run the post-ready
    // flow once. AsyncDuckDB's instantiate is the new "ready" signal.
    void (async () => {
      try {
        await ensureDuckDB({
          baseUrl: import.meta.env.BASE_URL,
          onAuthUrl: handleAuthUrl,
        });
        const elapsedMs = Math.round(performance.now() - bridge.workerCreateStart);
        const ready = bridge.workerReadyData;
        console.log(`[shell] DuckDBShell ready in ${elapsedMs}ms (haybarn ${ready?.wasmVersion ?? "?"})`);
        runPostReady(ready?.wasmVersion ?? "");
      } catch (err) {
        console.error("[shell] ensureDuckDB failed:", err);
        writeln(`Failed to initialize DuckDB: ${err instanceof Error ? err.message : String(err)}`, "31");
      }
    })();
  } else {
    // Reconnecting — readLoop is already running, re-expose runQuery
    bridge.runQuery = runQuery;
  }

  // Find geometry columns for a fully-qualified table name so they can be excluded.
  // Returns comma-separated geometry column names, or null if none found.
  function getGeometryExclude(dottedName: string): string | null {
    const parts = dottedName.split(".");
    if (parts.length !== 3) return null;
    const [cat, schema, table] = parts;
    const catalogs = [config.catalogData, bridge.memoryCatalog].filter(Boolean);
    for (const catData of catalogs) {
      if (catData.catalogName !== cat) continue;
      const s = catData.schemas.find((s: any) => s.info.name === schema);
      const t = s?.tables.find((t: any) => t.name === table);
      if (!t) continue;
      const geomCols = getColumns(t).filter((c) => c.duckdbType === "GEOMETRY").map((c) => c.name);
      return geomCols.length > 0 ? geomCols.join(", ") : null;
    }
    return null;
  }

  // Insert text into the terminal's current input line.
  // If the input is empty and the text looks like a table name, wrap it in SELECT * FROM.
  // Geometry columns are excluded via EXCLUDE since they have no shell representation.
  function insertText(text: string) {
    const isTable = text.includes(".") && !text.includes(" ") && !text.includes("(");
    if (isTable && promptInputEmpty) {
      const exclude = getGeometryExclude(text);
      if (exclude) {
        term.paste(`SELECT * EXCLUDE (${exclude}) FROM ${text} LIMIT 100;`);
      } else {
        term.paste(`SELECT * FROM ${text} LIMIT 100;`);
      }
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

  // Expose insertText immediately (for drag-drop from tree). bridge.runQuery
  // is set later, after ATTACH completes and readLoop starts.
  bridge.insertText = insertText;

  return {
    cleanup: () => {
      resizeObserver.disconnect();
      inputTracker.dispose();
      if (fitTimer) clearTimeout(fitTimer);
      bridge.progress = prevBridgeProgress;
      // Don't terminate shared worker or dispose shared terminal
      bridge.shellFitAddon = null;
      bridge.insertText = null;
      bridge.runQuery = null;
      // bridge.query stays set — it's owned by ensureDuckDB now, not by the
      // shell, and other components (DataPreview, fetchColumnStats, etc.)
      // depend on it remaining available even when the shell tab is closed.
      bridge.catalogName = null;
      notifyQueryChange();
    },
    insertText,
  };
}
