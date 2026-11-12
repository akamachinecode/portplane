import { useEffect, useId, useState } from "react";
import { errorText } from "../api/errors";
import { LOCAL_MACHINE } from "../api/machine";
import { dataUrl, iconChoice, initialsOf, TINTS, tintOf, type IconChoice, type IconImage, type IconPlace } from "../lib/icons";
import { useShell } from "../shell/ShellContext";
import { useApp } from "./AppContext";
import { Dialog } from "./Dialog";
import { EntityIcon, invalidateIcons } from "./EntityIcon";
import { Icon, Spinner } from "./Icon";

type Mode = "auto" | "initials" | "image";

/**
 * Chooses an app's or a project's icon (ADR-0030): the image found in its
 * folder, its initials in a colour, or an image of the project or of this
 * computer. The choice is a preference: nothing is written in the project.
 */
export function IconDialog({
  name,
  prefKey,
  place,
  root,
  onClose,
}: {
  name: string;
  /** The preferences key ("project:<machine>|<name>" or "app:<machine>|<appId>"). */
  prefKey: string;
  /** Where its own image would be found. */
  place: IconPlace | null;
  /** The project's folder, to list its images. */
  root?: string;
  onClose(): void;
}) {
  const { api, toast } = useApp();
  const { preferences, updatePreferences } = useShell();
  const prefs = preferences.status === "ok" ? preferences.value : null;
  const current = iconChoice(prefs, prefKey);
  const [mode, setMode] = useState<Mode>(current.kind === "file" ? "image" : current.kind);
  const [text, setText] = useState(current.kind === "initials" ? (current.text ?? "") : "");
  const [tint, setTint] = useState(current.kind === "initials" ? (current.tint ?? tintOf(name)) : tintOf(name));
  const [file, setFile] = useState<{ machine: string; image: IconImage } | null>(null);
  const [candidates, setCandidates] = useState<IconImage[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textId = useId();
  const machine = place?.machine ?? LOCAL_MACHINE;

  // The images of the project, to pick one with a click.
  useEffect(() => {
    if (!root) {
      setCandidates([]);
      return;
    }
    let live = true;
    api
      .forMachine(machine)
      .iconCandidates(root)
      .then(
        (list) => live && setCandidates(list),
        () => live && setCandidates([]),
      );
    return () => {
      live = false;
    };
  }, [api, machine, root]);

  // The file chosen before, so it shows as picked.
  useEffect(() => {
    if (current.kind !== "file") return;
    let live = true;
    api
      .forMachine(current.machine)
      .iconFile(current.path)
      .then((image) => live && setFile({ machine: current.machine, image }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // only once, for the choice the dialog opened with
  }, []);

  const choice: IconChoice =
    mode === "initials"
      ? { kind: "initials", ...(text.trim() ? { text: text.trim().slice(0, 3) } : {}), tint }
      : mode === "image" && file
        ? { kind: "file", machine: file.machine, path: file.image.path }
        : { kind: "auto" };

  const pick = async () => {
    setError(null);
    try {
      const res = await api.iconPick();
      if (res.kind === "picked") {
        setFile({ machine: LOCAL_MACHINE, image: res.icon });
        setMode("image");
      } else if (res.kind === "unsupported") setError("There's no file picker on this system. Pick one of the project's images, or put an icon.svg in the project's .portplane folder.");
    } catch (err) {
      setError(errorText(err));
    }
  };

  const save = async () => {
    setBusy(true);
    const ok = await updatePreferences((p) => {
      const icons = { ...p.icons };
      if (choice.kind === "auto") delete icons[prefKey];
      else icons[prefKey] = choice;
      return { ...p, icons };
    });
    setBusy(false);
    if (!ok) {
      toast.error("Couldn't save the icon");
      return;
    }
    invalidateIcons();
    onClose();
  };

  const preview = mode === "image" && file ? dataUrl(file.image) : null;

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Icon for ${name}`}
      size="md"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy || (mode === "image" && !file)} aria-busy={busy || undefined}>
            {busy && <Spinner size={12} />}
            Save
          </button>
        </>
      }
    >
      <div className="icon-dialog">
        <div className="icon-dialog-preview" aria-hidden="true">
          {preview ? (
            <span className="entity-icon has-image" style={{ ["--icon-size" as string]: "56px" }}>
              <img src={preview} alt="" width={56} height={56} />
            </span>
          ) : (
            <EntityIcon name={name} choice={mode === "initials" ? choice : { kind: "auto" }} place={mode === "initials" ? null : place} size={56} />
          )}
          <span className="icon-dialog-name">{name}</span>
        </div>

        <div className="icon-modes" role="radiogroup" aria-label="Icon">
          <label className={`icon-mode${mode === "auto" ? " is-on" : ""}`}>
            <input type="radio" name="icon-mode" checked={mode === "auto"} onChange={() => setMode("auto")} />
            <span className="icon-mode-text">
              <span className="icon-mode-title">From its folder</span>
              <span className="icon-mode-desc">
                The favicon or logo Portplane finds there (an <code>.portplane/icon.svg</code> wins), or its initials when there is none.
              </span>
            </span>
          </label>

          <label className={`icon-mode${mode === "initials" ? " is-on" : ""}`}>
            <input type="radio" name="icon-mode" checked={mode === "initials"} onChange={() => setMode("initials")} />
            <span className="icon-mode-text">
              <span className="icon-mode-title">Initials</span>
              <span className="icon-mode-desc">Up to three letters on a colour.</span>
            </span>
          </label>
          {mode === "initials" && (
            <div className="icon-mode-body">
              <label className="field-label" htmlFor={textId}>
                Letters
              </label>
              <input id={textId} className="input icon-text" value={text} maxLength={3} placeholder={initialsOf(name)} onChange={(e) => setText(e.target.value)} />
              <div className="tints" role="radiogroup" aria-label="Colour">
                {Array.from({ length: TINTS }, (_, i) => i + 1).map((t) => (
                  <button
                    key={t}
                    type="button"
                    role="radio"
                    aria-checked={t === tint}
                    aria-label={`Colour ${t}`}
                    className="tint"
                    style={{ ["--tint" as string]: `var(--tint-${t})` }}
                    onClick={() => setTint(t)}
                  />
                ))}
              </div>
            </div>
          )}

          <label className={`icon-mode${mode === "image" ? " is-on" : ""}`}>
            <input type="radio" name="icon-mode" checked={mode === "image"} onChange={() => setMode("image")} />
            <span className="icon-mode-text">
              <span className="icon-mode-title">An image</span>
              <span className="icon-mode-desc">One of the project's images, or an SVG, PNG or ICO file from this computer.</span>
            </span>
          </label>
          {mode === "image" && (
            <div className="icon-mode-body">
              {candidates === null ? (
                <p className="muted">
                  <Spinner size={12} /> Looking for images in the project…
                </p>
              ) : candidates.length > 0 ? (
                <ul className="icon-grid" aria-label="The project's images">
                  {candidates.map((c) => {
                    const on = file?.image.path === c.path;
                    return (
                      <li key={c.path}>
                        <button type="button" className="icon-cell" aria-pressed={on} title={c.path} onClick={() => setFile({ machine, image: c })}>
                          <img src={dataUrl(c)} alt="" width={32} height={32} />
                          <span className="icon-cell-path mono">{c.path.split(/[\\/]/).slice(-2).join("/")}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="muted">No icon-like images in the project.</p>
              )}
              <button type="button" className="btn btn-sm" onClick={() => void pick()}>
                <Icon name="image" size={13} />
                Choose a file…
              </button>
              {file && !candidates?.some((c) => c.path === file.image.path) && <p className="muted mono icon-file">{file.image.path}</p>}
              {error && <p className="field-error">{error}</p>}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
