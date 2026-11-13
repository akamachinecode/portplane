import { useEffect, useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { joinCommand, shellMetachar, splitCommandLine } from "../../lib/dekit/shell";
import { looksSecret, type EnvRow } from "../../lib/dekit/taskForm";

// Form controls of the config editors (plan §6.6): CommandField (and its
// ArgvEditor), KeyValue (env), Chips (tags), ListRows (add_path),
// TaskPicker (deps) and a labelled Row.

/** A form row: label, control and error, with dekit's help behind the ⓘ next to the label (ADR-0032). */
export function FormRow({ label, htmlFor, help, error, children, locked }: { label: string; htmlFor?: string; help?: ReactNode; error?: string | null; children: ReactNode; locked?: string }) {
  const errId = useId();
  const hintId = useId();
  const [about, setAbout] = useState(false);
  return (
    <div className={`form-row${error ? " has-error" : ""}`}>
      <div className="form-row-label">
        {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span>{label}</span>}
        {help && (
          <button
            type="button"
            className={`form-help-btn${about ? " is-on" : ""}`}
            aria-expanded={about}
            aria-controls={hintId}
            aria-label={`About ${label}`}
            title={`About ${label}`}
            onClick={() => setAbout((a) => !a)}
          >
            <Icon name="info" size={14} />
          </button>
        )}
      </div>
      <div className="form-row-control">
        {locked ? (
          <p className="form-locked">
            <Icon name="info" size={13} />
            <span>
              Written with <code>!js</code>: <code className="form-locked-src">{locked}</code>. Edit it as text or in your editor.
            </span>
          </p>
        ) : (
          children
        )}
        {error && (
          <p className="field-error" id={errId} role="alert">
            {error}
          </p>
        )}
        {help && (
          <p className="field-hint form-help" id={hintId} hidden={!about}>
            {help}
          </p>
        )}
      </div>
    </div>
  );
}

const sameWords = (a: string[], b: string[]) => a.length === b.length && a.every((w, i) => w === b[i]);
const lineOf = (words: string[]) => (words.some(Boolean) ? joinCommand(words.filter((w, i) => w || i === 0)) : "");

/**
 * A command as one line to type or paste, split like sh into the program and
 * its arguments (dekit runs them without a shell). "Edit as separate
 * arguments" shows one input per word, for arguments with spaces or quotes.
 */
export function CommandField({ value, onChange, label, placeholder = "pnpm run dev", id }: { value: string[]; onChange(next: string[]): void; label: string; placeholder?: string; id?: string }) {
  const own = useId();
  const inputId = id ?? own;
  const noteId = useId();
  const [mode, setMode] = useState<"line" | "argv">("line");
  const [text, setText] = useState(() => lineOf(value));
  const split = splitCommandLine(text);
  const meta = text.trim() ? shellMetachar(text) : "";

  // A change from outside (Discard, a picked suggestion) shows, unless the line already says it.
  useEffect(() => {
    const mine = splitCommandLine(text);
    if (mine.error || !sameWords(mine.words, value.filter(Boolean))) setText(lineOf(value));
    // only an outside change of value resets what the user types, so text is not a dependency
  }, [value]);

  const type = (line: string) => {
    setText(line);
    const r = splitCommandLine(line);
    if (!r.error) onChange(r.words.length ? r.words : [""]);
  };

  if (mode === "argv") {
    return (
      <div className="argv">
        <ArgvEditor value={value} onChange={onChange} label={label} placeholder={placeholder.split(" ")[0]} />
        <div className="argv-tools">
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => onChange([...(value.length ? value : [""]), ""])}>
            <Icon name="plus" size={13} />
            Add argument
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setMode("line")}>
            <Icon name="terminal" size={13} />
            Edit as one line
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="argv">
      <div className="command-input">
        <span className="argv-n" aria-hidden="true">
          $
        </span>
        <input
          id={inputId}
          className="input mono"
          value={text}
          placeholder={placeholder}
          aria-label={id ? undefined : label}
          aria-invalid={split.error ? true : undefined}
          aria-describedby={split.error || meta ? noteId : undefined}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          onChange={(e) => type(e.target.value)}
        />
      </div>
      {split.error ? (
        <p className="field-error" id={noteId}>
          {split.error}
        </p>
      ) : (
        meta && (
          <p className="argv-warn" id={noteId}>
            <Icon name="warning" size={13} />
            <span>
              <code>{meta}</code> is shell syntax, and dekit runs the program without a shell.{" "}
              <button type="button" className="link-btn" onClick={() => onChange(["sh", "-c", text.trim()])}>
                Run it through sh -c
              </button>
            </span>
          </p>
        )
      )}
      <div className="argv-tools">
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setMode("argv")}>
          <Icon name="rows" size={13} />
          Edit as separate arguments
        </button>
      </div>
    </div>
  );
}

