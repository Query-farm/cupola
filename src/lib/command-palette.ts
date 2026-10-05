/**
 * The ⌘K command palette's commands, filter and shortcut (multi-catalog phase 3).
 *
 * **The shortcut** is ⌘K on macOS and Ctrl+K elsewhere, opened from anywhere in the app with
 * one exception: the SQL shell. xterm's custom key handler (`shell-input.ts`) gives both ⌘K and
 * Ctrl+K to "clear the terminal", the convention every terminal follows, so a press with focus in
 * the shell clears it and the palette stays shut. The SQL editor and the report editor are
 * CodeMirror, which binds neither: `Mod-k` is unbound in its default keymap (Shift-Mod-k deletes
 * a line, and Ctrl-k is kill-line only on macOS, where the palette uses ⌘), so the palette opens
 * there too. Browsers' own Ctrl+K (focus the search bar) yields to a page that handles it.
 *
 * **Commands** are built fresh each time the palette opens, from what the app knows then: the
 * workspaces, this workspace's catalogs and their statuses, and its saved reports. A command
 * with `children` opens a page of its own (Switch workspace…, Open report…); typing on the root
 * page searches those children too, so "fin" finds the Finance workspace directly.
 *
 * Pure: unit-tested in tests/unit/command-palette.test.ts.
 */

export interface PaletteCommand {
  id: string;
  title: string;
  /** Heading the command is listed under. */
  group: string;
  /** Extra words the filter matches (not shown). */
  keywords?: string[];
  /** Shown dimmed after the title (a host, a status). */
  hint?: string;
  /** Run it. A returned string is shown in the palette (e.g. "Link copied"). */
  run?: () => void | string | Promise<void | string>;
  /** Opens a page listing these instead of running. */
  children?: PaletteCommand[];
  /** The search field's placeholder on that page. */
  placeholder?: string;
}

/** How well `query` matches `text`: higher is better, null for no match. Every query character
 *  must appear in order (case-insensitive); consecutive runs and word starts score more, and a
 *  plain substring scores most. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  const sub = t.indexOf(q);
  if (sub >= 0) return 1000 - sub + (sub === 0 || /[\s\-_./›:]/.test(t[sub - 1]) ? 200 : 0) - t.length * 0.1;
  let score = 0;
  let ti = 0;
  let run = 0;
  for (const ch of q) {
    if (ch === " ") continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    const wordStart = found === 0 || /[\s\-_./›:]/.test(t[found - 1]);
    run = found === ti ? run + 1 : 0;
    score += 1 + run * 3 + (wordStart ? 8 : 0) - Math.min(found - ti, 10) * 0.5;
    ti = found + 1;
  }
  return score - t.length * 0.1;
}

function matchText(command: PaletteCommand): string {
  return [command.title, command.hint ?? "", ...(command.keywords ?? [])].join(" ");
}

/** A child command listed on the root page: its title says where it is from. */
function flattened(parent: PaletteCommand, child: PaletteCommand): PaletteCommand {
  return { ...child, id: `${parent.id}/${child.id}`, title: `${parent.title.replace(/…$/, "")}: ${child.title}`, group: child.group || parent.group };
}

/** The commands matching `query`, best first; with no query, all of them in their order. On the
 *  root page (`includeChildren`) the children of page commands are searched as well. */
export function filterCommands(commands: readonly PaletteCommand[], query: string, includeChildren = true): PaletteCommand[] {
  if (!query.trim()) return [...commands];
  const pool = includeChildren
    ? commands.flatMap((c) => [c, ...(c.children ?? []).map((child) => flattened(c, child))])
    : [...commands];
  return pool
    .map((command, index) => ({ command, index, score: fuzzyScore(query, matchText(command)) }))
    .filter((item): item is { command: PaletteCommand; index: number; score: number } => item.score !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.command);
}

/** Commands grouped by `group`, groups in first-seen order. */
export function groupCommands(commands: readonly PaletteCommand[]): { group: string; commands: PaletteCommand[] }[] {
  const groups = new Map<string, PaletteCommand[]>();
  for (const command of commands) {
    const list = groups.get(command.group);
    if (list) list.push(command);
    else groups.set(command.group, [command]);
  }
  return [...groups.entries()].map(([group, list]) => ({ group, commands: list }));
}

export type PaletteCatalogState = "connecting" | "attached" | "sign-in-required" | "failed" | "disabled";

