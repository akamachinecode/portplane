import { useId, type ReactNode } from "react";
// The groups also show in Domains, which loads without the Settings view.
import "../SettingsView.css";

/** A titled block of settings inside a section. */
export function SettingsGroup({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section className="sgroup" aria-labelledby={id}>
      <h2 className="sgroup-title" id={id}>
        {title}
      </h2>
      {description && <p className="sgroup-desc">{description}</p>}
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
