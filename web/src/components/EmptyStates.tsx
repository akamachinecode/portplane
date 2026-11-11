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
  const { openSettings, openSetup, openEditMachine } = useApp();
  const local = ms.machine.local;
  return (
    <section className="panel" aria-labelledby={`no-apps-${ms.machine.id}`}>
      <h3 id={`no-apps-${ms.machine.id}`} className="panel-title">
        No dev servers found yet
      </h3>
      <p className="panel-text">
        Portplane reads <code>dekit.yaml</code> files in {ms.folders.length === 1 ? "this folder" : "these folders"}, and{" "}
        {ms.folders.length === 1 ? "it has none" : "none of them has one"}
        {local ? ". Setup can find your apps and write one for you." : "."}
      </p>
      <ul className="panel-folders">
        {ms.folders.map((f) => (
          <li key={f} className="panel-folder">
            <span className="mono">{f}</span>
            {local && (
              <button type="button" className="btn btn-sm btn-primary" onClick={() => openSetup(f)}>
                <Icon name="wand" size={14} />
                Set up this folder
              </button>
            )}
          </li>
        ))}
      </ul>
      {local ? (
        <p className="panel-text">
          You see every change before anything is written, and the result is plain dekit config you can keep using without
          Portplane.
        </p>
      ) : (
        <p className="panel-text">
          Add a <code>dekit.yaml</code> to a project on that machine, or watch other folders there. Setting up other machines from
          here comes in a later version.
        </p>
      )}
      <button type="button" className="btn" onClick={local ? openSettings : () => openEditMachine(ms.machine.id)}>
        <Icon name="folder" size={14} />
        Edit folders
      </button>
    </section>
  );
}
