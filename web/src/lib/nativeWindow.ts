// The macOS window has no visible title bar (ADR-0027): the page runs from
// the window's top edge and the traffic lights sit over the sidebar. The
// window marks <html> with data-window="mac" (and data-fullscreen while in
// full screen) and sets --titlebar-h and --traffic-w, so the CSS leaves room
// for them. A WKWebView has no -webkit-app-region, so the page asks the
// window to move or zoom through a script message instead: a mouse-down on
// an element inside [data-drag-region], unless it lands on something you can
// click or type in, starts a window drag; a double-click zooms.

interface Bridge {
  postMessage(message: "drag" | "zoom"): void;
}

function bridge(): Bridge | null {
  const w = window as unknown as { webkit?: { messageHandlers?: { portplane?: Bridge } } };
  return w.webkit?.messageHandlers?.portplane ?? null;
}

/** The page is in the macOS window, which draws no title bar of its own. */
export function hasInsetTitlebar(doc: Document = document): boolean {
  return doc.documentElement.dataset.window === "mac";
}

// Clicks on these keep their own meaning inside a drag region.
const INTERACTIVE = 'a[href], button, input, select, textarea, label, summary, [role="button"], [role="tab"], [role="menuitem"], [role="option"], [contenteditable=""], [contenteditable="true"], [data-no-drag]';

interface Closest {
  closest(selector: string): unknown;
}

/** What a mouse-down on target asks of the window, if anything. */
export function dragIntent(target: unknown, button: number, clicks: number): "drag" | "zoom" | null {
  if (button !== 0 || !target || typeof (target as Closest).closest !== "function") return null;
  const el = target as Closest;
  if (!el.closest("[data-drag-region]") || el.closest(INTERACTIVE)) return null;
  return clicks >= 2 ? "zoom" : "drag";
}

/** Listens for mouse-downs on drag regions; returns the cleanup. Does nothing outside the macOS window. */
export function installWindowDrag(doc: Document = document): () => void {
  const onDown = (e: MouseEvent) => {
    const b = bridge();
    if (!b || doc.documentElement.dataset.fullscreen === "true") return;
    const intent = dragIntent(e.target, e.button, e.detail);
    if (!intent) return;
    e.preventDefault(); // no text selection while the window moves
    b.postMessage(intent);
  };
  doc.addEventListener("mousedown", onDown);
  return () => doc.removeEventListener("mousedown", onDown);
}
