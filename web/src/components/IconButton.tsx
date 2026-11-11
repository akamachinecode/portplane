import type { MouseEvent } from "react";
import { Icon, Spinner, type IconName } from "./Icon";

interface Props {
  icon: IconName;
  label: string;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  /** Shows a spinner. The button keeps focus but ignores clicks. */
  pending?: boolean;
  /** Ignores clicks without a spinner, e.g. while a sibling action runs. */
  busy?: boolean;
  disabled?: boolean;
  tone?: "go" | "halt";
}

/** A square ghost button with an accessible name and a tooltip. */
export function IconButton({ icon, label, onClick, pending, busy, disabled, tone }: Props) {
  const inert = pending || busy;
  return (
    <button
      type="button"
      className={tone ? `icon-btn tone-${tone}` : "icon-btn"}
      aria-label={label}
      title={label}
      disabled={disabled}
      aria-disabled={inert || undefined}
      aria-busy={pending || undefined}
      onClick={(e) => {
        if (!inert) onClick?.(e);
      }}
    >
      {pending ? <Spinner /> : <Icon name={icon} size={icon === "play" || icon === "stop" ? 15 : 16} />}
    </button>
  );
}

/** Keeps a row's action columns aligned when an action does not apply. */
export function IconSlot() {
  return <span className="icon-slot" aria-hidden="true" />;
}
