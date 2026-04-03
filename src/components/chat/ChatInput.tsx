import { useRef, useEffect, type KeyboardEvent } from "react";
import { SendHorizontal, Square } from "lucide-react";

interface Props {
  onSend: (message: string) => void;
  onStop?: () => void;
  isLoading?: boolean;
  disabled?: boolean;
  placeholder?: string;
  focused?: boolean;
}

export function ChatInput({ onSend, onStop, isLoading, disabled, placeholder = "Ask a question about your data...", focused }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Focus when tab becomes active
  useEffect(() => {
    if (focused) ref.current?.focus();
  }, [focused]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
    if (e.key === "Escape" && isLoading) {
      e.preventDefault();
      onStop?.();
    }
  };

  const submit = () => {
    const val = ref.current?.value.trim();
    if (!val || isLoading) return;
    onSend(val);
    if (ref.current) ref.current.value = "";
    autoResize();
  };

  const autoResize = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  };

  return (
    <div className="border-t border-border bg-background px-6 py-3">
      <div className="flex items-end gap-2 border border-border rounded-lg bg-card px-3 py-1.5 focus-within:border-primary/40 focus-within:ring-1 focus-within:ring-primary/20 transition-colors">
        <textarea
          ref={ref}
          className="flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground/50 min-h-[36px] max-h-[120px] py-1.5"
          placeholder={placeholder}
          aria-label="Chat message input"
          rows={1}
          disabled={disabled}
          onKeyDown={handleKeyDown}
          onInput={autoResize}
        />
      {isLoading ? (
        <button
          onClick={onStop}
          className="shrink-0 p-2 rounded-md bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors"
          title="Stop (Escape)"
          aria-label="Stop generation"
        >
          <Square className="h-4 w-4" />
        </button>
      ) : (
        <button
          onClick={submit}
          disabled={disabled}
          className="shrink-0 p-2 rounded-md bg-primary text-primary-foreground hover:bg-accent transition-colors disabled:opacity-30"
          title="Send (Enter)"
          aria-label="Send message"
        >
          <SendHorizontal className="h-4 w-4" />
        </button>
      )}
      </div>
      <div className="text-[10px] text-muted-foreground/40 mt-1.5 text-center">
        Press Enter to send · Shift+Enter for new line · Escape to stop
      </div>
    </div>
  );
}
