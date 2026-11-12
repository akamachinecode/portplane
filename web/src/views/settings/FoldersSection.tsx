import { useEffect, useState } from "react";
import { errorText } from "../../api/errors";
import { useApp } from "../../components/AppContext";
import { FolderInput } from "../../components/FolderInput";
import { Icon, Spinner } from "../../components/Icon";
import { ErrorState, LoadingState } from "../../components/States";
import { SettingsGroup } from "./SettingsGroup";

/** The folders Portplane watches. Edits stay local until Save (PUT /api/settings). */
export function FoldersSection() {
  const { api, toast, openSetup } = useApp();
  const [saved, setSaved] = useState<string[] | null>(null);
  const [draft, setDraft] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setLoadError(null);
    api.settings().then(
      (s) => {
        if (!live) return;
        setSaved(s.folders);
        setDraft(s.folders);
      },
      (err: unknown) => live && setLoadError(errorText(err)),
    );
    return () => {
      live = false;
    };
  }, [api, attempt]);

  const add = (path: string) => {
    if (!draft) return;
    if (draft.includes(path)) throw new Error("That folder is already in the list.");
    setDraft([...draft, path]);
  };

  const changed = draft !== null && saved !== null && (draft.length !== saved.length || draft.some((f, i) => f !== saved[i]));

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setSaveError(null);
    try {
      const s = await api.saveSettings({ folders: draft });
      setSaved(s.folders);
      setDraft(s.folders);
      toast.info("Folders saved");
    } catch (err) {
      setSaveError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsGroup
      title="Folders"
      description={
        <>
          Portplane reads the <code>dekit.yaml</code> files in these folders, and marks open ports that serve from inside them.{" "}
          <strong>Set up</strong> finds the apps in a folder and writes that config for you.
        </>
      }
    >
      {loadError ? (
        <ErrorState title="Couldn't load the folders" message={loadError} onRetry={() => setAttempt((n) => n + 1)} />
      ) : draft === null ? (
        <LoadingState />
      ) : (
        <>
          {draft.length === 0 ? (
            <p className="muted folders-empty">No folders yet. Add the one where your projects live.</p>
          ) : (
            <ul className="folder-list">
              {draft.map((f) => {
                const isSaved = saved?.includes(f) ?? false;
                return (
                  <li key={f} className="folder-item">
                    <Icon name="folder" size={15} className="folder-item-icon" />
                    <span className="folder-path mono" title={f}>
                      {f}
                    </span>
                    {isSaved ? (
                      <button type="button" className="btn btn-sm" aria-label={`Set up ${f}`} title="Find the apps in this folder and write their dekit config" onClick={() => openSetup(f)}>
                        <Icon name="wand" size={13} />
                        Set up…
                      </button>
                    ) : (
                      <span className="tag" title="Save to set this folder up">
                        unsaved
                      </span>
                    )}
                    <button type="button" className="btn btn-sm btn-ghost" aria-label={`Remove ${f}`} onClick={() => setDraft(draft.filter((x) => x !== f))}>
                      Remove
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <FolderInput onAdd={add} />
          {saveError && (
            <p className="field-error" role="alert">
              {saveError}
            </p>
          )}
          <div className="sgroup-foot">
            {changed && (
              <button type="button" className="btn btn-ghost" onClick={() => setDraft(saved)} disabled={saving}>
                Discard changes
              </button>
            )}
            <button type="button" className="btn btn-primary" onClick={save} disabled={!changed || saving} aria-busy={saving || undefined}>
              {saving && <Spinner />}
              Save
            </button>
          </div>
        </>
      )}
    </SettingsGroup>
  );
}
