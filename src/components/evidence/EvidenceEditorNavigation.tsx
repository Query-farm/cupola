import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Database, FileText, Gauge, Network, Palette, SlidersHorizontal, Sparkles, Table2 } from 'lucide-react';
import { TabsList, TabsTrigger } from '../ui/tabs';

const sections = [
  { value: 'agent', label: 'Chat', icon: Sparkles },
  { value: 'document', label: 'Code', icon: FileText },
  { value: 'data', label: 'Data', icon: Database },
  { value: 'model', label: 'Model', icon: Network },
  { value: 'browser', label: 'Browse data', icon: Table2 },
  { value: 'appearance', label: 'Appearance', icon: Palette },
  { value: 'parameters', label: 'Parameters', icon: SlidersHorizontal },
  { value: 'performance', label: 'Performance', icon: Gauge },
];

/** Keep every editor section reachable without making the toolbar taller. */
export function EvidenceEditorNavigation({ selected }: { selected: string }) {
  const viewport = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ overflow: false, left: false, right: false });
  function measure() {
    const element = viewport.current;
    if (!element) return;
    const next = { overflow: element.scrollWidth > element.clientWidth + 1, left: element.scrollLeft > 1, right: element.scrollLeft + element.clientWidth < element.scrollWidth - 1 };
    setEdges(previous => previous.overflow === next.overflow && previous.left === next.left && previous.right === next.right ? previous : next);
  }
  function revealSelected() {
    const element = viewport.current;
    const active = list.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!element || !active) return;
    const bounds = element.getBoundingClientRect();
    const tab = active.getBoundingClientRect();
    if (tab.left < bounds.left) element.scrollLeft -= bounds.left - tab.left;
    else if (tab.right > bounds.right) element.scrollLeft += tab.right - bounds.right;
    measure();
  }
  useEffect(() => {
    const observer = new ResizeObserver(() => { measure(); revealSelected(); });
    if (viewport.current) observer.observe(viewport.current);
    if (list.current) observer.observe(list.current);
    return () => observer.disconnect();
  }, []);
  useEffect(revealSelected, [selected, edges.overflow]);
  function scroll(direction: number) {
    const element = viewport.current;
    if (element) element.scrollBy({ left: direction * element.clientWidth * 0.75, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }
  const arrowClass = 'flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-25 disabled:pointer-events-none';
  return <div className="mx-3 mb-3 flex min-w-0 shrink-0 items-center gap-1 border-b" data-testid="evidence-editor-navigation">
    {edges.overflow && <button type="button" aria-label="Show earlier editor tabs" title="Show earlier editor tabs" className={arrowClass} disabled={!edges.left} onClick={() => scroll(-1)}><ChevronLeft className="size-4" /></button>}
    <div ref={viewport} className="min-w-0 flex-1 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" onScroll={measure}>
      <TabsList ref={list} aria-label="Report editing tools" variant="line" className="h-11! w-max min-w-full flex-nowrap justify-start gap-0 rounded-none p-0">
        {sections.map(({ value, label, icon: Icon }) => <TabsTrigger key={value} value={value} title={label} className="h-11 flex-none gap-1.5 rounded-none border-0 border-b-2 border-transparent px-3 text-xs after:hidden data-active:border-primary data-active:text-primary focus-visible:ring-inset">
          <Icon className="size-3.5" />{label}
        </TabsTrigger>)}
      </TabsList>
    </div>
    {edges.overflow && <button type="button" aria-label="Show later editor tabs" title="Show later editor tabs" className={arrowClass} disabled={!edges.right} onClick={() => scroll(1)}><ChevronRight className="size-4" /></button>}
  </div>;
}
