import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { joinCommand, shellMetachar, splitCommandLine } from "../../lib/dekit/shell";
import { looksSecret, type EnvRow } from "../../lib/dekit/taskForm";

// Form controls of the config editors (plan §6.6): ArgvEditor, KeyValue
// (env), Chips (tags), ListRows (add_path) and a labelled Row.

/** A form row: label, control, dekit's help or an error. */
export function FormRow({ label, htmlFor, help, error, children, locked }: { label: ReactNode; htmlFor?: string; help?: ReactNode; error?: string | null; children: ReactNode; locked?: string }) {
  const errId = useId();
  return (
    <div className={`form-row${error ? " has-error" : ""}`}>
      <div className="form-row-label">
        {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span>{label}</span>}
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
        {error ? (
          <p className="field-error" id={errId} role="alert">
            {error}
          </p>
        ) : (
          help && <p className="field-hint">{help}</p>
        )}
      </div>
    </div>
  );
}

/** One argument per row, plus "Paste a command line" that splits it like sh. */
export function ArgvEditor({ value, onChange, label, placeholder = "program" }: { value: string[]; onChange(next: string[]): void; label: string; placeholder?: string }) {
  const base = useId();
  const [pasting, setPasting] = useState(false);
  const [line, setLine] = useState("");
  const rows = value.length ? value : [""];
  const split = line.trim() ? splitCommandLine(line) : null;
  const meta = line.trim() ? shellMetachar(line) : "";
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
    <div className="argv">
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
      <div className="argv-tools">
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => onChange([...rows, ""])}>
          <Icon name="plus" size={13} />
          Add argument
        </button>
        <button type="button" className="btn btn-sm btn-ghost" aria-expanded={pasting} onClick={() => setPasting((p) => !p)}>
          <Icon name="terminal" size={13} />
          Paste a command line
        </button>
        {value.some(Boolean) && <span className="argv-preview mono" title="As a shell would show it">{joinCommand(value.filter((w, i) => w || i === 0))}</span>}
      </div>
      {pasting && (
        <div className="argv-paste">
          <input className="input mono" value={line} placeholder="pnpm run dev --host 127.0.0.1" aria-label="Command line to split" spellCheck={false} onChange={(e) => setLine(e.target.value)} />
          {split?.error && <p className="field-error">{split.error}</p>}
          {meta && (
            <p className="argv-warn">
              <Icon name="warning" size={13} />
              <span>
                <code>{meta}</code> is shell syntax. dekit runs the program directly, without a shell, so it would reach the program as a plain word.{" "}
                <button type="button" className="link-btn" onClick={() => (onChange(["sh", "-c", line.trim()]), setPasting(false), setLine(""))}>
                  Run it through sh -c
                </button>
              </span>
            </p>
          )}
          <div className="argv-paste-actions">
            <button type="button" className="btn btn-sm" disabled={!split || !!split.error || split.words.length === 0} onClick={() => (onChange(split!.words), setPasting(false), setLine(""))}>
              Use {split && !split.error ? `${split.words.length} ${split.words.length === 1 ? "word" : "words"}` : "it"}
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => (setPasting(false), setLine(""))}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
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
    <div className="chips">
      <ul className="chips-list" aria-label={label}>
        {value.map((t) => (
          <li key={t} className="chip">
            {t}
            <button type="button" className="chip-x" aria-label={`Remove ${t}`} onClick={() => onChange(value.filter((x) => x !== t))}>
              <Icon name="close" size={11} />
            </button>
          </li>
        ))}
      </ul>
      <input
        id={id}
        className="input chips-input"
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

/** Several of the project's tasks, as checkboxes with a filter. */
export function TaskPicker({ value, onChange, options, label }: { value: string[]; onChange(next: string[]): void; options: Array<{ path: string; label: string; disabled?: string }>; label: string }) {
  const [filter, setFilter] = useState("");
  const shown = options.filter((o) => !filter || o.path.includes(filter) || o.label.includes(filter));
  return (
    <div className="picker">
      {options.length > 8 && <input className="input" type="search" placeholder="Filter tasks" aria-label={`Filter ${label}`} value={filter} onChange={(e) => setFilter(e.target.value)} />}
      <ul className="picker-list" aria-label={label}>
        {shown.map((o) => (
          <li key={o.path}>
            <label className={`picker-item${o.disabled ? " is-disabled" : ""}`} title={o.disabled}>
              <input type="checkbox" checked={value.includes(o.path)} disabled={!!o.disabled && !value.includes(o.path)} onChange={(e) => onChange(e.target.checked ? [...value, o.path] : value.filter((x) => x !== o.path))} />
              <span className="mono">{o.path}</span>
              {o.label !== o.path.split("/").pop() && <span className="muted">{o.label}</span>}
            </label>
          </li>
        ))}
        {shown.length === 0 && <li className="muted picker-none">No other tasks.</li>}
      </ul>
    </div>
  );
}
