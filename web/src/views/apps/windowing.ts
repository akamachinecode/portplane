import { useCallback, useLayoutEffect, useRef, useState } from "react";

// Long tables render only the rows near the screen (plan §6.6: from 200
// rows). Every row has the same height and the page itself scrolls, so the
// visible range follows from the table's position.

/** Lists this long or longer are windowed. */
export const WINDOW_FROM = 200;

/** The rows to render: those on screen, plus overscan above and below. */
export function visibleRange(count: number, rowHeight: number, top: number, viewport: number, overscan = 12): { start: number; end: number } {
  if (count === 0 || rowHeight <= 0) return { start: 0, end: 0 };
  const first = Math.floor(-top / rowHeight);
  const last = Math.ceil((viewport - top) / rowHeight);
  const start = Math.min(count, Math.max(0, first - overscan));
  const end = Math.max(start, Math.min(count, last + overscan));
  return { start, end };
}

export interface Windowed {
  ref: React.RefObject<HTMLTableSectionElement | null>;
  start: number;
  end: number;
  padTop: number;
  padBottom: number;
  /** Scrolls the page so row i is on screen. */
  scrollToIndex(i: number): void;
}

export function useWindowed(count: number, rowHeight: number): Windowed {
  const enabled = count >= WINDOW_FROM;
  const ref = useRef<HTMLTableSectionElement>(null);
  const [range, setRange] = useState(() => ({ start: 0, end: enabled ? Math.min(count, 60) : count }));

  useLayoutEffect(() => {
    if (!enabled) {
      setRange((r) => (r.start === 0 && r.end === count ? r : { start: 0, end: count }));
      return;
    }
    let frame = 0;
    const update = () => {
      frame = 0;
      const el = ref.current;
      if (!el) return;
      const next = visibleRange(count, rowHeight, el.getBoundingClientRect().top, window.innerHeight);
      setRange((r) => (r.start === next.start && r.end === next.end ? r : next));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [enabled, count, rowHeight]);

  const scrollToIndex = useCallback(
    (i: number) => {
      const el = ref.current;
      if (!el) return;
      const rowTop = el.getBoundingClientRect().top + i * rowHeight;
      const margin = 96; // the top bar and the sticky table head
      if (rowTop < margin) window.scrollBy({ top: rowTop - margin });
      else if (rowTop + rowHeight > window.innerHeight - 24) window.scrollBy({ top: rowTop + rowHeight - window.innerHeight + 24 });
    },
    [rowHeight],
  );

  const start = enabled ? range.start : 0;
  const end = enabled ? Math.min(range.end, count) : count;
  return { ref, start, end, padTop: start * rowHeight, padBottom: (count - end) * rowHeight, scrollToIndex };
}
