import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { errorText } from "../api/errors";
import { useApp } from "../components/AppContext";
import { useModal } from "../components/Dialog";
import { Icon } from "../components/Icon";
import { highlightRuns } from "../lib/fuzzy";
import { isMac, isPaletteShortcut } from "../lib/keyboard";
import { collectCommands, filterCommands, useCommandsVersion, type Command, type CommandContext, type RankedCommand } from "./commands";
import { useShell } from "./ShellContext";
import "./palette.css";

function Highlight({ text, indices }: { text: string; indices: number[] }) {
  return (
    <>
      {highlightRuns(text, indices).map((r, i) =>
        r.match ? (
          <mark key={i} className="palette-mark">
            {r.text}
          </mark>
        ) : (
          r.text
        ),
      )}
    </>
  );
}

/** Ctrl/⌘K: search everything and run it (plan §6.3). Mounted only while open. */
export function CommandPalette({ onClose }: { onClose(): void }) {
  const app = useApp();
  const shell = useShell();
  const version = useCommandsVersion();
  const ref = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const base = useId();
  const mac = isMac(app.info?.os);
  useModal(ref, true);

  const ctx = useMemo<CommandContext>(() => ({ ...app, ...shell }), [app, shell]);
  const commands = useMemo(() => collectCommands(ctx), [ctx, version]);
  const groups = useMemo(() => filterCommands(commands, query), [commands, query]);
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const current = Math.min(active, flat.length - 1);
  const optionId = (i: number) => `${base}-opt-${i}`;

  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    if (current >= 0) document.getElementById(`${base}-opt-${current}`)?.scrollIntoView({ block: "nearest" });
  }, [current, base]);

  const run = (cmd: Command) => {
    onClose();
    // after the palette has gone, so focus and dialogs settle first
    setTimeout(() => {
      Promise.resolve()
        .then(() => cmd.run(ctx))
        .catch((err: unknown) => app.toast.error(errorText(err)));
    }, 0);
  };

  const move = (delta: number) => {
    if (flat.length === 0) return;
    setActive((i) => {
      const from = Math.min(i, flat.length - 1);
      if (Math.abs(delta) > 1) return Math.max(0, Math.min(flat.length - 1, from + delta));
      return (from + delta + flat.length) % flat.length;
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const ctrl = e.ctrlKey && !e.metaKey && !e.altKey;
    if (isPaletteShortcut(e, mac) && e.key !== "/") {
      e.preventDefault(); // the shortcut that opened it closes it
      onClose();
      return;
    }
    switch (true) {
      case e.key === "ArrowDown" || (ctrl && e.key === "n"):
        e.preventDefault();
        move(1);
        break;
      case e.key === "ArrowUp" || (ctrl && e.key === "p"):
        e.preventDefault();
        move(-1);
        break;
      case e.key === "PageDown":
        e.preventDefault();
        move(8);
        break;
      case e.key === "PageUp":
        e.preventDefault();
        move(-8);
        break;
      case e.key === "Enter":
        e.preventDefault();
        if (flat[current]) run(flat[current].command);
        break;
      case e.key === "Tab":
        e.preventDefault(); // the list is driven from the field
        break;
    }
  };

  let index = 0;
  const option = (r: RankedCommand) => {
    const i = index++;
    const c = r.command;
    return (
      <div
        key={c.id}
        id={optionId(i)}
        role="option"
        aria-selected={i === current}
        className="palette-option"
        onMouseMove={() => i !== current && setActive(i)}
        onClick={() => run(c)}
      >
        <span className="palette-icon" aria-hidden="true">
          <Icon name={c.icon ?? "arrowRight"} size={15} />
        </span>
        <span className="palette-title">
          <Highlight text={c.title} indices={r.titleIndices} />
        </span>
        {c.hint && (
          <span className="palette-hint">
            <Highlight text={c.hint} indices={r.hintIndices} />
          </span>
        )}
      </div>
    );
  };

  const count = flat.length;
  return (
    <dialog
      ref={ref}
      className="palette"
      aria-label="Command palette"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="palette-frame">
        <div className="palette-search">
          <Icon name="search" size={16} />
          <input
            className="palette-input"
            type="text"
            data-autofocus
            value={query}
            placeholder="Search apps, views and actions…"
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={current >= 0 ? optionId(current) : undefined}
            aria-label="Search or run a command"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <kbd className="kbd">Esc</kbd>
        </div>
        <div className="palette-list" id={listId} role="listbox" aria-label="Commands">
          {groups.map((g, gi) => (
            <div key={g.name} role="group" aria-labelledby={`${base}-g-${gi}`} className="palette-group">
              <div className="palette-group-name" id={`${base}-g-${gi}`} role="presentation">
                {g.name}
              </div>
              {g.items.map(option)}
            </div>
          ))}
          {count === 0 && (
            <p className="palette-empty">
              Nothing matches <strong>{query.trim()}</strong>.
            </p>
          )}
        </div>
        <footer className="palette-foot" aria-hidden="true">
          <span>
            <kbd className="kbd">↑</kbd>
            <kbd className="kbd">↓</kbd> move
          </span>
          <span>
            <kbd className="kbd">↵</kbd> run
          </span>
          <span>
            <kbd className="kbd">esc</kbd> close
          </span>
        </footer>
        <p className="sr-only" role="status">
          {query.trim() ? `${count} ${count === 1 ? "result" : "results"}` : ""}
        </p>
      </div>
    </dialog>
  );
}
