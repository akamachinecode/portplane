import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useToolbarSlot } from "../shell/toolbarSlot";

interface ViewHeaderProps {
  title: ReactNode;
  /** The tool or place the view belongs to, before the title: "portless / Routes". */
  section?: string;
  /** A few words next to the title in the toolbar, such as "4 running · 1 failed". */
  summary?: ReactNode;
  /** A sentence about the view, at the top of the page. */
  description?: ReactNode;
  /** Buttons and pickers for the whole view, at the toolbar's trailing edge. */
  actions?: ReactNode;
  children?: ReactNode;
}

/**
 * A view's title (its one h1), summary and actions, in the window's toolbar
 * (ADR-0027), and its description at the top of the page.
 */
export function ViewHeader({ title, section, summary, description, actions, children }: ViewHeaderProps) {
  const slot = useToolbarSlot();
  const head = (
    <div className="toolbar-view">
      <div className="toolbar-heading">
        {/* focused after a view change, so screen readers announce it */}
        <h1 className="view-title" tabIndex={-1}>
          {section && (
            <>
              <span className="view-crumb">{section}</span>
              <span className="view-crumb-sep" aria-hidden="true">
                /
              </span>
            </>
          )}
          {title}
        </h1>
        {summary && <span className="toolbar-summary">{summary}</span>}
      </div>
      {actions && <div className="view-actions">{actions}</div>}
    </div>
  );
  const intro = (description || children) && (
    <div className="view-intro">
      {description && <p className="view-desc">{description}</p>}
      {children}
    </div>
  );
  if (!slot) {
    return (
      <header className="view-head">
        {head}
        {intro}
      </header>
    );
  }
  return (
    <>
      {createPortal(head, slot)}
      {intro}
    </>
  );
}
