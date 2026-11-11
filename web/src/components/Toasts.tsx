import type { Toast } from "../hooks/useToasts";
import { Icon } from "./Icon";

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss(id: number): void }) {
  return (
    <div className="toasts" aria-live="polite" aria-relevant="additions">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === "error" ? "alert" : "status"}>
          <Icon name={t.kind === "error" ? "warning" : "check"} size={15} className="toast-icon" />
          <span className="toast-text">{t.text}</span>
          <button type="button" className="icon-btn icon-btn-sm" aria-label="Dismiss" onClick={() => onDismiss(t.id)}>
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
