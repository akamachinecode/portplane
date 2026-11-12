import { useMemo } from "react";
import type { MachineSnapshot } from "../api/types";
import { checklist, checklistVisible } from "../lib/gettingStarted";
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
  const { preferences, snapshot } = useShell();
  const local = snapshot?.machines.find((m) => m.machine.local);
  const steps = useMemo(() => checklist(local), [local]);
  const step = preferences.status === "ok" ? resumeStep(preferences.value.onboarding) : "welcome";
  const add = async (path: string) => {
    const current = await api.settings();
    if (current.folders.includes(path)) return;
    await api.saveSettings({ folders: [...current.folders, path] });
  };
  // "Get started" above says the same, with every step.
  if (checklistVisible(preferences.status === "ok" ? preferences.value : null, steps)) return null;
  return (
    <section className="panel first-run" aria-labelledby="first-run-title">
      <span className="panel-icon">
        <Icon name="wand" size={22} />
      </span>
      <h3 id="first-run-title" className="panel-title">
        Set up Portplane
      </h3>
      <p className="panel-text">
        The guided setup checks this computer, installs dekit and portless if they're missing, finds the apps in your project folders and starts the
        first one. It takes about five minutes.
      </p>
      <a className="btn btn-primary first-run-start" href={href({ view: "onboarding", step })}>
        <Icon name="wand" size={14} />
        {step === "welcome" ? "Start the guided setup" : "Continue the guided setup"}
      </a>
      <details className="first-run-manual">
        <summary>Or just add a folder</summary>
        <p className="panel-text">
          Portplane reads the <code>dekit.yaml</code> files in it and shows every dev server they define, with its state and its URL.
        </p>
        <FolderInput onAdd={add} />
      </details>
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
        {ms.folders.length === 1 ? "it has none" : "none of them has one"}. Setup can find your apps and write one for you{local ? "" : `, on ${ms.machine.name}`}.
      </p>
      <ul className="panel-folders">
        {ms.folders.map((f) => (
          <li key={f} className="panel-folder">
            <span className="mono">{f}</span>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => openSetup(f, ms.machine.id)}>
              <Icon name="wand" size={14} />
              Set up this folder
            </button>
          </li>
        ))}
      </ul>
      <p className="panel-text">
        You see every change before anything is written, and the result is plain dekit config you can keep using without
        Portplane.
      </p>
      <button type="button" className="btn" onClick={local ? openSettings : () => openEditMachine(ms.machine.id)}>
        <Icon name="folder" size={14} />
        Edit folders
      </button>
    </section>
  );
}
