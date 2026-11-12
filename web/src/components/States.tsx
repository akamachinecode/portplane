import type { ReactNode } from "react";
import { Icon, Spinner, type IconName } from "./Icon";

// The three states every screen has besides its content.

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="state state-loading" role="status">
      <Spinner />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: IconName; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="state state-empty">
      {icon && (
        <span className="state-icon" aria-hidden="true">
          <Icon name={icon} size={20} />
        </span>
      )}
      <p className="state-title">{title}</p>
      {children && <div className="state-text">{children}</div>}
      {action && <div className="state-action">{action}</div>}
    </div>
  );
}

export function ErrorState({ title, message, onRetry }: { title: ReactNode; message?: string; onRetry?: () => void }) {
  return (
    <div className="state state-error" role="alert">
      <span className="state-icon" aria-hidden="true">
        <Icon name="warning" size={20} />
      </span>
      <p className="state-title">{title}</p>
      {message && <p className="state-text">{message}</p>}
      {onRetry && (
        <div className="state-action">
          <button type="button" className="btn" onClick={onRetry}>
            <Icon name="restart" size={14} />
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
