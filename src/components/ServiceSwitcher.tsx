/**
 * The workspace picker, top right (multi-catalog phase 2; docs/multi-catalog.md,
 * "Picker").
 *
 * The trigger says what is connected, not who is signed in: one catalog's chip,
 * alias and status, or a workspace's chips, name and catalog count, plus how
 * many catalogs need attention. Identity is per catalog now, on its row.
 *
 * The dropdown holds the workspace's name (Rename), one row per catalog
 * (status, host, identity, Sign in / Retry inline, and a ⋯ menu: Edit
 * options…, Make default, Disable/Enable, Sign out, Copy URL, Detach),
 * "+ Attach a catalog…", the other workspaces to switch to, "Share workspace
 * link…" and "Sign out of all catalogs".
 *
 * The ⋯ menus open inline rather than in a portal: a portalled menu inside
 * the popover counts as a click outside it and closes both. Up/Down/Home/End
 * move between the rows (roving focus); a row's actions show while it has
 * focus, not only on hover; Escape closes an open ⋯ menu first.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  AlertTriangle, Check, CheckCircle2, ChevronDownIcon, Copy, Loader2, LogIn, LogOut, MoreHorizontal, Pencil, Plus, Settings2, Share2, Star,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Button } from "./ui/button";
import { getUserInfo, type UserInfo } from "@/lib/auth";
import type { CatalogAttachState } from "@/lib/shell-bridge";
import { hostOf, listWorkspaces, workspaceLabel, type Workspace } from "@/lib/workspace/store";
import { CatalogChip, ChipStack } from "./workspace/CatalogChip";
import { AttachCatalogForm, type AttachRequest } from "./workspace/AttachCatalogForm";
import { cn } from "@/lib/utils";
import { OPEN_ATTACH_EVENT, type AttachPrefill } from "@/lib/workspace/events";

export interface PickerCatalog {
  id: string;
  alias: string;
  url: string;
  catalogName: string;
  color: number;
  enabled: boolean;
  isDefault: boolean;
  state: CatalogAttachState;
  error?: string;
  /** The error panel has something to show. */
  hasDetail: boolean;
}

export interface WorkspaceActions {
  rename: (name: string | null) => void;
  retry: (id: string) => void;
  signIn: (id: string) => void;
  details: (id: string) => void;
  editOptions: (id: string) => void;
  makeDefault: (id: string) => void;
  setEnabled: (id: string, enabled: boolean) => void;
  signOut: (id: string) => void;
  detach: (id: string) => void;
  attach: (requests: AttachRequest[]) => Promise<string | null>;
  shareLink: () => Promise<{ url: string; omitted: string[] }>;
  signOutAll: () => void;
  switchTo: (id: string) => void;
  /** Manage workspaces…: opens the workspace manager (`WorkspaceManager`). */
  manage: () => void;
}

interface Props {
  workspace: Pick<Workspace, "id" | "name">;
  catalogs: PickerCatalog[];
  actions: WorkspaceActions;
}

/** Open the picker on its "Attach a catalog…" form (the sidebar's empty
 *  workspace button, a report's Attach, the command palette). Defined in
 *  `lib/workspace/events.ts` so those can fire it without this component. */
export { OPEN_ATTACH_EVENT } from "@/lib/workspace/events";

const NEEDS_ATTENTION: ReadonlySet<CatalogAttachState> = new Set(["failed", "sign-in-required"]);

function statusText(c: PickerCatalog): string {
  if (!c.enabled) return "Disabled";
  switch (c.state) {
    case "attached": return "Attached";
    case "connecting": return "Connecting…";
    case "sign-in-required": return "Sign-in required";
    case "failed": return "Failed";
    case "disabled": return "Disabled";
  }
}

