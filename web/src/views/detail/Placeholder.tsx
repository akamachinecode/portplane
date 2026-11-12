import type { ReactNode } from "react";
import { Icon, type IconName } from "../../components/Icon";

/** A tab that a later version fills in: what it will show, and what to do meanwhile. */
export function Placeholder({ icon, title, children }: { icon: IconName; title: string; children: ReactNode }) {
  return (
    <div className="detail-soon">
      <span className="detail-soon-icon" aria-hidden="true">
        <Icon name={icon} size={20} />
      </span>
      <p className="detail-soon-title">
        {title} <span className="tag">soon</span>
      </p>
      <div className="detail-soon-text">{children}</div>
    </div>
  );
}
