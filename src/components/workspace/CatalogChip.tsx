/**
 * A catalog's colour chip: a small square in one of eight colour-blind-safe
 * hues (`--catalog-chip-N` in global.css), carrying the alias's initial so
 * colour is never the only cue. Used on sidebar roots, in the workspace
 * picker, in the breadcrumb and on the welcome page's workspace cards.
 */
import type { ComponentType } from "react";
import { PALETTE_SIZE } from "@/lib/workspace/store";
import { cn } from "@/lib/utils";

export function chipInitial(alias: string): string {
  const letter = alias.replace(/^[^A-Za-z0-9]+/, "").charAt(0);
  return letter ? letter.toUpperCase() : "?";
}

export function chipStyle(color: number): React.CSSProperties {
  const n = ((Math.trunc(color) % PALETTE_SIZE) + PALETTE_SIZE) % PALETTE_SIZE;
  return { background: `var(--catalog-chip-${n})`, color: `var(--catalog-chip-${n}-fg)` };
}

export function CatalogChip({ alias, color, className, title }: { alias: string; color: number; className?: string; title?: string }) {
  return (
    <span
      aria-hidden={title ? undefined : true}
      title={title}
      data-testid="catalog-chip"
      data-color={color}
      className={cn("inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] text-[10px] font-bold leading-none select-none", className)}
      style={chipStyle(color)}
    >
      {chipInitial(alias)}
    </span>
  );
}

/** Several chips overlapped, for a workspace (the picker's trigger, cards). */
export function ChipStack({ catalogs, max = 3, className }: { catalogs: readonly { alias: string; color: number }[]; max?: number; className?: string }) {
  const shown = catalogs.slice(0, max);
  return (
    <span className={cn("inline-flex items-center", className)} aria-hidden="true">
      {shown.map((c, i) => <CatalogChip key={`${c.alias}-${i}`} alias={c.alias} color={c.color} className={i ? "-ml-1 ring-1 ring-card" : undefined} />)}
      {catalogs.length > max && <span className="ml-1 text-[10px] text-muted-foreground">+{catalogs.length - max}</span>}
    </span>
  );
}

const iconCache = new Map<string, ComponentType<{ className?: string }>>();

/** A tree-node icon component for a catalog root (`tree-view.tsx` renders
 *  icons as components). Cached, so a re-render keeps the same component. */
export function chipIcon(alias: string, color: number): ComponentType<{ className?: string }> {
  const key = `${alias}\u0000${color}`;
  let icon = iconCache.get(key);
  if (!icon) {
    const Chip = ({ className }: { className?: string }) => <CatalogChip alias={alias} color={color} className={cn(className, "h-4 w-4")} />;
    Chip.displayName = `CatalogChip(${alias})`;
    icon = Chip;
    iconCache.set(key, icon);
  }
  return icon;
}