function StatusIcon({ c, className }: { c: PickerCatalog; className?: string }) {
  if (!c.enabled || c.state === "disabled") return null;
  if (c.state === "attached") return <CheckCircle2 className={cn("size-3.5 text-emerald-600 dark:text-emerald-400", className)} aria-hidden="true" />;
  if (c.state === "connecting") return <Loader2 className={cn("size-3.5 animate-spin text-muted-foreground", className)} aria-hidden="true" />;
  if (c.state === "sign-in-required") return <LogIn className={cn("size-3.5 text-amber-600 dark:text-amber-400", className)} aria-hidden="true" />;
  return <AlertTriangle className={cn("size-3.5 text-destructive", className)} aria-hidden="true" />;
}

/** "opened 3 days ago" */
export function openedAgo(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} ${d === 1 ? "day" : "days"} ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Move focus among the rows' primary controls. */
function rovingKeys(e: KeyboardEvent<HTMLElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
  const target = e.target as HTMLElement;
  if (target.closest("[role=menu]") || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return;
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-row-primary]")];
  if (!rows.length) return;
  e.preventDefault();
  const current = rows.findIndex((r) => r === target || r.closest("[data-picker-row]") === target.closest("[data-picker-row]"));
  const next = e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1
    : e.key === "ArrowDown" ? Math.min(rows.length - 1, current + 1) : Math.max(0, current < 0 ? 0 : current - 1);
  rows[next]?.focus();
}

