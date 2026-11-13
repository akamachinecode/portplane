import { useId, type ReactNode } from "react";
import { Icon } from "../../components/Icon";
import { inferHome, shortenPath } from "../../lib/format";
import { StateDot } from "../../components/StateDot";

type DotState = Parameters<typeof StateDot>[0]["state"];

// The calm pieces portless's pages share (ADR-0032): a fold for details on
// demand, a titled group with room for its actions, and one status line.

/**
 * Folded content under a quiet summary: "Details", "How it works". A
 * native <details>, so the keyboard and screen readers know it.
 */
export function Fold({ summary, hint, open, className, children }: { summary: ReactNode; hint?: ReactNode; open?: boolean; className?: string; children: ReactNode }) {
  return (
    <details className={`dfold${className ? ` ${className}` : ""}`} open={open}>
      <summary className="dfold-summary">
        <Icon name="chevronRight" size={14} className="dfold-chevron" />
        <span className="dfold-title">{summary}</span>
        {hint && <span className="dfold-hint">{hint}</span>}
      </summary>
      <div className="dfold-body">{children}</div>
    </details>
  );
}

/**
 * A titled block like SettingsGroup (the same look), with its actions on
 * the right of the title, so a card doesn't need a row just for a button.
 */
export function Group({ title, description, actions, children, id: forced }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; id?: string }) {
  const auto = useId();
  const id = forced ?? auto;
  return (
    <section className="sgroup" aria-labelledby={id}>
      <header className="sgroup-head group-head">
        <div className="group-head-text">
          <h2 className="sgroup-title" id={id}>
            {title}
          </h2>
          {description && <p className="sgroup-desc">{description}</p>}
        </div>
        {actions && <div className="group-actions">{actions}</div>}
      </header>
      <div className="sgroup-body">{children}</div>
    </section>
  );
}

/** The one line that says how something stands, with its likely action on the right. */
export function StatusLine({ state, children, sub, actions }: { state?: DotState; children: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className={`status-line${state ? " has-dot" : ""}`}>
      <div className="status-line-text">
        <p className="status-line-main">
          {state && <StateDot state={state} />}
          <span>{children}</span>
        </p>
        {sub && <p className="status-line-sub">{sub}</p>}
      </div>
      {actions && <div className="status-line-actions">{actions}</div>}
    </div>
  );
}

/** A label and a value, for the rows inside a fold of details (in a <dl className="dfacts">). */
export function Fact({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="dfacts-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** A path with the home folder as ~, the whole path in its tooltip. */
export function ShortPath({ path }: { path: string }) {
  return (
    <span className="mono path-value" title={path}>
      {shortenPath(path, inferHome([path]))}
    </span>
  );
}