/** One argument per row: CommandField's "Edit as separate arguments". */
export function ArgvEditor({ value, onChange, label, placeholder = "program" }: { value: string[]; onChange(next: string[]): void; label: string; placeholder?: string }) {
  const base = useId();
  const rows = value.length ? value : [""];
  const focusRow = (i: number) => requestAnimationFrame(() => document.getElementById(`${base}-${i}`)?.focus());
  const onKey = (i: number) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onChange([...rows.slice(0, i + 1), "", ...rows.slice(i + 1)]);
      focusRow(i + 1);
    } else if (e.key === "Backspace" && rows[i] === "" && rows.length > 1) {
      e.preventDefault();
      onChange(rows.filter((_, j) => j !== i));
      focusRow(Math.max(0, i - 1));
    }
  };
  return (
    <ol className="argv-rows" aria-label={label}>
      {rows.map((w, i) => (
        <li key={i} className="argv-row">
          <span className="argv-n" aria-hidden="true">
            {i === 0 ? "$" : i}
          </span>
          <input
            id={`${base}-${i}`}
            className="input mono"
            value={w}
            placeholder={i === 0 ? placeholder : "argument"}
            aria-label={i === 0 ? `${label}: program` : `${label}: argument ${i}`}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            onChange={(e) => onChange(rows.map((x, j) => (j === i ? e.target.value : x)))}
            onKeyDown={onKey(i)}
          />
          <IconButton icon="arrowUp" label={`Move argument ${i} up`} disabled={i === 0} onClick={() => onChange(rows.map((x, j) => (j === i - 1 ? rows[i] : j === i ? rows[i - 1] : x)))} />
          <IconButton icon="close" label={i === 0 ? "Clear the program" : `Remove argument ${i}`} onClick={() => onChange(rows.length > 1 ? rows.filter((_, j) => j !== i) : [""])} />
        </li>
      ))}
    </ol>
  );
}