function CatalogRow({ c, actions, user, onClose }: { c: PickerCatalog; actions: WorkspaceActions; user: UserInfo | null; onClose: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (menuOpen) menuRef.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus(); }, [menuOpen]);
  const closeMenu = () => { setMenuOpen(false); moreRef.current?.focus(); };
  const run = (fn: () => void, close = true) => () => { setMenuOpen(false); fn(); if (close) onClose(); };
  const menuKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]:not([disabled])")];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); items[(i - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); e.stopPropagation(); items[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); e.stopPropagation(); items[items.length - 1]?.focus(); }
    else if (e.key === "Tab") setMenuOpen(false);
  };
  const dim = !c.enabled;
  const label = `${c.alias}${c.isDefault ? ", default" : ""}: ${statusText(c)}`;
  return (
    <li className="group/row" data-picker-row data-testid="picker-catalog-row" data-alias={c.alias} data-state={c.enabled ? c.state : "disabled"}>
      <div className={cn("flex items-start gap-2 px-4 py-2 hover:bg-muted/60 focus-within:bg-muted/60", dim && "opacity-60")}>
        <CatalogChip alias={c.alias} color={c.color} className="mt-0.5" />
        <button
          type="button"
          data-row-primary
          className="min-w-0 flex-1 text-left outline-none rounded focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={label}
          title={c.url}
          onClick={() => { if (c.enabled && NEEDS_ATTENTION.has(c.state) && c.hasDetail) { actions.details(c.id); onClose(); } }}
        >
          <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <span className="truncate font-mono">{c.alias}</span>
            {c.isDefault && <Star className="size-3 shrink-0 fill-current text-muted-foreground" aria-hidden="true" />}
            <StatusIcon c={c} />
            <span className="text-[11px] font-normal text-muted-foreground">{statusText(c)}</span>
          </span>
          <span className="block truncate text-xs text-muted-foreground">{hostOf(c.url)}{c.catalogName && c.catalogName !== c.alias ? ` · ${c.catalogName}` : ""}</span>
          {user && <span className="block truncate text-xs text-muted-foreground" data-testid="picker-catalog-identity">{user.name ? `${user.name} · ` : ""}{user.email}</span>}
          {c.enabled && c.state === "failed" && c.error && <span className="block text-[11px] text-destructive line-clamp-2 break-words">{c.error}</span>}
        </button>
        <span className="flex shrink-0 items-center gap-1">
          {c.enabled && c.state === "sign-in-required" && <Button size="xs" onClick={() => { actions.signIn(c.id); }}>Sign in</Button>}
          {c.enabled && c.state === "failed" && <Button size="xs" variant="outline" onClick={() => actions.retry(c.id)}>Retry</Button>}
          {!c.enabled && <Button size="xs" variant="outline" onClick={() => actions.setEnabled(c.id, true)}>Enable</Button>}
          <button
            ref={moreRef}
            type="button"
            aria-label={`More actions for ${c.alias}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
            className={cn(
              "rounded p-1 text-muted-foreground hover:bg-accent/40 hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring",
              !menuOpen && "opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100",
            )}
            data-testid="picker-catalog-more"
          >
            <MoreHorizontal className="size-4" />
          </button>
        </span>
      </div>
      {menuOpen && (
        <div ref={menuRef} role="menu" aria-label={`Actions for ${c.alias}`} onKeyDown={menuKeys} className="mx-4 mb-2 rounded-md border border-border bg-popover py-1 shadow-sm" data-testid="picker-catalog-menu">
          <MenuItem onClick={run(() => actions.editOptions(c.id))} icon={<Settings2 />}>Edit options…</MenuItem>
          <MenuItem disabled={c.isDefault || !c.enabled} onClick={run(() => actions.makeDefault(c.id), false)} icon={<Star />}>Make default</MenuItem>
          <MenuItem onClick={run(() => actions.setEnabled(c.id, !c.enabled), false)} icon={<Check />}>{c.enabled ? "Disable" : "Enable"}</MenuItem>
          <MenuItem disabled={!user} onClick={run(() => actions.signOut(c.id), false)} icon={<LogOut />}>Sign out (this catalog)</MenuItem>
          <MenuItem
            onClick={() => { void navigator.clipboard?.writeText(c.url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {}); }}
            icon={copied ? <Check /> : <Copy />}
          >
            {copied ? "Copied" : "Copy URL"}
          </MenuItem>
          <MenuItem destructive onClick={run(() => actions.detach(c.id), false)} icon={<LogOut className="rotate-180" />}>Detach</MenuItem>
        </div>
      )}
    </li>
  );
}

function MenuItem({ children, onClick, icon, disabled, destructive }: { children: React.ReactNode; onClick: () => void; icon: React.ReactNode; disabled?: boolean; destructive?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm outline-none [&_svg]:size-3.5 disabled:opacity-40 disabled:pointer-events-none",
        destructive ? "text-destructive hover:bg-destructive/10 focus:bg-destructive/10" : "text-foreground hover:bg-muted focus:bg-muted",
      )}
    >
      {icon}{children}
    </button>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="px-4 pt-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{children}</div>;
}

export function ServiceSwitcher({ workspace, catalogs, actions }: Props) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(workspace.name ?? "");
  const [attaching, setAttaching] = useState(false);
  /** What the attach form opens with, when something asked for a particular catalog. */
  const [prefill, setPrefill] = useState<AttachPrefill | null>(null);
  const [share, setShare] = useState<{ url: string; omitted: string[] } | null>(null);
  const [shareCopied, setShareCopied] = useState(false);
  const [others, setOthers] = useState<Workspace[]>([]);
  const [users, setUsers] = useState<Record<string, UserInfo | null>>({});

  useEffect(() => {
    if (!open) { setRenaming(false); setAttaching(false); setShare(null); return; }
    setOthers(listWorkspaces().filter((w) => w.id !== workspace.id).slice(0, 8));
    setUsers(Object.fromEntries(catalogs.map((c) => [c.id, getUserInfo(c.url)])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => { setName(workspace.name ?? ""); }, [workspace.name]);
  useEffect(() => {
    const openAttach = (event: Event) => {
      setPrefill((event as CustomEvent<AttachPrefill | undefined>).detail ?? null);
      setOpen(true);
      setTimeout(() => setAttaching(true), 0);
    };
    window.addEventListener(OPEN_ATTACH_EVENT, openAttach);
    return () => window.removeEventListener(OPEN_ATTACH_EVENT, openAttach);
  }, []);

  const enabled = catalogs.filter((c) => c.enabled);
  const attention = enabled.filter((c) => NEEDS_ATTENTION.has(c.state));
  const signIns = attention.filter((c) => c.state === "sign-in-required").length;
  const attentionText = attention.length
    ? signIns === attention.length ? `${signIns} ${signIns === 1 ? "needs" : "need"} sign-in` : `${attention.length} ${attention.length === 1 ? "needs" : "need"} attention`
    : "";
  const only = catalogs.length === 1 ? catalogs[0] : null;
  const title = workspace.name ?? (only ? only.alias : workspaceLabel({ name: null, catalogs }));
  const triggerLabel = only
    ? `Workspace: ${only.alias}, ${statusText(only)}${attentionText ? `, ${attentionText}` : ""}`
    : `Workspace: ${title}, ${catalogs.length} ${catalogs.length === 1 ? "catalog" : "catalogs"}${attentionText ? `, ${attentionText}` : ""}`;

  const saveName = () => {
    actions.rename(name.trim() || null);
    setRenaming(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="flex items-center gap-2 rounded-full pl-2 pr-2 py-1 text-sm hover:bg-muted transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={triggerLabel}
        data-testid="workspace-picker"
      >
        {only ? <CatalogChip alias={only.alias} color={only.color} /> : <ChipStack catalogs={catalogs} />}
        <span className="max-w-[200px] truncate font-medium text-card-foreground hidden sm:inline">
          {only && !workspace.name ? only.alias : title}
          {!only && <span className="font-normal text-muted-foreground"> · {catalogs.length} {catalogs.length === 1 ? "catalog" : "catalogs"}</span>}
        </span>
        {only && <StatusIcon c={only} className="hidden sm:inline" />}
        {attentionText && (
          <span className="hidden md:inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400" data-testid="workspace-picker-attention">
            · <AlertTriangle className="size-3" aria-hidden="true" />{attentionText}
          </span>
        )}
        <ChevronDownIcon className="size-4 text-muted-foreground" />
      </PopoverTrigger>

      <PopoverContent className="w-[min(26rem,calc(100vw-1rem))] p-0 overflow-hidden" data-testid="workspace-picker-panel">
        <div className="max-h-[80vh] overflow-y-auto" onKeyDown={rovingKeys}>
          {/* The workspace */}
          <div className="px-4 py-3 border-b border-border">
            {renaming ? (
              <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); saveName(); }}>
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setRenaming(false); setName(workspace.name ?? ""); } }}
                  placeholder="Workspace name"
                  aria-label="Workspace name"
                  maxLength={200}
                  className="flex-1 min-w-0 px-2 py-1 rounded-md border border-input bg-card text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  data-testid="workspace-name-input"
                />
                <Button type="submit" size="sm">Save</Button>
              </form>
            ) : (
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-foreground" data-testid="workspace-name">{workspace.name ?? "Untitled workspace"}</div>
                  {!workspace.name && <div className="text-xs text-muted-foreground">Saved automatically. Name it to keep it.</div>}
                </div>
                <Button size="sm" variant="ghost" onClick={() => setRenaming(true)} data-testid="workspace-rename"><Pencil className="size-3.5" />{workspace.name ? "Rename" : "Name it"}</Button>
              </div>
            )}
          </div>

          {/* Its catalogs */}
          <SectionLabel>Catalogs in this workspace</SectionLabel>
          {catalogs.length === 0
            ? <p className="px-4 pb-2 text-sm text-muted-foreground">No catalogs attached.</p>
            : (
              <ul aria-label="Catalogs in this workspace" className="pb-1">
                {catalogs.map((c) => <CatalogRow key={c.id} c={c} actions={actions} user={users[c.id] ?? null} onClose={() => setOpen(false)} />)}
              </ul>
            )}
          {attaching ? (
            <div className="border-t border-border">
              <AttachCatalogForm
                key={prefill ? JSON.stringify(prefill) : "blank"}
                initial={prefill ?? undefined}
                takenAliases={catalogs.map((c) => c.alias)}
                onCancel={() => setAttaching(false)}
                onAttach={async (requests) => {
                  const error = await actions.attach(requests);
                  if (!error) setAttaching(false);
                  return error;
                }}
              />
            </div>
          ) : (
            <button
              type="button"
              data-row-primary
              onClick={() => { setPrefill(null); setAttaching(true); }}
              className="w-full flex items-center gap-2 px-4 py-2 text-left text-sm text-foreground hover:bg-muted focus-visible:bg-muted outline-none"
              data-testid="attach-catalog-open"
            >
              <Plus className="size-4 text-muted-foreground" />Attach a catalog…
            </button>
          )}

          {/* Other workspaces */}
          <div className="border-t border-border">
            <SectionLabel>Switch workspace</SectionLabel>
            {others.length > 0 && (
              <ul aria-label="Other workspaces" className="pb-1">
                {others.map((w) => (
                  <li key={w.id} data-picker-row>
                    <button
                      type="button"
                      data-row-primary
                      onClick={() => { setOpen(false); actions.switchTo(w.id); }}
                      className="w-full flex items-center gap-2 px-4 py-1.5 text-left hover:bg-muted focus-visible:bg-muted outline-none"
                      data-testid="picker-workspace-row"
                    >
                      <ChipStack catalogs={w.catalogs} />
                      <span className="min-w-0 flex-1 truncate text-sm">{workspaceLabel(w)}</span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">{w.name ? "" : "untitled · "}{openedAgo(w.lastOpenedAt)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              data-row-primary
              onClick={() => { setOpen(false); actions.manage(); }}
              className="w-full flex items-center gap-2 px-4 py-2 text-left text-sm text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:bg-muted outline-none"
            >
              <Settings2 className="size-4" />Manage workspaces…
            </button>
          </div>

          {/* Sharing and signing out */}
          <div className="border-t border-border py-1">
            {share ? (
              <div className="px-4 py-2 flex flex-col gap-1.5" data-testid="workspace-share">
                <div className="flex gap-2">
                  <input readOnly value={share.url} aria-label="Workspace link" onFocus={(e) => e.currentTarget.select()} className="flex-1 min-w-0 px-2 py-1 rounded-md border border-input bg-muted/40 text-xs font-mono" data-testid="workspace-share-url" />
                  <Button size="sm" variant="outline" onClick={() => { void navigator.clipboard?.writeText(share.url).then(() => { setShareCopied(true); setTimeout(() => setShareCopied(false), 1500); }, () => {}); }}>
                    {shareCopied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}{shareCopied ? "Copied" : "Copy"}
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">Anyone with the link is asked before anything attaches. Links never carry secrets.</p>
                {share.omitted.length > 0 && (
                  <p className="text-[11px] text-amber-700 dark:text-amber-400" data-testid="workspace-share-omitted">Left out: {share.omitted.join(", ")}. The recipient enters these themselves.</p>
                )}
              </div>
            ) : (
              <button
                type="button"
                data-row-primary
                disabled={catalogs.length === 0}
                onClick={() => { void actions.shareLink().then(setShare); }}
                className="w-full flex items-center gap-2 px-4 py-2 text-left text-sm text-foreground hover:bg-muted focus-visible:bg-muted outline-none disabled:opacity-50"
                data-testid="workspace-share-open"
              >
                <Share2 className="size-4 text-muted-foreground" />Share workspace link…
              </button>
            )}
            <button
              type="button"
              data-row-primary
              onClick={() => { setOpen(false); actions.signOutAll(); }}
              className="w-full flex items-center gap-2 px-4 py-2 text-left text-sm text-muted-foreground hover:text-destructive hover:bg-destructive/10 focus-visible:bg-destructive/10 outline-none"
            >
              <LogOut className="size-4" />Sign out of all catalogs
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
