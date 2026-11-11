import { useEffect, useRef, useState } from "react";
import { errorText } from "../api/errors";
import { useApp } from "./AppContext";
import { FolderInput } from "./FolderInput";
import { Icon, Spinner } from "./Icon";

/** Folders Portplane watches. Edits stay local until Save (PUT /api/settings). */
export function SettingsDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const { api, info, toast } = useApp();
  const ref = useRef<HTMLDialogElement>(null);
  const [saved, setSaved] = useState<string[] | null>(null);
  const [draft, setDraft] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      setDraft(null);
      setError(null);
      api.settings().then(
        (s) => {
          setSaved(s.folders);
          setDraft(s.folders);
        },
        (err: unknown) => setError(errorText(err)),
      );
    } else if (!open && d.open) {
      d.close();
    }
  }, [open, api]);

  const add = (path: string) => {
    if (!draft) return;
    if (draft.includes(path)) throw new Error("That folder is already in the list.");
    setDraft([...draft, path]);
  };

  const changed = draft !== null && saved !== null && (draft.length !== saved.length || draft.some((f, i) => f !== saved[i]));

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const s = await api.saveSettings({ folders: draft });
      setSaved(s.folders);
      toast.info("Folders saved");
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="settings-title"
      onClose={onClose}
      onClick={(e) => {
        // a click on the backdrop lands on the dialog element itself
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog-body">
        <header className="dialog-head">
          <h2 id="settings-title" className="dialog-title">
            Folders
          </h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <p className="dialog-text">
          Portplane reads the <code>dekit.yaml</code> files in these folders, and marks open ports that serve from inside them.
        </p>

        {draft === null && !error && (
          <p className="dialog-text dialog-loading">
            <Spinner /> Loading…
          </p>
        )}
        {draft !== null && (
          <>
            {draft.length === 0 ? (
              <p className="dialog-text muted">No folders yet.</p>
            ) : (
              <ul className="folder-list">
                {draft.map((f) => (
                  <li key={f} className="folder-item">
                    <Icon name="folder" size={15} className="folder-item-icon" />
                    <span className="folder-path mono" title={f}>
                      {f}
                    </span>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      aria-label={`Remove ${f}`}
                      onClick={() => setDraft(draft.filter((x) => x !== f))}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <FolderInput onAdd={add} />
          </>
        )}

        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}

        <footer className="dialog-foot">
          <span className="dialog-version">
            {info ? `Portplane ${info.version}` : ""}
            {info?.url ? (
              <>
                {" · "}
                <a href={info.url} className="addr">
                  {info.url.replace(/^https?:\/\//, "")}
                </a>
              </>
            ) : null}
          </span>
          <span className="spacer" />
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={!changed || saving} aria-busy={saving || undefined}>
            {saving && <Spinner />}
            Save
          </button>
        </footer>
      </div>
    </dialog>
  );
}
