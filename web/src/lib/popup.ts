// Opening a URL that is only known after a request (a remote port's tunnel).
// Browsers allow window.open only during the click, so the window opens blank
// first and gets its address when the request returns.

/** The bits of a Window this needs, so tests can pass a fake. */
export interface PopupWindow {
  opener: unknown;
  location: { href: string };
  document?: { title: string; body: { textContent: string | null } | null };
  close(): void;
}

export interface PopupDeps {
  /** window.open("", "_blank"); null when blocked. */
  open(): PopupWindow | null;
  /** Fallback when no window could be opened: ask Portplane to open the URL itself. */
  openElsewhere(url: string): Promise<void>;
}

/**
 * Call synchronously from a click handler. Resolves with the URL that was
 * opened; rejects (after closing the blank window) when resolve fails.
 */
export async function openResolved(resolve: () => Promise<string>, deps: PopupDeps, waitingText = "Opening…"): Promise<string> {
  const win = deps.open();
  if (win) {
    try {
      if (win.document) {
        win.document.title = waitingText;
        if (win.document.body) win.document.body.textContent = waitingText;
      }
    } catch {
      // a cross-origin or locked-down window: it just stays blank
    }
  }
  let url: string;
  try {
    url = await resolve();
  } catch (err) {
    win?.close();
    throw err;
  }
  if (win) {
    win.opener = null; // the opened page must not reach back into Portplane
    win.location.href = url;
  } else {
    await deps.openElsewhere(url);
  }
  return url;
}
