import { useEffect, useRef } from "react";
import { listAction, type ListAction } from "../../lib/shortcuts";
import { shortcutsBlocked } from "../../shell/useGlobalKeys";

/**
 * The Apps list's single-key shortcuts. The handler returns true when it
 * used the key. Listens on the document, so it runs before the shell's own
 * keys (which listen on the window) and can take "/" for the list's search.
 */
export function useListKeys(enabled: boolean, handler: (action: ListAction, e: KeyboardEvent) => boolean): void {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const action = listAction(e);
      if (!action) return;
      // Esc in the search field clears it: the field handles it itself.
      if (shortcutsBlocked(e.target)) return;
      if (e.repeat && action.kind !== "move") return;
      if (latest.current(action, e)) e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [enabled]);
}

/** The key event's target is a link, button or field, which Enter activates by itself. */
export function isInteractive(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest("a[href], button, input, select, textarea, summary, [role='button']");
}
