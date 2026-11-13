import type { MachineSnapshot } from "../api/types";
import { inferHome, shortenPath } from "../lib/format";
import { href } from "../lib/router";
import { useShell } from "../shell/ShellContext";
import { resumeStep } from "../views/onboarding/steps";
import { useApp } from "./AppContext";
import { FolderInput } from "./FolderInput";
import { Icon } from "./Icon";
import "./EmptyStates.css";

/**
 * First run: no folders yet. It starts the guided setup, which checks the
 * tools and finds the apps (F4); adding a folder by hand stays possible.
 */
export function FirstRun() {
  const { api } = useApp();
  const { preferences } = useShell();
  const step = preferences.status === "ok" ? resumeStep(preferences.value.onboarding) : "welcome";
  const add = async (path: string) => {
    const current = await api.settings();
    if (current.folders.includes(path)) return;
    await api.saveSettings({ folders: [...current.folders, path] });
  };
  // The sidebar's setup card points at Setup too; the empty Apps page still
  // says what to do, or it would show nothing at all.
  return (
    <section className="panel first-run" aria-labelledby="first-run-title">
      <span className="panel-icon">
        <Icon name="wand" size={22} />
      </span>
      <h3 id="first-run-title" className="panel-title">
        Set up Portplane
      </h3>
      <p className="panel-text">The guided setup finds the apps in your project folders and gives each one an address, in about five minutes.</p>
      <a className="btn btn-primary first-run-start" href={href({ view: "onboarding", step })}>
        <Icon name="wand" size={14} />
        {step === "welcome" ? "Start the guided setup" : "Continue the guided setup"}
      </a>
      <details className="first-run-manual">
        <summary>Or just add a folder</summary>
        <p className="panel-text">Portplane shows every dev server its dekit.yaml files define.</p>
        <FolderInput onAdd={add} />
      </details>
    </section>
  );
}

/** Folders are set, but none holds a dekit.yaml: one message, one action (ADR-0032). */
export function NoApps({ ms }: { ms: MachineSnapshot }) {
  const { openSettings, openSetup, openEditMachine } = useApp();
  const local = ms.machine.local;
  const home = inferHome(ms.folders);
  const one = ms.folders.length === 1 ? ms.folders[0] : null;
  const titleId = `no-apps-${ms.machine.id}`;
  const edit = (
    <button type="button" className="link-btn no-apps-edit" onClick={local ? openSettings : () => openEditMachine(ms.machine.id)}>
      Edit folders
    </button>
  );
  return (
    <section className="panel no-apps" aria-labelledby={titleId}>
      <h3 id={titleId} className="panel-title">
        {one ? (
          <>
            No apps in{" "}
            <span className="mono" title={one}>
              {shortenPath(one, home)}
            </span>{" "}
            yet
          </>
        ) : (
          "No apps in your folders yet"
        )}
      </h3>
      <p className="panel-text">
        Setup finds the dev servers {one ? "in it" : "in each one"}
        {local ? "" : ` on ${ms.machine.name}`} and writes their dekit config, showing you every change first.
      </p>
      {one ? (
        <div className="no-apps-actions">
          <button type="button" className="btn btn-primary" onClick={() => openSetup(one, ms.machine.id)}>
            <Icon name="wand" size={14} />
            Set up this folder
          </button>
          {edit}
        </div>
      ) : (
        <>
          <ul className="no-apps-folders">
            {ms.folders.map((f) => (
              <li key={f}>
                <span className="mono" title={f}>
                  {shortenPath(f, home)}
                </span>
                <button type="button" className="btn btn-sm" onClick={() => openSetup(f, ms.machine.id)}>
                  Set up…
                </button>
              </li>
            ))}
          </ul>
          <div className="no-apps-actions">{edit}</div>
        </>
      )}
    </section>
  );
}
