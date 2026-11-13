import { useId, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { Icon, Spinner } from "./Icon";

// Open modal dialogs, in opening order. Everything outside the topmost one
// is inert and under its backdrop, so toasts render inside it (see Toasts).
let openDialogs: HTMLDialogElement[] = [];
const dialogListeners = new Set<() => void>();

function setOpenDialogs(next: HTMLDialogElement[]) {
  openDialogs = next;
  for (const l of dialogListeners) l();
}

/** The topmost open modal dialog, or null. */
export function useTopDialog(): HTMLDialogElement | null {
  return useSyncExternalStore(
    (l) => {
      dialogListeners.add(l);
      return () => dialogListeners.delete(l);
    },
    () => openDialogs[openDialogs.length - 1] ?? null,
  );
}

/**
 * Shows a <dialog> as a modal while `open` and keeps the stack of open modals
 * (for useTopDialog). When it closes or unmounts, focus goes back to where it
 * was before it opened, if that is still on the page.
 */
export function useModal(ref: RefObject<HTMLDialogElement | null>, open: boolean): void {
  const opener = useRef<Element | null>(null);
  useLayoutEffect(() => {
    const d = ref.current;
    if (!d || !open) return;
    opener.current = document.activeElement;
    if (!d.open) d.showModal();
    // The browser focuses the first control; an element marked
    // data-autofocus (a title, a search field) can ask for it instead.
    d.querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true });
    setOpenDialogs([...openDialogs.filter((x) => x !== d), d]);
    return () => {
      setOpenDialogs(openDialogs.filter((x) => x !== d));
      if (d.open) d.close();
      const back = opener.current;
      if (back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true });
    };
  }, [ref, open]);
}

interface Props {
  open: boolean;
  onClose(): void;
  title: ReactNode;
  /** Under the title row, e.g. the setup steps. */
  head?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "full";
  /**
   * Esc and a click on the backdrop close the dialog. Turn it off while a
   * request that can't be undone runs, or where edits would be lost.
   */
  dismissable?: boolean;
  children: ReactNode;
}

/** A modal on the native <dialog>: focus trapping, Esc and the top layer come free. */
export function Dialog({ open, onClose, title, head, footer, size = "md", dismissable = true, children }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useModal(ref, open);

  return (
    <dialog
      ref={ref}
      className={`dialog dialog-${size}`}
      aria-labelledby={titleId}
      onCancel={(e) => {
        // Esc: React gets this before the dialog closes itself
        e.preventDefault();
        if (dismissable) onClose();
      }}
      onClose={(e) => {
        // A close event queued by an earlier close() (React's dev double
        // mount closes and reopens a dialog that mounts open) arrives while
        // the dialog is open again: ignore it.
        if (open && !e.currentTarget.open) onClose();
      }}
      onClick={(e) => {
        // a click on the backdrop lands on the dialog element itself
        if (dismissable && e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog-frame">
        <header className="dialog-head">
          <h2 id={titleId} className="dialog-title">
            {title}
          </h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        {head}
        <div className="dialog-main">{children}</div>
        {footer && <footer className="dialog-foot">{footer}</footer>}
      </div>
    </dialog>
  );
}

/** Asks before something that can't be undone. */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  busy,
  error,
  onConfirm,
  onClose,
  tone = "danger",
}: {
  open: boolean;
  title: ReactNode;
  children: ReactNode;
  confirmLabel: string;
  /** Red for what removes or stops something; the main colour for a confirmation that doesn't (restart, upgrade). */
  tone?: "danger" | "primary";
  busy: boolean;
  error: string | null;
  onConfirm(): void;
  onClose(): void;
}) {
  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      title={title}
      size="sm"
      dismissable={!busy}
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className={tone === "danger" ? "btn btn-danger" : "btn btn-primary"} onClick={onConfirm} disabled={busy} aria-busy={busy || undefined}>
            {busy && <Spinner />}
            {confirmLabel}
          </button>
        </>
      }
    >
      {children}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
