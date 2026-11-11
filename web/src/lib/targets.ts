import type { App, Project, Target, Worktree } from "../api/types";
import { projectApps, worktreeApps } from "./apps";

export function appTarget(machine: string, app: App): Target {
  return { machine, runner: app.runner, task: app.task };
}

/**
 * A project or worktree action: by path prefix when its tasks share a folder,
 * otherwise by the exact list of its tasks (jobs included, so a "start all"
 * runs the install step too).
 */
function groupTarget(machine: string, runner: string, prefix: string | undefined, apps: App[]): Target {
  if (prefix) return { machine, runner, prefix };
  return { machine, runner, tasks: apps.map((a) => a.task) };
}

export function projectTarget(machine: string, project: Project, byId: Map<string, App>): Target {
  return groupTarget(machine, project.runner, project.prefix, projectApps(project, byId));
}

export function worktreeTarget(machine: string, project: Project, wt: Worktree, byId: Map<string, App>): Target {
  return groupTarget(machine, project.runner, wt.prefix, worktreeApps(wt, byId));
}
