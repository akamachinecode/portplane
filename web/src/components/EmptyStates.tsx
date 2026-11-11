import type { MachineSnapshot } from "../api/types";
import { useApp } from "./AppContext";
import { FolderInput } from "./FolderInput";
import { Icon } from "./Icon";

/** First run: no folders yet. Adding one saves the settings right away. */
export function FirstRun() {
  const { api } = useApp();
  const add = async (path: string) => {
    const current = await api.settings();
    if (current.folders.includes(path)) return;
    await api.saveSettings({ folders: [...current.folders, path] });
  };
  return (
    <section className="panel first-run" aria-labelledby="first-run-title">
      <span className="panel-icon">
        <Icon name="folder" size={22} />
      </span>
      <h3 id="first-run-title" className="panel-title">
        Pick the folders where your projects live
      </h3>
      <p className="panel-text">
        Portplane reads the <code>dekit.yaml</code> files in them and shows every dev server they define, with its state and its
        URL. You can add more folders later.
      </p>
      <FolderInput onAdd={add} autoFocus />
    </section>
  );
}

/** Folders are set, but none holds a dekit.yaml. */
export function NoApps({ ms }: { ms: MachineSnapshot }) {
  const { openSettings } = useApp();
  return (
    <section className="panel" aria-labelledby={`no-apps-${ms.machine.id}`}>
      <h3 id={`no-apps-${ms.machine.id}`} className="panel-title">
        No dev servers found yet
      </h3>
      <p className="panel-text">
        Portplane reads <code>dekit.yaml</code> files in these folders, and none of them has one:
      </p>
      <ul className="panel-folders">
        {ms.folders.map((f) => (
          <li key={f} className="mono">
            {f}
          </li>
        ))}
      </ul>
      <p className="panel-text">
        Add a <code>dekit.yaml</code> to a project, or pick other folders. Setting projects up from here comes in a later version.
      </p>
      {ms.machine.local && (
        <button type="button" className="btn" onClick={openSettings}>
          <Icon name="folder" size={14} />
          Edit folders
        </button>
      )}
    </section>
  );
}
