import type { ReactNode } from "react";
import { Icon } from "./Icon";

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
