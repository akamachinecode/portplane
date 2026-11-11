import type { ReactNode } from "react";
import { Icon } from "./Icon";

interface Props {
  tone: "warn" | "error" | "info";
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}

export function Banner({ tone, title, children, action }: Props) {
  return (
    <div className={`banner banner-${tone}`} role={tone === "error" ? "alert" : undefined}>
      <Icon name={tone === "info" ? "info" : "warning"} className="banner-icon" />
      <div className="banner-body">
        <p className="banner-title">{title}</p>
        {children && <div className="banner-text">{children}</div>}
      </div>
      {action && <div className="banner-action">{action}</div>}
    </div>
  );
}
