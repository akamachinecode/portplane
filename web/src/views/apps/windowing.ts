import { useCallback, useLayoutEffect, useRef, useState } from "react";

// Long tables render only the rows near the screen (plan §6.6: from 200
// rows). Every row has the same height and the view's panel scrolls (the
// window, outside the shell), so the visible range follows from the table's
// position in it.

/** What scrolls the table: the shell's panel, or the window. */
function scroller(el: Element | null): { target: EventTarget; top: number; height: number; scrollBy(dy: number): void } {
  const panel = el?.closest(".shell-body");
  if (panel instanceof HTMLElement) {
    const r = panel.getBoundingClientRect();
    return { target: panel, top: r.top, height: r.height, scrollBy: (dy) => panel.scrollBy({ top: dy }) };
  }
  return { target: window, top: 0, height: window.innerHeight, scrollBy: (dy) => window.scrollBy({ top: dy }) };
}

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
      const view = scroller(el);
      const next = visibleRange(count, rowHeight, el.getBoundingClientRect().top - view.top, view.height);
      setRange((r) => (r.start === next.start && r.end === next.end ? r : next));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    const target = scroller(ref.current).target;
    target.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      target.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [enabled, count, rowHeight]);

  const scrollToIndex = useCallback(
    (i: number) => {
      const el = ref.current;
      if (!el) return;
      const view = scroller(el);
      const rowTop = el.getBoundingClientRect().top - view.top + i * rowHeight;
      const margin = 96; // the toolbar and the sticky table head
      if (rowTop < margin) view.scrollBy(rowTop - margin);
      else if (rowTop + rowHeight > view.height - 24) view.scrollBy(rowTop + rowHeight - view.height + 24);
    },
    [rowHeight],
  );

  const start = enabled ? range.start : 0;
  const end = enabled ? Math.min(range.end, count) : count;
  return { ref, start, end, padTop: start * rowHeight, padBottom: (count - end) * rowHeight, scrollToIndex };
}
