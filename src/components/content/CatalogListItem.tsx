import type { ComponentType, ReactNode } from "react";
import { ChevronRight } from "lucide-react";

interface Props {
  icon: ComponentType<{ className?: string }>;
  iconClassName?: string;
  title: string;
  description?: string;
  badge?: string;
  rightLabel?: string;
  onClick?: () => void;
}

export function CatalogListItem({ icon: Icon, iconClassName, title, description, badge, rightLabel, onClick }: Props) {
  return (
    <button
      className="flex items-center justify-between w-full px-4 py-3 rounded-lg border border-border bg-card hover:border-primary/30 hover:bg-accent/5 transition-colors text-left group cursor-pointer"
      onClick={onClick}
    >
      <div className="flex items-start gap-3 min-w-0">
        <Icon className={`h-5 w-5 shrink-0 mt-0.5 ${iconClassName ?? "text-muted-foreground"}`} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm">{title}</span>
            {badge && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-medium">{badge}</span>
            )}
          </div>
          {description && (
            <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{description}</p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0 ml-3">
        {rightLabel && (
          <span className="text-xs text-muted-foreground">{rightLabel}</span>
        )}
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/30 group-hover:text-primary shrink-0 transition-colors" />
      </div>
    </button>
  );
}
