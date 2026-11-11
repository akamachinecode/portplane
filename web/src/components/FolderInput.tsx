import { useId, useState, type FormEvent } from "react";
import { errorText } from "../api/errors";
import { useApp } from "./AppContext";
import { Icon, Spinner } from "./Icon";

function placeholderFor(os: string | undefined): string {
  if (os === "darwin") return "/Users/you/code";
  if (os === "windows") return "C:\\Users\\you\\code";
  return "/home/you/code";
}

/**
 * A path field with Add, plus Browse… when the binary can show a native
 * folder picker. onAdd may throw; its message shows under the field.
 */
export function FolderInput({ onAdd, autoFocus }: { onAdd(path: string): Promise<void> | void; autoFocus?: boolean }) {
  const { api, info } = useApp();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"add" | "browse" | null>(null);
  const inputId = useId();
  const errorId = useId();

  const add = async (path: string, from: "add" | "browse") => {
    setBusy(from);
    setError(null);
    try {
      await onAdd(path);
      setValue("");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const path = value.trim();
    if (!path) {
      setError("Type the path of a folder.");
      return;
    }
    void add(path, "add");
  };

  const browse = async () => {
    setBusy("browse");
    setError(null);
    try {
      const res = await api.pickFolder();
      if (res.kind === "picked") {
        await add(res.path, "browse");
        return;
      }
      if (res.kind === "unsupported") setError("There's no folder picker on this system. Type the path instead.");
    } catch (err) {
      setError(errorText(err));
    }
    setBusy(null);
  };

  return (
    <form className="folder-input" onSubmit={submit} noValidate>
      <label className="sr-only" htmlFor={inputId}>
        Folder path
      </label>
      <div className="folder-input-row">
        <input
          id={inputId}
          className="input mono"
          type="text"
          value={value}
          placeholder={placeholderFor(info?.os)}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          autoFocus={autoFocus}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
        />
        <button type="submit" className="btn" disabled={busy !== null} aria-busy={busy === "add" || undefined}>
          {busy === "add" ? <Spinner /> : <Icon name="plus" size={14} />}
          Add
        </button>
        {info?.picker && (
          <button type="button" className="btn" onClick={browse} disabled={busy !== null} aria-busy={busy === "browse" || undefined}>
            {busy === "browse" ? <Spinner /> : <Icon name="folder" size={14} />}
            Browse…
          </button>
        )}
      </div>
      {error && (
        <p className="field-error" id={errorId} role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
