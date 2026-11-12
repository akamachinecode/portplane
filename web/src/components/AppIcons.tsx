import type { App, MachineSnapshot, Project, State } from "../api/types";
import { appIconKey, appIconPlace, iconChoice, projectIconKey, projectIconPlace } from "../lib/icons";
import { useShell } from "../shell/ShellContext";
import { EntityIcon } from "./EntityIcon";

// EntityIcon with the user's choices from the preferences (ADR-0030).

function useChoices() {
  const { preferences } = useShell();
  return preferences.status === "ok" ? preferences.value : null;
}

/** The project an app belongs to on its machine, by name. */
export function projectOf(ms: MachineSnapshot, app: App): Project | undefined {
  return ms.projects.find((p) => p.name === app.project && (p.runner === app.runner || p.runners?.includes(app.runner))) ?? ms.projects.find((p) => p.name === app.project);
}

/** A project's icon. */
export function ProjectIcon({ ms, project, size = 18, state }: { ms: MachineSnapshot; project: Project; size?: number; state?: State }) {
  const prefs = useChoices();
  return <EntityIcon name={project.name} choice={iconChoice(prefs, projectIconKey(ms.machine.id, project))} place={projectIconPlace(ms, project)} size={size} state={state} />;
}

/** An app's icon: its own favicon, else its project's icon. */
export function AppIcon({ ms, app, size = 24, state }: { ms: MachineSnapshot; app: App; size?: number; state?: State }) {
  const prefs = useChoices();
  const project = projectOf(ms, app);
  const fallback = project
    ? { choice: iconChoice(prefs, projectIconKey(ms.machine.id, project)), place: projectIconPlace(ms, project), name: project.name }
    : undefined;
  return <EntityIcon name={app.label} choice={iconChoice(prefs, appIconKey(ms.machine.id, app))} place={appIconPlace(ms, app)} fallback={fallback} size={size} state={state} />;
}
