import type { App, Project, Target, Worktree } from "../api/types";
import { projectApps, worktreeApps } from "./apps";

export function appTarget(machine: string, app: App): Target {
  return { machine, runner: app.runner, task: app.task };
}

/**
 * A project or worktree action: by path prefix when its tasks share a folder
 * in one runner, otherwise by the exact list of its tasks (jobs included, so
 * a "start all" runs the install step too), one target per runner: a
 * worktree's tasks can sit in another dekit.yaml than its project's.
 */
function groupTargets(machine: string, runner: string | undefined, prefix: string | undefined, apps: App[]): Target[] {
  const runners = [...new Set(apps.map((a) => a.runner))];
  if (prefix && runner && runners.length <= 1) return [{ machine, runner, prefix }];
  if (runners.length === 0 && runner) return [{ machine, runner, tasks: [] }];
  return runners.map((r) => ({ machine, runner: r, tasks: apps.filter((a) => a.runner === r).map((a) => a.task) }));
}

export function projectTargets(machine: string, project: Project, byId: Map<string, App>): Target[] {
  return groupTargets(machine, project.runner, project.prefix, projectApps(project, byId));
}

export function worktreeTargets(machine: string, project: Project, wt: Worktree, byId: Map<string, App>): Target[] {
  return groupTargets(machine, wt.runner ?? project.runner, wt.prefix, worktreeApps(wt, byId));
}
