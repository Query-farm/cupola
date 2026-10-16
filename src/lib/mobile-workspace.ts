import { useEffect } from "react";
import type { TabId } from "@/components/AppTabBar";

const views: TabId[] = ["catalog", "editor", "askai", "reports", "notebooks", "shell", "perspective"];

/** Keep mobile destinations addressable without replacing object/report URLs. */
export function mobileViewFromUrl(): TabId | null {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get("view") as TabId;
  return views.includes(value) ? value : null;
}

export function useMobileWorkspace(activeTab: TabId, mobile: boolean, onSelect: (tab: TabId) => void) {
  useEffect(() => {
    // A mobile link keeps its destination current after rotating to a wider layout.
    if (!mobile && !mobileViewFromUrl()) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("view") !== activeTab) {
      url.searchParams.set("view", activeTab);
      window.history.replaceState(window.history.state, "", url);
    }
  }, [activeTab, mobile]);

  useEffect(() => {
    const restore = () => {
      const view = mobileViewFromUrl();
      if (view) onSelect(view);
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [onSelect]);

  useEffect(() => {
    if (!mobile) return;
    const viewport = window.visualViewport;
    const root = document.documentElement;
    const update = () => {
      // Do not resize the application when the reader pinch-zooms.
      if (viewport && viewport.scale !== 1) return;
      const height = viewport?.height ?? window.innerHeight;
      root.style.setProperty("--cupola-viewport-height", `${height}px`);
      root.style.setProperty("--cupola-viewport-top", `${viewport?.offsetTop ?? 0}px`);
      root.style.setProperty("--cupola-viewport-bottom", `${Math.max(0, window.innerHeight - height - (viewport?.offsetTop ?? 0))}px`);
      const editing = document.activeElement?.matches("input, textarea, [contenteditable=true]");
      root.dataset.mobileKeyboard = String(Boolean(editing && window.innerHeight - height > 140));
    };
    update();
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    return () => {
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
      root.style.removeProperty("--cupola-viewport-height");
      root.style.removeProperty("--cupola-viewport-top");
      root.style.removeProperty("--cupola-viewport-bottom");
      delete root.dataset.mobileKeyboard;
    };
  }, [mobile]);

  return (tab: TabId) => {
    if (tab === activeTab) return;
    const url = new URL(window.location.href);
    url.searchParams.set("view", tab);
    window.history.pushState(window.history.state, "", url);
    onSelect(tab);
  };
}
