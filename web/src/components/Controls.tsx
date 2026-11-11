import { useId, type ReactNode } from "react";
import { errorText } from "../api/errors";
import { copyText } from "../lib/clipboard";
import { useApp } from "./AppContext";
import { Icon, Spinner } from "./Icon";
import { IconButton } from "./IconButton";

/** A shell command to run by hand, with a copy button. The prompt sign is not copied. */
export function CommandLine({ command }: { command: string }) {
  const { toast } = useApp();
  const copy = () =>
    copyText(command).then(
      () => toast.info("Copied the command"),
      (err: unknown) => toast.error(errorText(err)),
    );
  return (
    <div className="cmd">
      <code className="cmd-text">{command}</code>
      <IconButton icon="copy" label={`Copy: ${command}`} onClick={copy} />
    </div>
  );
}

/** An on/off setting that applies at once. */
export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
  busy,
}: {
  checked: boolean;
  onChange(next: boolean): void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  busy?: boolean;
}) {
  const id = useId();
  const descId = useId();
  return (
    <div className="switch-row">
      <div className="switch-text">
        <label htmlFor={id} className="switch-label">
          {label}
        </label>
        {description && (
          <p id={descId} className="switch-desc">
            {description}
          </p>
        )}
      </div>
      {busy && <Spinner />}
      <input
        id={id}
        type="checkbox"
        role="switch"
        className="switch"
        checked={checked}
        disabled={disabled}
        aria-busy={busy || undefined}
        aria-describedby={description ? descId : undefined}
        onChange={(e) => {
          if (!busy) onChange(e.target.checked);
        }}
      />
    </div>
  );
}

/** A label, a control and an optional hint or error, stacked. */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  errorId,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  error?: string | null;
  errorId?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? (
        <p className="field-error" id={errorId} role="alert">
          {error}
        </p>
      ) : (
        hint && <p className="field-hint">{hint}</p>
      )}
    </div>
  );
}

/**
 * Several paths, one per row, with add and remove. Blank rows are ignored by
 * the caller (cleanFolders); problems show under their row.
 */
export function PathRows({
  values,
  onChange,
  problem,
  placeholder,
  disabled,
  label,
}: {
  values: string[];
  onChange(next: string[]): void;
  problem(path: string): string | null;
  placeholder: string;
  disabled?: boolean;
  label: string;
}) {
  const base = useId();
  const rows = values.length ? values : [""];
  return (
    <div className="path-rows">
      {rows.map((v, i) => {
        const err = problem(v);
        const id = `${base}-${i}`;
        return (
          <div key={i} className="path-row">
            <div className="path-row-line">
              <input
                id={id}
                className="input mono"
                type="text"
                value={v}
                placeholder={placeholder}
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="off"
                disabled={disabled}
                aria-label={rows.length > 1 ? `${label} ${i + 1}` : label}
                aria-invalid={err ? true : undefined}
                aria-describedby={err ? `${id}-err` : undefined}
                onChange={(e) => onChange(rows.map((x, j) => (j === i ? e.target.value : x)))}
              />
              {rows.length > 1 && (
                <IconButton icon="close" label={`Remove ${v || "this folder"}`} disabled={disabled} onClick={() => onChange(rows.filter((_, j) => j !== i))} />
              )}
            </div>
            {err && (
              <p className="field-error" id={`${id}-err`}>
                {err}
              </p>
            )}
          </div>
        );
      })}
      <button type="button" className="btn btn-sm btn-ghost path-add" disabled={disabled} onClick={() => onChange([...rows, ""])}>
        <Icon name="plus" size={14} />
        Add another folder
      </button>
    </div>
  );
}
