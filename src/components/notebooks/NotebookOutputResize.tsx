import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

/** Resize locally while dragging; commit once so one Undo restores the previous size. */
export function NotebookOutputResize({
  height,
  onChange,
  children,
  label,
}: {
  height: number;
  onChange: (height: number) => void;
  children: (height: number) => ReactNode;
  label: string;
}) {
  const hintId = useId();
  const [preview, setPreview] = useState<number | null>(null);
  const drag = useRef<{ y: number; height: number; value: number } | null>(null);
  useEffect(() => {
    setPreview(null);
  }, [height]);
  const bound = (value: number) => Math.round(Math.max(240, Math.min(4000, value)));
  const shown = preview ?? height;
  return (
    <>
      <div style={{ height: shown }} data-testid="notebook-table-viewport" className="min-w-0 overflow-auto">
        {children(shown)}
      </div>
      <div
        role="separator"
        aria-label={`Resize ${label}`}
        aria-orientation="horizontal"
        aria-valuemin={240}
        aria-valuemax={4000}
        aria-valuenow={shown}
        aria-valuetext={`${shown} pixels`}
        aria-describedby={hintId}
        tabIndex={0}
        title="Drag to resize output. Use Up and Down arrow keys for smaller adjustments."
        className="group relative flex h-6 sm:h-3 cursor-row-resize touch-none items-center justify-center hover:bg-muted focus-visible:outline focus-visible:outline-ring"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          drag.current = { y: event.clientY, height: shown, value: shown };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          drag.current.value = bound(drag.current.height + event.clientY - drag.current.y);
          setPreview(drag.current.value);
        }}
        onPointerUp={(event) => {
          if (!drag.current) return;
          const value = drag.current.value;
          drag.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
          setPreview(null);
          onChange(value);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setPreview(null);
        }}
        onLostPointerCapture={() => {
          drag.current = null;
          setPreview(null);
        }}
        onKeyDown={(event) => {
          const value =
            event.key === 'ArrowDown'
              ? shown + 32
              : event.key === 'ArrowUp'
                ? shown - 32
                : event.key === 'Home'
                  ? 240
                  : event.key === 'End'
                    ? 4000
                    : null;
          if (value === null) return;
          event.preventDefault();
          onChange(bound(value));
        }}
      >
        <span
          id={hintId}
          className="sr-only group-focus-visible:not-sr-only group-focus-visible:absolute group-focus-visible:bottom-full group-focus-visible:right-2 group-focus-visible:z-10 group-focus-visible:rounded group-focus-visible:bg-popover group-focus-visible:px-2 group-focus-visible:py-1 group-focus-visible:text-xs group-focus-visible:shadow"
        >
          Drag to resize. Up and Down arrows adjust height.
        </span>
        <span className="h-0.5 w-8 rounded-full bg-border group-hover:bg-muted-foreground" />
      </div>
    </>
  );
}
