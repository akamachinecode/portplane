import { useEffect, useState } from "react";
import { errorText } from "../api/errors";
import { useApp } from "./AppContext";
import { Switch } from "./Controls";
import { Dialog } from "./Dialog";
import { FolderInput } from "./FolderInput";
import { Icon, Spinner } from "./Icon";

type AutostartState = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; enabled: boolean; busy: boolean };

/** Start at login (PUT /api/autostart): applies at once, unlike the folder list. */
function StartAtLogin({ open }: { open: boolean }) {
  const { api, toast } = useApp();
  const [state, setState] = useState<AutostartState>({ status: "loading" });

  useEffect(() => {
    if (!open) return;
    let live = true;
    setState({ status: "loading" });
    api.autostart().then(
      (a) => live && setState({ status: "ok", enabled: a.enabled, busy: false }),
      (err: unknown) => live && setState({ status: "error", message: errorText(err) }),
    );
    return () => {
      live = false;
    };
  }, [open, api]);

  const set = async (enabled: boolean) => {
    if (state.status !== "ok") return;
    setState({ ...state, enabled, busy: true });
    try {
      const a = await api.setAutostart(enabled);
      setState({ status: "ok", enabled: a.enabled, busy: false });
      toast.info(a.enabled ? "Portplane will start when you log in" : "Portplane won't start at login");
    } catch (err) {
      setState({ status: "ok", enabled: !enabled, busy: false });
      toast.error(`Couldn't change start at login: ${errorText(err)}`);
    }
  };

  return (
    <Switch
      label="Start Portplane at login"
      description={
        state.status === "error"
          ? `Not available here: ${state.message}`
          : "Runs in the tray or menu bar from the moment you log in, so the URLs and this page are always there."
      }
      checked={state.status === "ok" && state.enabled}
      disabled={state.status !== "ok"}
      busy={state.status === "loading" || (state.status === "ok" && state.busy)}
      onChange={(v) => void set(v)}
    />
  );
}

/** Folders Portplane watches, and app settings. Folder edits stay local until Save (PUT /api/settings). */
export function SettingsDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const { api, info, toast, openSetup } = useApp();
  const [saved, setSaved] = useState<string[] | null>(null);
  const [draft, setDraft] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDraft(null);
    setError(null);
    api.settings().then(
      (s) => {
        setSaved(s.folders);
        setDraft(s.folders);
      },
      (err: unknown) => setError(errorText(err)),
    );
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
    <Dialog
      open={open}
      onClose={onClose}
      title="Settings"
      footer={
        <>
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
        </>
      }
    >
      <section className="settings-section" aria-labelledby="settings-folders">
        <h3 id="settings-folders" className="settings-title">
          Folders
        </h3>
        <p className="dialog-text">
          Portplane reads the <code>dekit.yaml</code> files in these folders, and marks open ports that serve from inside them.{" "}
          <strong>Set up</strong> finds the apps in a folder and writes that config for you.
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
          </>
        )}

        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </section>

      <section className="settings-section" aria-labelledby="settings-startup">
        <h3 id="settings-startup" className="settings-title">
          Startup
        </h3>
        <StartAtLogin open={open} />
      </section>
    </Dialog>
  );
}
