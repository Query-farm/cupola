/**
 * Tab completion and Ctrl+R reverse history search for the DuckDB shell.
 * Self-contained state machines that attach to an xterm.js terminal.
 */

/** Minimal terminal interface needed by input handlers. */
interface ShellTerminal {
  cols: number;
  write: (data: string) => void;
  clear: () => void;
  attachCustomKeyEventHandler: (handler: (e: KeyboardEvent) => boolean) => void;
}

/** Minimal readline interface. */
interface ShellReadline {
  state: {
    buffer: () => string;
    update: (text: string) => void;
    refresh: () => void;
    editInsert: (text: string) => void;
  } | null;
  history: any;
}

/** A completion suggestion from DuckDB's sql_auto_complete. */
export interface CompletionItem {
  suggestion: string;
  start: number;
  score: number;
}

// ---------------------------------------------------------------------------
// Tab completion
// ---------------------------------------------------------------------------

interface CompletionState {
  active: boolean;
  items: CompletionItem[];
  idx: number;
  start: number;
  original: string;
  menuLines: number;
  numCols: number;
  numRows: number;
  colWidth: number;
}

function createCompletionState(): CompletionState {
  return { active: false, items: [], idx: 0, start: 0, original: "", menuLines: 0, numCols: 1, numRows: 1, colWidth: 10 };
}

function computeLayout(comp: CompletionState, termCols: number) {
  const maxLen = Math.max(...comp.items.map(c => c.suggestion.length));
  comp.colWidth = maxLen + 2;
  comp.numCols = Math.max(1, Math.floor(termCols / comp.colWidth));
  comp.numRows = Math.ceil(comp.items.length / comp.numCols);
}

function clearCompletionMenu(comp: CompletionState, term: ShellTerminal) {
  if (comp.menuLines > 0) {
    for (let i = 0; i < comp.menuLines; i++) term.write("\r\n\x1b[2K");
    term.write(`\x1b[${comp.menuLines}A`);
    comp.menuLines = 0;
  }
}

function renderCompletionMenu(comp: CompletionState, term: ShellTerminal, rl: ShellReadline) {
  clearCompletionMenu(comp, term);
  const lines: string[] = [];
  for (let row = 0; row < comp.numRows; row++) {
    let line = "";
    for (let col = 0; col < comp.numCols; col++) {
      const i = row * comp.numCols + col;
      if (i >= comp.items.length) continue;
      const text = comp.items[i].suggestion.padEnd(comp.colWidth);
      line += i === comp.idx ? `\x1b[7m${text}\x1b[0m` : text;
    }
    lines.push(line);
  }
  for (const line of lines) term.write("\r\n\x1b[2K" + line);
  if (lines.length > 0) term.write(`\x1b[${lines.length}A\r`);
  comp.menuLines = lines.length;
  rl.state?.refresh();
}

function applyCompletion(comp: CompletionState, rl: ShellReadline, idx: number) {
  if (!rl.state) return;
  const before = comp.original.slice(0, comp.start);
  rl.state.update(before + comp.items[idx].suggestion);
}

function exitCompletionMode(comp: CompletionState, term: ShellTerminal, rl: ShellReadline, accept: boolean) {
  if (!comp.active) return;
  comp.active = false;
  if (!accept && rl.state) rl.state.update(comp.original);
  clearCompletionMenu(comp, term);
  rl.state?.refresh();
}

function enterCompletionMode(comp: CompletionState, term: ShellTerminal, rl: ShellReadline, items: CompletionItem[], start: number, original: string) {
  comp.active = true;
  comp.items = items;
  comp.idx = 0;
  comp.start = start;
  comp.original = original;
  comp.menuLines = 0;
  computeLayout(comp, term.cols);
  applyCompletion(comp, rl, 0);
  renderCompletionMenu(comp, term, rl);
}

function moveCompletion(comp: CompletionState, term: ShellTerminal, rl: ShellReadline, newIdx: number) {
  if (newIdx < 0 || newIdx >= comp.items.length) return;
  comp.idx = newIdx;
  applyCompletion(comp, rl, comp.idx);
  renderCompletionMenu(comp, term, rl);
}

// ---------------------------------------------------------------------------
// Ctrl+R reverse history search
// ---------------------------------------------------------------------------

interface ReverseSearchState {
  active: boolean;
  term: string;
  idx: number;
  match: string;
  preBuffer: string;
}

function createSearchState(): ReverseSearchState {
  return { active: false, term: "", idx: -1, match: "", preBuffer: "" };
}

function renderSearchLine(search: ReverseSearchState, rl: ShellReadline) {
  if (!rl.state) return;
  const prefix = `\x1b[33m(reverse-i-search)\x1b[0m "\x1b[1m${search.term}\x1b[0m":  `;
  rl.state.update(prefix + (search.match || ""));
  rl.state.refresh();
}

function doReverseSearch(search: ReverseSearchState, rl: ShellReadline) {
  const needle = search.term.toLowerCase();
  if (!needle) { search.match = ""; return; }
  const entries: string[] = Array.isArray(rl.history) ? rl.history : (rl.history?.entries ?? []);
  const start = search.idx >= 0 ? search.idx + 1 : 0;
  for (let i = start; i < entries.length; i++) {
    if (entries[i].toLowerCase().includes(needle)) {
      search.idx = i;
      search.match = entries[i];
      return;
    }
  }
}

