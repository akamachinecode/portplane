// Keyboard helpers for global shortcuts. No single-key shortcut may fire
// while the user types (plan §6.3).

const TEXT_INPUTS = new Set(["text", "search", "email", "url", "password", "number", "tel", "date", "datetime-local", "month", "time", "week"]);

interface ElementLike {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
}

/** The key event comes from a place where the user types text. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as ElementLike | null;
  if (!el || typeof el.tagName !== "string") return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  return tag === "INPUT" && TEXT_INPUTS.has((el.type ?? "text").toLowerCase());
}

interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Ctrl+K (⌘K on macOS) or a bare "/": opens the command palette. */
export function isPaletteShortcut(e: KeyLike, mac: boolean): boolean {
  if (e.altKey) return false;
  if (e.key === "/" && !e.ctrlKey && !e.metaKey) return true;
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return mod && !e.shiftKey && e.key.toLowerCase() === "k";
}

/** macOS, from the binary's GOOS, or from the browser until that is known. */
export function isMac(os: string | undefined): boolean {
  if (os) return os === "darwin";
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/** "⌘K" on macOS, "Ctrl K" elsewhere. */
export function paletteShortcutLabel(mac: boolean): string {
  return mac ? "⌘K" : "Ctrl K";
}