export interface PaletteContext {
  /** Every workspace, `current` marking this tab's. */
  workspaces: { id: string; label: string; current: boolean; catalogCount: number }[];
  /** This workspace's catalogs. */
  catalogs: { id: string; alias: string; host: string; state: PaletteCatalogState; enabled: boolean; isDefault: boolean }[];
  /** This workspace's saved reports. */
  reports: { id: string; title: string }[];
  actions: {
    switchWorkspace: (id: string) => void;
    attachCatalog: () => void;
    signIn: (catalogId: string) => void;
    retry: (catalogId: string) => void;
    makeDefault: (catalogId: string) => void;
    renameCatalog?: (catalogId: string) => void;
    manageWorkspaces: () => void;
    /** No id: the saved-reports list. */
    openReport: (id?: string) => void;
    shareWorkspaceLink: () => Promise<string>;
  };
}

/** Every command the palette offers, in display order. */
export function buildPaletteCommands(ctx: PaletteContext): PaletteCommand[] {
  const { actions } = ctx;
  const commands: PaletteCommand[] = [];
  const catalogs = ctx.catalogs.filter((c) => c.enabled);
  for (const c of catalogs) {
    if (c.state === "sign-in-required") {
      commands.push({ id: `sign-in:${c.id}`, title: `Sign in to ${c.alias}`, hint: c.host, group: "Catalogs", keywords: ["login", "auth"], run: () => actions.signIn(c.id) });
    }
  }
  for (const c of catalogs) {
    if (c.state === "failed" || c.state === "sign-in-required") {
      commands.push({ id: `retry:${c.id}`, title: `Retry ${c.alias}`, hint: c.host, group: "Catalogs", keywords: ["reconnect", "attach"], run: () => actions.retry(c.id) });
    }
  }
  for (const c of catalogs) {
    if (c.state === "attached" && !c.isDefault) {
      commands.push({ id: `default:${c.id}`, title: `Make ${c.alias} default`, hint: c.host, group: "Catalogs", keywords: ["use", "primary"], run: () => actions.makeDefault(c.id) });
    }
  }
  commands.push({ id: "attach", title: "Attach catalog…", group: "Catalogs", keywords: ["add", "connect", "server"], run: actions.attachCatalog });
  if (actions.renameCatalog) {
    for (const c of ctx.catalogs) {
      if (c.alias) commands.push({ id: `rename:${c.id}`, title: `Rename catalog ${c.alias}…`, hint: c.host, group: "Catalogs", keywords: ["alias"], run: () => actions.renameCatalog!(c.id) });
    }
  }

  const others = ctx.workspaces.filter((w) => !w.current);
  commands.push({
    id: "switch",
    title: "Switch workspace…",
    group: "Workspaces",
    keywords: ["open", "change"],
    placeholder: "Switch to workspace…",
    children: others.map((w) => ({
      id: w.id,
      title: w.label,
      hint: `${w.catalogCount} ${w.catalogCount === 1 ? "catalog" : "catalogs"}`,
      group: "Workspaces",
      run: () => actions.switchWorkspace(w.id),
    })),
  });
  commands.push({ id: "manage", title: "Manage workspaces", group: "Workspaces", keywords: ["edit", "rename", "delete"], run: actions.manageWorkspaces });
  commands.push({ id: "share", title: "Share workspace link", group: "Workspaces", keywords: ["copy", "url", "link"], run: actions.shareWorkspaceLink });

  commands.push({
    id: "reports",
    title: "Open report…",
    group: "Reports",
    keywords: ["evidence", "dashboard"],
    placeholder: "Open report…",
    children: [
      { id: "all", title: "All reports", group: "Reports", keywords: ["saved", "library"], run: () => actions.openReport() },
      ...ctx.reports.map((r) => ({ id: r.id, title: r.title, group: "Reports", run: () => actions.openReport(r.id) })),
    ],
  });
  return commands;
}

/** ⌘K on macOS, Ctrl+K elsewhere; never with Shift or Alt (Shift-Mod-k deletes a line in
 *  CodeMirror), and never from inside the terminal, where it clears the screen. */
export function isPaletteShortcut(
  event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
  mac: boolean,
  inTerminal = false,
): boolean {
  if (event.key.toLowerCase() !== "k" || event.altKey || event.shiftKey || inTerminal) return false;
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

export function isMacPlatform(nav: { platform?: string; userAgent?: string } | undefined = typeof navigator === "undefined" ? undefined : navigator): boolean {
  if (!nav) return false;
  return /mac|iphone|ipad|ipod/i.test(nav.platform || "") || /mac os x/i.test(nav.userAgent || "");
}