function exitReverseSearch(search: ReverseSearchState, rl: ShellReadline, accept: boolean) {
  search.active = false;
  if (rl.state) {
    rl.state.update(accept && search.match ? search.match : search.preBuffer);
    rl.state.refresh();
  }
  search.term = "";
  search.idx = -1;
  search.match = "";
  search.preBuffer = "";
}

// ---------------------------------------------------------------------------
// Attach all input handlers to a terminal
// ---------------------------------------------------------------------------

/**
 * Attach tab completion and reverse search key handlers to the terminal.
 * `requestCompletions` should send a completion request to the DuckDB worker;
 * call `onCompletions(items)` when results arrive.
 */
export function attachInputHandlers(
  term: ShellTerminal,
  rl: ShellReadline,
  requestCompletions: (text: string) => void,
): { onCompletions: (items: CompletionItem[]) => void } {
  const comp = createCompletionState();
  const search = createSearchState();
  let pendingCompletionCallback: ((items: CompletionItem[]) => void) | null = null;

  term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
    if (e.type !== "keydown") {
      if (comp.active && ["Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Escape", "Enter"].includes(e.key)) return false;
      if (search.active && !e.ctrlKey) return false;
      return true;
    }

    // ---- Tab completion navigation ----
    if (comp.active) {
      if (e.key === "ArrowRight" || (e.key === "Tab" && !e.shiftKey)) {
        e.preventDefault();
        moveCompletion(comp, term, rl, (comp.idx + 1) % comp.items.length);
        return false;
      }
      if (e.key === "ArrowLeft" || (e.key === "Tab" && e.shiftKey)) {
        e.preventDefault();
        moveCompletion(comp, term, rl, (comp.idx - 1 + comp.items.length) % comp.items.length);
        return false;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = comp.idx + comp.numCols;
        moveCompletion(comp, term, rl, next < comp.items.length ? next : comp.idx);
        return false;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        const prev = comp.idx - comp.numCols;
        moveCompletion(comp, term, rl, prev >= 0 ? prev : comp.idx);
        return false;
      }
      if (e.key === "Enter") { e.preventDefault(); exitCompletionMode(comp, term, rl, true); return false; }
      if (e.key === "Escape") { e.preventDefault(); exitCompletionMode(comp, term, rl, false); return false; }
      exitCompletionMode(comp, term, rl, true);
      return true;
    }

    // ---- Ctrl+K clears terminal ----
    if (e.key === "k" && (e.ctrlKey || e.metaKey)) { term.clear(); return false; }

    // ---- Ctrl+C during reverse search cancels it ----
    if (e.key === "c" && e.ctrlKey && search.active) { exitReverseSearch(search, rl, false); return false; }

    // ---- Ctrl+R — start or continue reverse search ----
    if (e.key === "r" && e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (!search.active) {
        search.active = true;
        search.term = "";
        search.idx = -1;
        search.match = "";
        search.preBuffer = rl.state?.buffer?.() || "";
        renderSearchLine(search, rl);
      } else {
        doReverseSearch(search, rl);
        renderSearchLine(search, rl);
      }
      return false;
    }

    // ---- Keys during reverse search ----
    if (search.active) {
      if (e.key === "Enter") { exitReverseSearch(search, rl, true); return false; }
      if (e.key === "Escape") { exitReverseSearch(search, rl, false); return false; }
      if (e.key === "Backspace") {
        search.term = search.term.slice(0, -1);
        search.idx = -1;
        doReverseSearch(search, rl);
        renderSearchLine(search, rl);
        return false;
      }
      if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        search.term += e.key;
        search.idx = -1;
        doReverseSearch(search, rl);
        renderSearchLine(search, rl);
        return false;
      }
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return false;
      exitReverseSearch(search, rl, true);
      return true;
    }

    // ---- Tab triggers completion ----
    if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      const state = rl.state;
      if (state) {
        const buf = state.buffer();
        if (buf.trim()) {
          pendingCompletionCallback = (completions) => {
            if (!completions || completions.length === 0) return;
            const currentBuf = state.buffer();
            const hasTies = completions.length > 1 && completions[0].score === completions[1].score;
            if (!hasTies) {
              const c = completions[0];
              const typed = currentBuf.slice(c.start);
              const toInsert = c.suggestion.slice(typed.length);
              if (toInsert) state.editInsert(toInsert);
            } else {
              const start = completions[0].start;
              const typed = currentBuf.slice(start);
              let common = completions[0].suggestion;
              for (let i = 1; i < completions.length; i++) {
                let j = 0;
                while (j < common.length && j < completions[i].suggestion.length &&
                  common[j].toLowerCase() === completions[i].suggestion[j].toLowerCase()) j++;
                common = common.slice(0, j);
              }
              const toInsert = common.slice(typed.length);
              if (toInsert) {
                state.editInsert(toInsert);
              } else {
                enterCompletionMode(comp, term, rl, completions, start, currentBuf);
              }
            }
          };
          requestCompletions(buf);
        }
      }
      return false;
    }

    return true;
  });

  return {
    onCompletions(items: CompletionItem[]) {
      if (pendingCompletionCallback) {
        const cb = pendingCompletionCallback;
        pendingCompletionCallback = null;
        cb(items);
      }
    },
  };
}
