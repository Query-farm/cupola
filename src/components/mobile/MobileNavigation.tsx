import { useState } from "react";
import { Sparkles, Database, FileCode2, Library, Ellipsis, Search, TerminalSquare, BarChart3, ChevronRight, Layers, FileChartColumn, NotebookPen } from "lucide-react";
import type { TabId } from "../AppTabBar";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { SettingsModal } from "../SettingsModal";

interface Props {
  activeTab: TabId;
  onSelect: (tab: TabId) => void;
  onBrowse: () => void;
  onManage: () => void;
  perspectiveOpen: boolean;
  busyTabs: Partial<Record<TabId, boolean>>;
}

const destinations = [
  { tab: "askai", label: "Ask", icon: Sparkles },
  { tab: "catalog", label: "Explore", icon: Database },
  { tab: "editor", label: "SQL", icon: FileCode2 },
  { tab: "reports", label: "Library", icon: Library },
] as const;

export function MobileNavigation({ activeTab, onSelect, onBrowse, onManage, perspectiveOpen, busyTabs }: Props) {
  const [more, setMore] = useState(false);
  const inLibrary = activeTab === "reports" || activeTab === "notebooks";
  const choose = (tab: TabId) => { setMore(false); onSelect(tab); };
  return <>
    <nav className="mobile-bottom-nav" aria-label="Workspace" data-testid="mobile-navigation">
      {destinations.map(({ tab, label, icon: Icon }) => {
        const active = tab === "reports" ? inLibrary : activeTab === tab;
        const busy = tab === "reports" ? busyTabs.notebooks : busyTabs[tab];
        return <button key={tab} type="button" aria-current={active ? "page" : undefined}
          className={`mobile-destination ${active ? "is-active" : ""}`}
          data-testid={tab === "reports" ? "mobile-tab-library" : `tab-${tab}`}
          onClick={() => choose(tab === "reports" && inLibrary ? activeTab : tab)}>
          <span className="mobile-destination-icon"><Icon size={20} strokeWidth={1.8} />{busy && <span className="mobile-busy" aria-label="Working" />}</span>
          <span>{label}</span>
        </button>;
      })}
      <button type="button" className={`mobile-destination ${activeTab === "shell" || activeTab === "perspective" ? "is-active" : ""}`}
        aria-haspopup="dialog" aria-expanded={more} onClick={() => setMore(true)} data-testid="mobile-more">
        <span className="mobile-destination-icon"><Ellipsis size={22} /></span><span>More</span>
      </button>
    </nav>
    <Dialog open={more} onOpenChange={setMore}>
      <DialogContent className="mobile-more-sheet">
        <DialogHeader><DialogTitle>Your workspace</DialogTitle><DialogDescription>More ways to work with your data.</DialogDescription></DialogHeader>
        <div className="mobile-tool-list">
          <button onClick={() => choose("shell")} data-testid="tab-shell"><TerminalSquare /><span>SQL shell<small>The full DuckDB terminal</small></span><ChevronRight /></button>
          {perspectiveOpen && <button onClick={() => choose("perspective")} data-testid="tab-perspective"><BarChart3 /><span>Pivot exploration<small>Return to your open Perspective view</small></span><ChevronRight /></button>}
          <button onClick={() => { setMore(false); onBrowse(); }}><Search /><span>Browse catalog<small>Tables, views, functions, and saved work</small></span><ChevronRight /></button>
          <button onClick={() => { setMore(false); onManage(); }}><Layers /><span>Manage workspaces<small>Connections and workspace files</small></span><ChevronRight /></button>
        </div>
        <div className="mobile-settings-link"><SettingsModal /></div>
      </DialogContent>
    </Dialog>
  </>;
}

export function MobileLibraryTabs({ activeTab, onSelect }: Pick<Props, "activeTab" | "onSelect">) {
  const library = activeTab === "reports" || activeTab === "notebooks";
  if (!library) return null;
  return <div className="mobile-library-tabs" aria-label="Library contents">
      <button aria-pressed={activeTab === "reports"} onClick={() => onSelect("reports")} data-testid="tab-reports"><FileChartColumn size={16} />Reports</button>
      <button aria-pressed={activeTab === "notebooks"} onClick={() => onSelect("notebooks")} data-testid="tab-notebooks"><NotebookPen size={16} />Notebooks</button>
  </div>;
}
