import { useSyncExternalStore } from "react";

// Whether the sidebar is folded to icons. A per-browser convenience, kept in
// localStorage; the palette can toggle it too.

const KEY = "portplane.sidebar";
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "collapsed";
  } catch {
    return false;
  }
}

let collapsed = typeof window === "undefined" ? false : read();

export function setSidebarCollapsed(next: boolean): void {
  collapsed = next;
  try {
    localStorage.setItem(KEY, next ? "collapsed" : "expanded");
  } catch {
    // storage blocked: it lasts until the page reloads
  }
  for (const l of listeners) l();
}

export function isSidebarCollapsed(): boolean {
  return collapsed;
}

export function useSidebarCollapsed(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => collapsed,
  );
}
