import { useEffect } from "react";
import { isTypingTarget } from "../lib/keyboard";
import { createGlobalKeys } from "../lib/shortcuts";
import { navigate } from "../lib/router";
import { NAV, SETTINGS_NAV } from "./nav";

/** Something modal is up (a dialog, the palette) or a menu has focus: shortcuts wait. */
export function shortcutsBlocked(target: EventTarget | null): boolean {
  if (isTypingTarget(target)) return true;
  if (typeof document === "undefined") return false;
  if (document.querySelector("dialog[open]")) return true;
  const el = target instanceof Element ? target : null;
  return !!el?.closest('[role="menu"], [role="listbox"]');
}

/**
 * ? opens the shortcuts and g then a letter goes to a view, anywhere. It
 * listens in the capture phase, so a list's own keys (s, r) never see the
 * second key of a chord.
 */
export function useGlobalKeys(onHelp: () => void): void {
  useEffect(() => {
    const keys = createGlobalKeys();
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || shortcutsBlocked(e.target)) return;
      const action = keys(e, performance.now());
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      if (action.kind === "help") onHelp();
      if (action.kind === "go") {
        const item = [...NAV, SETTINGS_NAV].find((n) => n.view === action.view);
        if (item) navigate(item.route);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onHelp]);
}
