import type { View } from "./router";

// Single-key shortcuts (plan §6.3): j/k or the arrows move in a list,
// Enter opens the details, s starts or stops, r restarts, o opens, c copies
// the URL, x selects, / searches, ? lists them all, and g then a letter goes
// to a view. None fires while the user types (lib/keyboard.ts).

interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export type ListAction =
  | { kind: "move"; delta: 1 | -1 }
  | { kind: "first" }
  | { kind: "last" }
  | { kind: "details" }
  | { kind: "toggle" }
  | { kind: "restart" }
  | { kind: "open" }
  | { kind: "copy" }
  | { kind: "select"; range: boolean }
  | { kind: "pin" }
  | { kind: "search" }
  | { kind: "clear" };

/** What a key does in a list, or null when it is not a list shortcut. */
export function listAction(e: KeyLike): ListAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  switch (e.key) {
    case "j":
    case "ArrowDown":
      return { kind: "move", delta: 1 };
    case "k":
    case "ArrowUp":
      return { kind: "move", delta: -1 };
    case "Home":
      return { kind: "first" };
    case "End":
      return { kind: "last" };
    case "Enter":
      return { kind: "details" };
    case "s":
      return { kind: "toggle" };
    case "r":
      return { kind: "restart" };
    case "o":
      return { kind: "open" };
    case "c":
      return { kind: "copy" };
    case "x":
    case "X":
      return { kind: "select", range: e.shiftKey };
    case "f":
      return { kind: "pin" };
    case "/":
      return { kind: "search" };
    case "Escape":
      return { kind: "clear" };
  }
  return null;
}

/** g, then one of these letters, goes to a view. */
export const GO_KEYS: Record<string, Exclude<View, "onboarding" | "project">> = {
  a: "apps",
  c: "projects",
  d: "domains",
  r: "runners",
  m: "machines",
  h: "health",
  s: "settings",
};

export type GlobalAction = { kind: "help" } | { kind: "go"; view: Exclude<View, "onboarding" | "project"> } | { kind: "pending" };

/** How long after g the second key counts. */
export const CHORD_TIMEOUT = 1500;

/**
 * The shortcuts that work anywhere: ? and the g chords. It remembers a g
 * between calls; "pending" means the key started a chord and nothing else
 * should handle it.
 */
export function createGlobalKeys(timeout = CHORD_TIMEOUT) {
  let gAt = -Infinity;
  return (e: KeyLike, now: number): GlobalAction | null => {
    if (e.ctrlKey || e.metaKey || e.altKey) {
      gAt = -Infinity;
      return null;
    }
    if (now - gAt <= timeout) {
      gAt = -Infinity;
      const view = GO_KEYS[e.key];
      return view ? { kind: "go", view } : null;
    }
    if (e.key === "?") return { kind: "help" };
    if (e.key === "g") {
      gAt = now;
      return { kind: "pending" };
    }
    return null;
  };
}

export interface Shortcut {
  keys: string[];
  /** How the keys go together: pressed at once (+), one after the other, or either. */
  join?: "+" | "then" | "or";
  label: string;
}

export interface ShortcutGroup {
  title: string;
  items: Shortcut[];
}

/** The ? dialog. */
export function shortcutGroups(mac: boolean): ShortcutGroup[] {
  return [
    {
      title: "Anywhere",
      items: [
        { keys: [mac ? "⌘" : "Ctrl", "K"], label: "Search or run a command" },
        { keys: ["?"], label: "Show these shortcuts" },
        { keys: ["Esc"], label: "Close a dialog, the details or the selection" },
      ],
    },
    {
      title: "Go to",
      items: Object.entries(GO_KEYS).map(([k, view]) => ({ keys: ["g", k], join: "then" as const, label: VIEW_NAMES[view] })),
    },
    {
      title: "Apps list",
      items: [
        { keys: ["j", "k"], join: "or", label: "Next or previous app (or ↓ ↑)" },
        { keys: ["Enter"], label: "Show details" },
        { keys: ["s"], label: "Start or stop" },
        { keys: ["r"], label: "Restart" },
        { keys: ["o"], label: "Open in the browser" },
        { keys: ["c"], label: "Copy the URL" },
        { keys: ["x"], label: "Select (Shift+X selects a range)" },
        { keys: ["f"], label: "Pin or unpin" },
        { keys: ["/"], label: "Search the apps" },
      ],
    },
  ];
}

const VIEW_NAMES: Record<Exclude<View, "onboarding" | "project">, string> = {
  apps: "Apps",
  projects: "dekit configuration",
  domains: "Domains",
  runners: "Runners",
  machines: "Machines",
  health: "Health",
  settings: "Settings",
};

/** A tooltip with its shortcut: "Start web (S)". */
export function withShortcut(label: string, key: string): string {
  return `${label} (${key.length === 1 ? key.toUpperCase() : key})`;
}
