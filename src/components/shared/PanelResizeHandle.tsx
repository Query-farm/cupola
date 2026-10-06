import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

/** A right-hand panel's width, with per-surface persistence and bounded resizing. */
export function usePanelWidth(storageKey: string, initial = 400, min = 320, max = 720) {
  const [width, setWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey));
      return Number.isFinite(saved) && saved >= min && saved <= max ? saved : initial;
    } catch {
      return initial;
    }
  });
  const current = useRef(width);
  const cleanup = useRef<(() => void) | null>(null);
  const persist = () => {
    try {
      localStorage.setItem(storageKey, String(current.current));
    } catch {}
  };
  const resize = (value: number) => {
    current.current = Math.max(min, Math.min(max, value));
    setWidth(current.current);
  };
  useEffect(() => () => cleanup.current?.(), []);
  function onResizeStart(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    cleanup.current?.();
    const startX = event.clientX,
      startWidth = current.current;
    const target = event.currentTarget,
      pointerId = event.pointerId;
    target.setPointerCapture(pointerId);
    const move = (e: globalThis.PointerEvent) => {
      if (e.pointerId === pointerId) resize(startWidth - (e.clientX - startX));
    };
    const end = (e: globalThis.PointerEvent) => {
      if (e.pointerId === pointerId) {
        persist();
        cleanup.current?.();
      }
    };
    cleanup.current = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', end);
      target.removeEventListener('pointercancel', end);
      target.removeEventListener('lostpointercapture', end);
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
      cleanup.current = null;
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
    target.addEventListener('lostpointercapture', end);
  }
  function onResizeKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const value =
      event.key === 'Home'
        ? min
        : event.key === 'End'
          ? max
          : event.key === 'ArrowLeft'
            ? current.current + 16
            : event.key === 'ArrowRight'
              ? current.current - 16
              : null;
    if (value === null) return;
    event.preventDefault();
    resize(value);
    persist();
  }
  return { width, min, max, onResizeStart, onResizeKeyDown };
}

export function PanelResizeHandle({
  sizing,
  label,
  className = '',
}: {
  sizing: ReturnType<typeof usePanelWidth>;
  label: string;
  className?: string;
}) {
  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      tabIndex={0}
      aria-valuemin={sizing.min}
      aria-valuemax={sizing.max}
      aria-valuenow={sizing.width}
      onPointerDown={sizing.onResizeStart}
      onKeyDown={sizing.onResizeKeyDown}
      className={`w-1.5 shrink-0 touch-none cursor-col-resize bg-border hover:bg-accent/60 active:bg-accent focus-visible:outline focus-visible:outline-ring ${className}`}
    />
  );
}
