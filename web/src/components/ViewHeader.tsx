import type { ReactNode } from "react";

/** A view's title row: the page's one h1, a line of context and its actions. */
export function ViewHeader({ title, description, actions, children }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <header className="view-head">
      <div className="view-head-text">
        {/* focused after a view change, so screen readers announce it */}
        <h1 className="view-title" tabIndex={-1}>
          {title}
        </h1>
        {description && <p className="view-desc">{description}</p>}
        {children}
      </div>
      {actions && <div className="view-actions">{actions}</div>}
    </header>
  );
}
