import { Check } from "lucide-react";

interface Props {
  question: string;
  options: string[];
  selectedIndex?: number;
  resolved: boolean;
  onSelect?: (option: string, index: number) => void;
}

export function AskUserBlock({ question, options, selectedIndex, resolved, onSelect }: Props) {
  return (
    <div className="space-y-2">
      <p className="font-semibold text-sm">{question}</p>
      <div className="flex flex-col gap-1.5">
        {options.map((opt, i) => {
          const isSelected = selectedIndex === i;
          return (
            <button
              key={i}
              disabled={resolved}
              onClick={() => onSelect?.(opt, i)}
              aria-pressed={isSelected}
              className={`text-left w-full px-3 py-2 rounded-lg border text-sm transition-colors ${
                isSelected
                  ? "bg-primary/10 border-primary text-primary font-medium"
                  : resolved
                  ? "opacity-40 border-border cursor-not-allowed"
                  : "border-border hover:border-primary/30 hover:bg-accent/5 cursor-pointer"
              }`}
            >
              <span className="flex items-center gap-2">
                {isSelected && <Check className="h-3.5 w-3.5 shrink-0" />}
                {opt}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