/** Environment variables: a key/value table; "Unset" removes one the task would inherit. */
export function KeyValueEditor({ value, onChange, label }: { value: EnvRow[]; onChange(next: EnvRow[]): void; label: string }) {
  const [shown, setShown] = useState<Set<number>>(new Set());
  const rows = value;
  const set = (i: number, patch: Partial<EnvRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="kv">
      {rows.length > 0 && (
        <table className="kv-table">
          <thead>
            <tr>
              <th scope="col">Variable</th>
              <th scope="col">Value</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const secret = looksSecret(r.key) && !shown.has(i);
              return (
                <tr key={i}>
                  <td>
                    <input className="input mono" value={r.key} placeholder="NAME" aria-label={`${label}: name ${i + 1}`} spellCheck={false} autoCapitalize="off" onChange={(e) => set(i, { key: e.target.value })} />
                  </td>
                  <td>
                    {r.value === null ? (
                      <span className="kv-unset">
                        unset{" "}
                        <button type="button" className="link-btn" onClick={() => set(i, { value: "" })}>
                          Give it a value
                        </button>
                      </span>
                    ) : (
                      <input
                        className="input mono"
                        type={secret ? "password" : "text"}
                        value={r.value}
                        aria-label={`${label}: value of ${r.key || `variable ${i + 1}`}`}
                        spellCheck={false}
                        autoComplete="off"
                        onChange={(e) => set(i, { value: e.target.value })}
                      />
                    )}
                  </td>
                  <td className="kv-actions">
                    {looksSecret(r.key) && r.value !== null && (
                      <IconButton icon={shown.has(i) ? "minus" : "info"} label={shown.has(i) ? `Hide ${r.key}` : `Show ${r.key}`} onClick={() => setShown((s) => (s.has(i) ? new Set([...s].filter((x) => x !== i)) : new Set(s).add(i)))} />
                    )}
                    {r.value !== null && <IconButton icon="xCircle" label={`Unset ${r.key || "this variable"} for the task`} onClick={() => set(i, { value: null })} />}
                    <IconButton icon="close" label={`Remove ${r.key || "this row"}`} onClick={() => onChange(rows.filter((_, j) => j !== i))} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => onChange([...rows, { key: "", value: "" }])}>
        <Icon name="plus" size={13} />
        Add variable
      </button>
    </div>
  );
}

/** Tags as chips: Enter or comma adds one, Backspace on empty removes the last. */
export function Chips({ value, onChange, label, suggestions = [] }: { value: string[]; onChange(next: string[]): void; label: string; suggestions?: string[] }) {
  const [text, setText] = useState("");
  const id = useId();
  const add = (t: string) => {
    const v = t.trim().replace(/,$/, "");
    if (v && !value.includes(v)) onChange([...value, v]);
    setText("");
  };
  return (
    <div className="tag-field">
      <ul className="tag-field-list" aria-label={label}>
        {value.map((t) => (
          <li key={t} className="tag-chip">
            {t}
            <button type="button" className="tag-chip-x" aria-label={`Remove ${t}`} onClick={() => onChange(value.filter((x) => x !== t))}>
              <Icon name="close" size={11} />
            </button>
          </li>
        ))}
      </ul>
      <input
        id={id}
        className="input tag-field-input"
        value={text}
        placeholder={value.length ? "" : "Add a tag"}
        aria-label={`Add to ${label}`}
        list={suggestions.length ? `${id}-list` : undefined}
        onChange={(e) => (e.target.value.endsWith(",") ? add(e.target.value) : setText(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add(text);
          } else if (e.key === "Backspace" && text === "" && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={() => text.trim() && add(text)}
      />
      {suggestions.length > 0 && (
        <datalist id={`${id}-list`}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </div>
  );
}

/** A list of short texts (add_path), one per row. */
export function ListRows({ value, onChange, label, placeholder, addLabel }: { value: string[]; onChange(next: string[]): void; label: string; placeholder: string; addLabel: string }) {
  return (
    <div className="list-rows">
      {value.map((v, i) => (
        <div key={i} className="list-row">
          <input className="input mono" value={v} placeholder={placeholder} aria-label={`${label} ${i + 1}`} spellCheck={false} onChange={(e) => onChange(value.map((x, j) => (j === i ? e.target.value : x)))} />
          <IconButton icon="close" label={`Remove ${v || "this row"}`} onClick={() => onChange(value.filter((_, j) => j !== i))} />
        </div>
      ))}
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => onChange([...value, ""])}>
        <Icon name="plus" size={13} />
        {addLabel}
      </button>
    </div>
  );
}

/** The folder part of a task path ("shop/" of "shop/web"), "" at the top. */
export function taskParent(path: string): string {
  const p = path.replace(/\/$/, "");
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i + 1);
}

/**
 * Several of the project's tasks, as checkboxes. With `near` (a folder such
 * as "shop/"), the tasks of that folder show by their short name, and every
 * other task of the file waits behind the search or "Show all".
 */
export function TaskPicker({ value, onChange, options, label, near }: { value: string[]; onChange(next: string[]): void; options: Array<{ path: string; label: string; disabled?: string }>; label: string; near?: string }) {
  const [filter, setFilter] = useState("");
  const [all, setAll] = useState(false);
  const q = filter.trim().toLowerCase();
  const isNear = (p: string) => near === undefined || taskParent(p) === near;
  const shown = options.filter((o) => (q ? o.path.toLowerCase().includes(q) || o.label.toLowerCase().includes(q) : all || isNear(o.path) || value.includes(o.path)));
  const hidden = q ? 0 : options.length - shown.length;
  const name = (p: string) => (near && isNear(p) ? p.slice(near.length) : p);
  const leaf = (p: string) => p.split("/").pop() ?? p;
  return (
    <div className="picker">
      {(options.length > 8 || hidden > 0) && (
        <input className="input" type="search" placeholder={near !== undefined ? `Search all ${options.length} tasks` : "Filter tasks"} aria-label={`Search ${label}`} value={filter} onChange={(e) => setFilter(e.target.value)} />
      )}
      <ul className="picker-list" aria-label={label}>
        {shown.map((o) => (
          <li key={o.path}>
            <label className={`picker-item${o.disabled ? " is-disabled" : ""}`} title={o.disabled ?? o.path}>
              <input type="checkbox" checked={value.includes(o.path)} disabled={!!o.disabled && !value.includes(o.path)} onChange={(e) => onChange(e.target.checked ? [...value, o.path] : value.filter((x) => x !== o.path))} />
              <span className="mono">{name(o.path)}</span>
              {!o.label.startsWith(leaf(o.path)) && <span className="muted">{o.label}</span>}
            </label>
          </li>
        ))}
        {shown.length === 0 && <li className="muted picker-none">{q ? "No task matches." : near !== undefined ? "No other tasks in this folder." : "No other tasks."}</li>}
      </ul>
      {hidden > 0 && (
        <button type="button" className="link-btn picker-more" onClick={() => setAll(true)}>
          Show all {options.length} tasks
        </button>
      )}
    </div>
  );
}
