import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

export interface MenuItem {
  label: string;
  icon: IconName;
  /** The keyboard shortcut that does the same, shown on the right: "C". */
  shortcut?: string;
  onSelect(): void;
}

/**
 * An overflow menu: a "more" button (or, with `button`, a text button such
 * as "Share… ▾") and a list of actions, keyboard-navigable.
 */
export function Menu({ label, items, button, disabled, title }: { label: string; items: MenuItem[]; button?: ReactNode; disabled?: boolean; title?: string }) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    wrap.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const toggle = () => {
    if (!open && trigger.current) {
      const rect = trigger.current.getBoundingClientRect();
      setUp(window.innerHeight - rect.bottom < 40 + items.length * 34);
    }
    setOpen((o) => !o);
  };

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!open) {
      if (e.key === "ArrowDown" && e.target === trigger.current) {
        e.preventDefault();
        toggle();
      }
      return;
    }
    const els = [...(wrap.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const i = els.indexOf(document.activeElement as HTMLElement);
    const focus = (n: number) => els[(n + els.length) % els.length]?.focus();
    switch (e.key) {
      case "Escape":
        e.preventDefault();
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

  return (
    <div className="menu-wrap" ref={wrap} onKeyDown={onKeyDown}>
      <button
        ref={trigger}
        type="button"
        className={button ? "btn btn-sm" : "icon-btn"}
        aria-label={button ? undefined : label}
        title={title ?? (button ? undefined : "More actions")}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={toggle}
      >
        {button ?? <Icon name="more" />}
      </button>
      {open && (
        <div className={up ? "menu menu-up" : "menu"} role="menu" id={id} aria-label={label}>
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="menu-item"
              aria-keyshortcuts={item.shortcut}
              onClick={() => {
                close(true);
                item.onSelect();
              }}
            >
              <Icon name={item.icon} size={15} />
              {item.label}
              {item.shortcut && (
                <kbd className="kbd menu-kbd" aria-hidden="true">
                  {item.shortcut}
                </kbd>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
