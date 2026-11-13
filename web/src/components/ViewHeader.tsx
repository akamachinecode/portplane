import { useId, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useToolbarSlot } from "../shell/toolbarSlot";
import { Icon } from "./Icon";

interface ViewHeaderProps {
  title: ReactNode;
  /** The tool or place the view belongs to, before the title: "portless / Routes". */
  section?: string;
  /** A few words next to the title in the toolbar, such as "4 running · 1 failed". */
  summary?: ReactNode;
  /** What the view is for, in a sentence: shown when the user asks (the ⓘ next to the title). */
  description?: ReactNode;
  /** Buttons and pickers for the whole view, at the toolbar's trailing edge. */
  actions?: ReactNode;
  children?: ReactNode;
}

/**
 * A view's title (its one h1), summary and actions, in the window's toolbar
 * (ADR-0027). Its description stays out of the way until the user asks for
 * it with the ⓘ next to the title (ADR-0032): a page opens on its content,
 * not on a paragraph the user read the first time.
 */
export function ViewHeader({ title, section, summary, description, actions, children }: ViewHeaderProps) {
  const slot = useToolbarSlot();
  const [about, setAbout] = useState(false);
  const aboutId = useId();
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
        {description && (
          <button
            type="button"
            className={`icon-btn view-about${about ? " is-on" : ""}`}
            aria-expanded={about}
            aria-controls={aboutId}
            aria-label="What this page is for"
            title="What this page is for"
            onClick={() => setAbout((x) => !x)}
          >
            <Icon name="info" size={15} />
          </button>
        )}
        {summary && <span className="toolbar-summary">{summary}</span>}
      </div>
      {actions && <div className="view-actions">{actions}</div>}
    </div>
  );
  const shown = about && !!description;
  const intro = (description || children) && (
    <div className={`view-intro${shown || children ? "" : " is-empty"}`} id={aboutId}>
      {shown && <p className="view-desc">{description}</p>}
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
