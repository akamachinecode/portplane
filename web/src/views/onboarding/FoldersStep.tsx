import { useEffect, useState } from "react";
import { errorText } from "../../api/errors";
import type { FolderSuggestion } from "../../api/tools";
import { useApp } from "../../components/AppContext";
import { FolderInput } from "../../components/FolderInput";
import { Icon, Spinner } from "../../components/Icon";
import { useMachineScope } from "../../components/MachineScope";
import { LoadingState } from "../../components/States";
import { inferHome, shortenPath } from "../../lib/format";
import { useOnboarding } from "./context";
import { StepFooter, StepLayout } from "./parts";
import { folderRows, type FolderRow } from "./helpers";
import { count } from "./summary";

/** Step 5: where the projects live. */
export function FoldersStep() {
  const scope = useMachineScope();
  const { api, toast } = useApp();
  const { folders, setFolders, next } = useOnboarding();
  const [rows, setRows] = useState<FolderRow[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The saved folders and the suggestions, read fresh: the step can be the first one opened.
  useEffect(() => {
    let live = true;
    void Promise.all([api.settings().then((s) => s.folders, () => folders), api.folderSuggestions().catch(() => [] as FolderSuggestion[])]).then(
      ([saved, suggestions]) => live && setRows(folderRows(saved, suggestions)),
    );
    return () => {
      live = false;
    };
  }, [api]);

  const home = inferHome(rows?.map((r) => r.path) ?? folders);
  const chosen = rows?.filter((r) => r.checked).map((r) => r.path) ?? [];

  const add = (path: string) => {
    if (!rows) return;
    const at = rows.findIndex((r) => r.path === path);
    if (at >= 0) {
      setRows(rows.map((r, i) => (i === at ? { ...r, checked: true } : r)));
      return;
    }
    setRows([...rows, { path, checked: true }]);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const s = await api.saveSettings({ folders: chosen });
      setFolders(s.folders);
      toast.info(s.folders.length === 1 ? "Portplane watches this folder now." : `Portplane watches ${s.folders.length} folders now.`);
      next();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <StepLayout
      icon="folder"
      title="Where do your projects live?"
      lead={
        scope.remote
          ? `Pick the folders on ${scope.ms?.machine.name ?? scope.id} that hold your projects. Portplane looks for apps in them, one or two levels down, and you can change them later with Edit machine.`
          : "Pick the folders that hold your projects. Portplane looks for apps in them, one or two levels down, and you can add more later in Settings."
      }
      busy={saving}
      footer={
        <StepFooter status={chosen.length ? (chosen.length === 1 ? "One folder chosen." : `${chosen.length} folders chosen.`) : "Choose at least one folder."}>
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving || chosen.length === 0} aria-busy={saving || undefined}>
            {saving ? <Spinner size={12} /> : null}
            Find my apps
            <Icon name="chevronRight" size={14} />
          </button>
        </StepFooter>
      }
    >
      {rows === null ? (
        <LoadingState label="Looking for your project folders…" />
      ) : (
        <>
          {rows.length > 0 ? (
            <ul className="ob-folders" aria-label="Project folders">
              {rows.map((r) => (
                <li key={r.path}>
                  <label className={`ob-folder${r.checked ? " is-on" : ""}`}>
                    <input type="checkbox" checked={r.checked} onChange={(e) => setRows(rows.map((x) => (x.path === r.path ? { ...x, checked: e.target.checked } : x)))} />
                    <Icon name="folder" size={16} />
                    <span className="ob-folder-path mono">{shortenPath(r.path, home)}</span>
                    {r.repos !== undefined && <span className="ob-folder-count muted">{count(r.repos, "git repository", "git repositories")}</span>}
                  </label>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted ob-note">No usual project folder (~/code, ~/Repos, ~/src, ~/projects, ~/dev, ~/workspace) here. Choose yours below.</p>
          )}
          <div className="ob-folder-add">
            <p className="ob-folder-add-title">Another folder</p>
            <FolderInput onAdd={add} />
          </div>
          {error && (
            <p className="field-error" role="alert">
              Couldn't save the folders: {error}
            </p>
          )}
        </>
      )}
    </StepLayout>
  );
}
