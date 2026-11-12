import type { MachineSnapshot, Preferences } from "../api/types";
import type { IconName } from "../components/Icon";
import type { StepId } from "../views/onboarding/steps";

// The "Get started" checklist on the Apps view and its count in the sidebar
// (ADR-0027): four things that take someone from nothing to their first app
// at https://<name>.localhost. Each is read from the live snapshot, not
// from what the guided setup remembers, so a tool installed from a terminal
// ticks its item too.

export type ChecklistId = "tools" | "https" | "projects" | "start";

export interface ChecklistItem {
  id: ChecklistId;
  title: string;
  /** One line under the title. */
  summary: string;
  /** What the open item explains. */
  body: string;
  icon: IconName;
  done: boolean;
  /** The guided setup's step that does it. */
  step: StepId;
  action: string;
}

export function checklist(local: MachineSnapshot | undefined): ChecklistItem[] {
  const tools = local?.tools;
  const hasTools = !!tools?.dekit && !!tools?.portless;
  const https = !!tools?.proxyRunning && !!tools?.proxyHttps;
  const services = (local?.apps ?? []).filter((a) => a.kind !== "job");
  const hasProjects = (local?.folders.length ?? 0) > 0 && services.length > 0;
  const started = services.some((a) => a.state === "on" || a.state === "starting");
  return [
    {
      id: "tools",
      title: "Install dekit and portless",
      summary: hasTools ? `dekit ${tools?.dekit} and portless ${tools?.portless}` : "The two tools Portplane drives",
      body: "dekit starts and watches each dev server; portless gives each one a stable https://….localhost address. Portplane checks this computer and installs whatever is missing, Node.js included, without a terminal.",
      icon: "box",
      done: hasTools,
      step: "check",
      action: "Check this computer",
    },
    {
      id: "https",
      title: "Turn on HTTPS addresses",
      summary: https ? `The proxy answers on port ${tools?.proxyPort ?? 443}` : "One password prompt, asked by your system",
      body: "portless runs a small proxy that answers every .localhost address and passes each request to the right app, with a certificate your browsers trust. Your system asks for your password once; Portplane never sees it.",
      icon: "shield",
      done: https,
      step: "proxy",
      action: "Set up HTTPS",
    },
    {
      id: "projects",
      title: "Add your projects",
      summary: hasProjects ? `${services.length} ${services.length === 1 ? "app" : "apps"} in ${local?.folders.length} ${local?.folders.length === 1 ? "folder" : "folders"}` : "Pick the folders where your code lives",
      body: "Portplane finds the dev servers in your folders (Next, Vite, Astro and more), worktrees included, and writes plain dekit config you can keep using from a terminal. Existing dekit.yaml files are read as they are.",
      icon: "folder",
      done: hasProjects,
      step: "folders",
      action: "Choose folders",
    },
    {
      id: "start",
      title: "Start your first app",
      summary: started ? "Something is running" : "And open it at its address",
      body: "Start an app and open it at its https://….localhost address. Its output, configuration and URL are one click away in its details.",
      icon: "play",
      done: started,
      step: "start",
      action: "Start an app",
    },
  ];
}

/** The checklist shows until everything is done or the user hides it. */
export function checklistVisible(prefs: Preferences | null, items: ChecklistItem[]): boolean {
  if (!prefs) return false;
  if (prefs.onboarding.choices?.checklist === "hidden") return false;
  return items.some((i) => !i.done);
}

export function doneCount(items: ChecklistItem[]): number {
  return items.filter((i) => i.done).length;
}
