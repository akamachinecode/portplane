import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Icon, type IconName } from "../../components/Icon";

// A toolbar button with a menu under it: filters (checkboxes that keep it
// open), the sort (radio items) and "Select…" (actions). Keyboard: Enter,
// Space or ↓ open it, ↑↓ Home End move, Esc closes and goes back to the
// button, Tab leaves.

export type PopItem =
  | { kind: "check"; label: string; checked: boolean; count?: number; onToggle(): void }
  | { kind: "radio"; label: string; checked: boolean; description?: string; onSelect(): void }
  | { kind: "action"; label: string; icon?: IconName; hint?: string; disabled?: boolean; onSelect(): void };

export interface PopSection {
  title?: string;
  items: PopItem[];
}

interface Props {
  /** The menu's name for screen readers. */
  label: string;
  /** What the button shows. */
  button: ReactNode;
  buttonTitle?: string;
  /** Highlights the button: a filter is on. */
  active?: boolean;
  sections: PopSection[];
  /** Shown when there is nothing to choose from. */
  empty?: string;
  footer?: { label: string; onSelect(): void };
  align?: "start" | "end";
}

export function PopMenu({ label, button, buttonTitle, active, sections, empty, footer, align = "start" }: Props) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    const first = wrap.current?.querySelector<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])');
    first?.focus();
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!open) {
      if (e.key === "ArrowDown" && e.target === trigger.current) {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    const els = [...(wrap.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
    const i = els.indexOf(document.activeElement as HTMLElement);
    const focus = (n: number) => els[(n + els.length) % els.length]?.focus();
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        close(true);
        break;
      case "ArrowDown":
        e.preventDefault();
        focus(i + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        focus(i - 1);
        break;
      case "Home":
        e.preventDefault();
        focus(0);
        break;
      case "End":
        e.preventDefault();
        focus(els.length - 1);
        break;
      case "Tab":
        close(false);
        break;
    }
  };

  const nothing = sections.every((s) => s.items.length === 0);

  return (
    <div className="popmenu" ref={wrap} onKeyDown={onKeyDown}>
      <button
        ref={trigger}
        type="button"
        className={`btn btn-sm btn-ghost popmenu-trigger${active ? " is-active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title={buttonTitle}
        onClick={() => setOpen((o) => !o)}
      >
        {button}
        <Icon name="chevronDown" size={13} className="popmenu-chevron" />
      </button>
      {open && (
        <div className={`popmenu-panel popmenu-${align}`} role="menu" id={id} aria-label={label}>
          {nothing && empty && <p className="popmenu-empty">{empty}</p>}
          {sections.map((section, si) =>
            section.items.length === 0 ? null : (
              <div key={si} role="group" aria-label={section.title} className="popmenu-group">
                {section.title && (
                  <p className="popmenu-title" aria-hidden="true">
                    {section.title}
                  </p>
                )}
                {section.items.map((item) => (
                  <Item key={`${item.kind}:${item.label}`} item={item} close={() => close(true)} />
                ))}
              </div>
            ),
          )}
          {footer && (
            <div className="popmenu-foot">
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="popmenu-item popmenu-clear"
                onClick={() => {
                  footer.onSelect();
                  close(true);
                }}
              >
                {footer.label}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Item({ item, close }: { item: PopItem; close(): void }) {
  switch (item.kind) {
    case "check":
      return (
        <button type="button" role="menuitemcheckbox" aria-checked={item.checked} tabIndex={-1} className="popmenu-item" onClick={item.onToggle}>
          <span className={`popmenu-box${item.checked ? " is-on" : ""}`} aria-hidden="true">
            {item.checked && <Icon name="check" size={12} />}
          </span>
          <span className="popmenu-label">{item.label}</span>
          {item.count !== undefined && <span className="popmenu-count">{item.count}</span>}
        </button>
      );
    case "radio":
      return (
        <button
          type="button"
          role="menuitemradio"
          aria-checked={item.checked}
          tabIndex={-1}
          className="popmenu-item"
          onClick={() => {
            item.onSelect();
            close();
          }}
        >
          <span className="popmenu-tick" aria-hidden="true">
            {item.checked && <Icon name="check" size={14} />}
          </span>
          <span className="popmenu-label">
            {item.label}
            {item.description && <span className="popmenu-desc">{item.description}</span>}
          </span>
        </button>
      );
    default:
      return (
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          className="popmenu-item"
          aria-disabled={item.disabled || undefined}
          onClick={() => {
            if (item.disabled) return;
            item.onSelect();
            close();
          }}
        >
          {item.icon ? <Icon name={item.icon} size={14} /> : <span className="popmenu-tick" aria-hidden="true" />}
          <span className="popmenu-label">{item.label}</span>
          {item.hint && <span className="popmenu-count">{item.hint}</span>}
        </button>
      );
  }
}
