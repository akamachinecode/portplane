import { useRef, type ReactNode } from "react";
import { useModal } from "./Dialog";

/**
 * A modal panel on the right (a full-screen sheet on a phone). Esc and a
 * click outside close it; focus stays inside while it is open and goes back
 * where it was afterwards. Mark the element that should get focus first
 * with data-autofocus.
 */
export function Drawer({ labelledBy, onClose, children }: { labelledBy: string; onClose(): void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useModal(ref, true);
  return (
    <dialog
      ref={ref}
      className="drawer"
      aria-labelledby={labelledBy}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="drawer-frame">{children}</div>
    </dialog>
  );
}
