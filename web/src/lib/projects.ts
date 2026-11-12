import type { App, MachineSnapshot, Project, Snapshot, State, Worktree } from "../api/types";
import { indexApps, isVisible, projectApps, serviceCounts, worktreeApps } from "./apps";
import type { ProjectRef, Route } from "./router";

// Projects as the sidebar and the project page see them: a git repository
// with its checkouts (main first, then each linked worktree), or a task
// folder outside git. The agent groups them (internal/model/group.go).

/** The state that speaks for a group of apps: a failure first, then work in progress, then running. */
export function groupState(apps: App[]): State {
  const shown = apps.filter(isVisible);
  if (shown.some((a) => a.state === "failed")) return "failed";
  if (shown.some((a) => a.state === "starting" || a.state === "stopping")) return "starting";
  if (shown.some((a) => a.kind !== "job" && a.state === "on")) return "on";
  return "off";
}

/** Whether another project on the machine has the same name, so its address needs the runner. */
function nameTaken(ms: MachineSnapshot, project: Project): boolean {
  return ms.projects.some((p) => p !== project && p.name === project.name);
}

export function projectRoute(ms: MachineSnapshot, project: Project): Route {
  const ref: ProjectRef = { machine: ms.machine.id, name: project.name };
  if (nameTaken(ms, project)) ref.runner = project.runner;
  return { view: "project", ...ref };
}

export function findProject(snapshot: Snapshot, ref: ProjectRef): { ms: MachineSnapshot; project: Project } | null {
  const ms = snapshot.machines.find((m) => m.machine.id === ref.machine);
  if (!ms) return null;
  const project = ms.projects.find((p) => p.name === ref.name && (!ref.runner || p.runner === ref.runner));
  return project ? { ms, project } : null;
}

export interface SidebarProject {
  key: string;
  ms: MachineSnapshot;
  project: Project;
  state: State;
  running: number;
  total: number;
  route: Route;
}

/** Every project of the machines whose apps are known, this computer's first, in the agent's order. */
export function sidebarProjects(snapshot: Snapshot): SidebarProject[] {
  const out: SidebarProject[] = [];
  const machines = [...snapshot.machines].sort((a, b) => Number(b.machine.local) - Number(a.machine.local));
  for (const ms of machines) {
    if (!ms.machine.local && ms.machine.status !== "online") continue;
    const byId = indexApps(ms.apps);
    for (const project of ms.projects) {
      const apps = projectApps(project, byId);
      const { running, total } = serviceCounts(apps);
      out.push({ key: `${ms.machine.id}|${project.runner}|${project.name}`, ms, project, state: groupState(apps), running, total, route: projectRoute(ms, project) });
    }
  }
  return out;
}

const base = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? p;

/** A checkout's stable key within its project: its folder, or its name. */
export function checkoutKey(wt: Worktree): string {
  return wt.path || `\u0000${wt.name}`;
}

/**
 * What a checkout is called: a linked worktree by its folder name, a main
 * checkout as such; in a project of several repositories, each one names
 * its repository ("acme-front", "acme-front / new-ui").
 */
export function checkoutName(project: Project, wt: Worktree): string {
  const multi = (project.repos?.length ?? 0) > 1;
  const repo = wt.repo ? base(wt.repo) : "";
  if (wt.name) return multi && repo ? `${repo} / ${wt.name}` : wt.name;
  if (!wt.path && (project.repo || project.repos)) return "outside git";
  return multi && repo ? repo : "main checkout";
}

/** Whether a worktree starts folded in a list: a linked one with nothing running or failing. */
export function foldedByDefault(wt: Worktree, byId: Map<string, App>): boolean {
  if (!wt.name) return false;
  const state = groupState(worktreeApps(wt, byId));
  return state === "off";
}

/** A project's repositories and worktrees, as a few words: "3 repositories · 1 worktree". */
export function checkoutsText(project: Project): string {
  const parts: string[] = [];
  const repos = project.repos?.length ?? 0;
  if (repos > 1) parts.push(`${repos} repositories`);
  const linked = project.worktrees.filter((w) => w.name).length;
  if (linked) parts.push(`${linked} ${linked === 1 ? "worktree" : "worktrees"}`);
  return parts.join(" · ");
}
