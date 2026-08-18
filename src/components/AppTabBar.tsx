/**
 * The single top-level tab bar (under the Header). Replaces both the old
 * header "Catalog / Query Editor" toggle and the bottom shell drawer's own tab
 * strip — one place to drive the whole UI.
 */
import { Database, FileCode2, Sparkles, Table2, History, BarChart3, PanelLeftClose, PanelLeftOpen, FileChartColumn } from "lucide-react";
import { cn } from "@/lib/utils";

export type TabId = "catalog" | "editor" | "shell" | "askai" | "reports" | "preview" | "queries" | "perspective";

interface TabDef {
  id: TabId;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  /** Persistent emphasis for the two primary ways into the product. */
  accent?: "editor" | "ai";
  /** Use the DuckDB logo image instead of a lucide icon. */
  img?: boolean;
}

const TABS: TabDef[] = [
  { id: "editor", label: "Query Editor", icon: FileCode2, accent: "editor" },
  { id: "askai", label: "Ask AI", icon: Sparkles, accent: "ai" },
  { id: "reports", label: "Reports", icon: FileChartColumn },
  { id: "shell", label: "SQL Shell", img: true },
  { id: "preview", label: "Data Viewer", icon: Table2 },
  { id: "catalog", label: "Catalog", icon: Database },
  { id: "queries", label: "Query History", icon: History },
  { id: "perspective", label: "Perspective", icon: BarChart3 },
];

interface Props {
  activeTab: TabId;
  onSelect: (tab: TabId) => void;
  /** Count shown on the Query History tab. */
  queryHistoryCount?: number;
  /** Tabs with work in flight — currently the two AI surfaces. Renders a
   *  pulsing dot so a running agent is visible from any other tab. */
  busyTabs?: Partial<Record<TabId, boolean>>;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}

export function AppTabBar({ activeTab, onSelect, queryHistoryCount = 0, busyTabs, sidebarCollapsed, onToggleSidebar }: Props) {
  return (
    <div className="flex items-center gap-1 px-2 h-10 border-b border-border bg-card shrink-0 overflow-x-auto">
      <button
        onClick={onToggleSidebar}
        className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-foreground/5 transition-colors shrink-0"
        title={sidebarCollapsed ? "Show catalog sidebar" : "Hide catalog sidebar"}
        aria-label={sidebarCollapsed ? "Show catalog sidebar" : "Hide catalog sidebar"}
        data-testid="toggle-sidebar"
      >
        {sidebarCollapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
      </button>
      <span className="h-5 w-px bg-border mx-0.5 shrink-0" aria-hidden="true" />
      <div className="flex items-center gap-1" role="tablist" aria-label="Workspace">
      {TABS.map((tab) => {
        const active = activeTab === tab.id;
        const Icon = tab.icon;
        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={active}
            aria-label={tab.label}
            onClick={() => onSelect(tab.id)}
            data-testid={`tab-${tab.id}`}
            className={cn(
              "inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md border border-transparent whitespace-nowrap transition-colors shrink-0",
              active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-foreground/5",
            )}
          >
            {tab.img ? (
              <img src={`${import.meta.env.BASE_URL}duckdb-icon-light.svg`} alt="" className="h-4 w-4" />
            ) : Icon ? (
              <Icon
                className={cn(
                  "h-3.5 w-3.5",
                  !active && tab.accent === "editor" && "text-sky-500",
                  !active && tab.accent === "ai" && "text-violet-500",
                )}
              />
            ) : null}
            <span className={active ? "inline" : "hidden sm:inline"}>{tab.label}</span>
            {busyTabs?.[tab.id] && (
              <span
                className={cn(
                  "ml-0.5 h-1.5 w-1.5 rounded-full animate-pulse shrink-0",
                  active ? "bg-primary-foreground/80" : "bg-accent",
                )}
                data-testid={`tab-busy-${tab.id}`}
                title="Working…"
                aria-label="Working"
              />
            )}
            {tab.id === "queries" && queryHistoryCount > 0 && (
              <span className={cn("ml-0.5 rounded-full px-1.5 text-[10px]", active ? "bg-primary-foreground/20" : "bg-foreground/10")}>
                {queryHistoryCount}
              </span>
            )}
          </button>
        );
      })}
      </div>
    </div>
  );
}
