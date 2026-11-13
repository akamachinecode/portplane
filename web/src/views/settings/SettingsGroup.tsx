import { useId, type ReactNode } from "react";
// The groups also show in Domains, which loads without the Settings view.
import "../SettingsView.css";

/**
 * A titled block of settings (ADR-0029): the title and its sentence above,
 * the settings in one card below, one row each, as in Linear's settings.
 * A page with one group leaves the title out: the page's own title says it
 * (ADR-0032: say it once), and its explanation is behind the page's ⓘ.
 */
export function SettingsGroup({ title, description, children }: { title?: string; description?: ReactNode; children: ReactNode }) {
  const id = useId();
  if (!title) {
    return (
      <section className="sgroup">
        <div className="sgroup-body">{children}</div>
      </section>
    );
  }
  return (
    <section className="sgroup" aria-labelledby={id}>
      <header className="sgroup-head">
        <h2 className="sgroup-title" id={id}>
          {title}
        </h2>
        {description && <p className="sgroup-desc">{description}</p>}
      </header>
      <div className="sgroup-body">{children}</div>
    </section>
  );
}

/** One setting: its name and explanation on the left, its control on the right. */
export function SettingRow({ label, description, htmlFor, children }: { label: ReactNode; description?: ReactNode; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="srow">
      <div className="srow-text">
        {htmlFor ? (
          <label className="srow-label" htmlFor={htmlFor}>
            {label}
          </label>
        ) : (
          <span className="srow-label">{label}</span>
        )}
        {description && <p className="srow-desc">{description}</p>}
      </div>
      <div className="srow-control">{children}</div>
    </div>
  );
}
