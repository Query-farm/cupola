import { useEffect, useMemo, useState } from "react";
import { ChevronDownIcon, ExternalLinkIcon, GlobeIcon, LogOutIcon, PlusIcon, XIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { getUserInfo, type UserInfo as UserInfoData } from "@/lib/auth";
import {
  getRecentServices,
  removeRecentService,
  type RecentService,
} from "@/lib/recent-services";

interface Props {
  currentUrl: string;
  currentCatalogName: string;
}

function buildServiceHref(url: string): string {
  const dest = new URL(window.location.href);
  dest.searchParams.set("service", url);
  // Selection anchors (#/schema/x/table/y) are scoped to the previous
  // catalog and meaningless in the next one.
  dest.hash = "";
  return dest.toString();
}

function buildWelcomeHref(): string {
  const dest = new URL(window.location.href);
  dest.searchParams.delete("service");
  dest.hash = "";
  return dest.toString();
}

/** Shorten a service URL for display: drop scheme, keep host + path. */
function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    const tail = u.pathname && u.pathname !== "/" ? u.pathname : "";
    return `${u.host}${tail}`;
  } catch {
    return url;
  }
}

function initialFor(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() : "?";
}

function Avatar({
  user,
  fallbackName,
  size,
}: {
  user: UserInfoData | null;
  fallbackName: string;
  size: "sm" | "md";
}) {
  const dim = size === "sm" ? "w-6 h-6 text-xs" : "w-10 h-10 text-base";
  if (user?.picture) {
    return (
      <img
        src={user.picture}
        alt=""
        className={`${dim} rounded-full shrink-0 object-cover`}
        onError={(e) => {
          // Hide broken avatar images so the chip fallback shows instead.
          (e.currentTarget as HTMLImageElement).style.display = "none";
        }}
      />
    );
  }
  return (
    <div
      className={`${dim} rounded-full shrink-0 bg-primary/15 text-primary font-semibold flex items-center justify-center`}
      aria-hidden
    >
      {initialFor(fallbackName)}
    </div>
  );
}

function ServiceRow({
  service,
  onRemove,
}: {
  service: RecentService;
  onRemove: (url: string) => void;
}) {
  const href = useMemo(() => buildServiceHref(service.url), [service.url]);

  const handleSwitch = () => {
    window.location.href = href;
  };
  const handleOpenNewTab = (e: React.MouseEvent) => {
    e.stopPropagation();
    window.open(href, "_blank", "noopener");
  };
  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    onRemove(service.url);
  };

  return (
    <li className="group">
      <button
        type="button"
        onClick={handleSwitch}
        title={service.url}
        className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-muted transition-colors cursor-pointer"
      >
        <div className="w-6 h-6 rounded shrink-0 bg-muted text-muted-foreground flex items-center justify-center">
          <GlobeIcon className="size-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">{service.catalogName}</div>
          <div className="truncate text-xs text-muted-foreground">{displayUrl(service.url)}</div>
        </div>
        <span className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <span
            role="button"
            tabIndex={0}
            onClick={handleOpenNewTab}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                handleOpenNewTab(e as unknown as React.MouseEvent);
              }
            }}
            title="Open in new tab"
            aria-label="Open in new tab"
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50"
          >
            <ExternalLinkIcon className="size-3.5" />
          </span>
          <span
            role="button"
            tabIndex={0}
            onClick={handleRemove}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                handleRemove(e as unknown as React.MouseEvent);
              }
            }}
            title="Remove from recents"
            aria-label="Remove from recents"
            className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10"
          >
            <XIcon className="size-3.5" />
          </span>
        </span>
      </button>
    </li>
  );
}

export function ServiceSwitcher({ currentUrl, currentCatalogName }: Props) {
  const [open, setOpen] = useState(false);
  // Use null initial state so SSR and first client render match.
  const [user, setUser] = useState<UserInfoData | null>(null);
  const [recents, setRecents] = useState<RecentService[]>([]);

  // Initial load after hydration.
  useEffect(() => {
    setUser(getUserInfo(currentUrl));
    setRecents(getRecentServices());
  }, [currentUrl]);

  // Refresh when the popover opens, so we pick up any changes made in
  // another tab (sign-out, new service visited, etc.).
  useEffect(() => {
    if (!open) return;
    setUser(getUserInfo(currentUrl));
    setRecents(getRecentServices());
  }, [open, currentUrl]);

  const others = useMemo(
    () => recents.filter((r) => r.url !== currentUrl),
    [recents, currentUrl],
  );

  const handleRemove = (url: string) => {
    removeRecentService(url);
    setRecents(getRecentServices());
  };

  const handleAddAnother = () => {
    window.location.href = buildWelcomeHref();
  };

  const handleSignOut = () => {
    const dest = new URL(`${import.meta.env.BASE_URL}sign-out`, window.location.origin);
    dest.searchParams.set("service", currentUrl);
    window.location.href = dest.toString();
  };

  // Trigger label: prefer authed email once hydrated, else fall back to
  // the catalog name (which is SSR-safe from props).
  const triggerLabel = user?.name ?? user?.email ?? currentCatalogName;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="flex items-center gap-2 rounded-full pl-1 pr-2 py-1 text-sm hover:bg-muted transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Switch service"
      >
        <Avatar user={user} fallbackName={currentCatalogName} size="sm" />
        <span className="max-w-[160px] truncate font-medium text-card-foreground hidden sm:inline">
          {triggerLabel}
        </span>
        <ChevronDownIcon className="size-4 text-muted-foreground" />
      </PopoverTrigger>

      <PopoverContent className="w-80 p-0 overflow-hidden">
        {/* Current service header */}
        <div className="px-4 py-3 border-b border-border flex items-center gap-3">
          <Avatar user={user} fallbackName={currentCatalogName} size="md" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-foreground" title={user?.name ?? currentCatalogName}>
              {user?.name ?? currentCatalogName}
            </div>
            {user?.email && (
              <div className="truncate text-xs text-muted-foreground" title={user.email}>
                {user.email}
              </div>
            )}
            {user?.name && (
              <div className="truncate text-xs text-muted-foreground" title={currentCatalogName}>
                {currentCatalogName}
              </div>
            )}
            <div className="truncate text-xs text-muted-foreground" title={currentUrl}>
              {displayUrl(currentUrl)}
            </div>
          </div>
        </div>

        {/* Switch-to list */}
        {others.length > 0 && (
          <div className="border-b border-border">
            <div className="px-4 pt-2.5 pb-1">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Recent servers</span>
            </div>
          <ul className="pb-1 max-h-72 overflow-y-auto">
            {others.map((s) => (
              <ServiceRow
                key={s.url}
                service={s}
                onRemove={handleRemove}
              />
            ))}
          </ul>
          </div>
        )}

        {/* Actions footer */}
        <div className="py-1">
          <button
            type="button"
            onClick={handleAddAnother}
            className="w-full flex items-center gap-3 px-4 py-2 text-left text-sm text-foreground hover:bg-muted transition-colors cursor-pointer"
          >
            <span className="w-6 h-6 rounded-full shrink-0 bg-muted text-muted-foreground flex items-center justify-center">
              <PlusIcon className="size-4" />
            </span>
            Add another server…
          </button>
          {user && (
            <button
              type="button"
              onClick={handleSignOut}
              className="w-full flex items-center gap-3 px-4 py-2 text-left text-sm text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors cursor-pointer"
            >
              <span className="w-6 h-6 shrink-0 flex items-center justify-center">
                <LogOutIcon className="size-4" />
              </span>
              Sign out
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
