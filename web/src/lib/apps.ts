import type { App, Machine, Project, State, Tools, Worktree } from "../api/types";

/** The app's process is running (mirrors State.Alive in Go). */
export function isAlive(state: State): boolean {
  return state === "on" || state === "starting" || state === "stopping";
}

/**
 * Jobs (install, build, codegen) only matter while they run or when they fail:
 * then they show as a step of their project. Services always show.
 */
export function isVisible(app: App): boolean {
  if (app.kind !== "job") return true;
  return app.state === "starting" || app.state === "failed";
}

export function indexApps(apps: App[]): Map<string, App> {
  return new Map(apps.map((a) => [a.id, a]));
}

/** Resolves a worktree's app IDs, in config order, dropping unknown IDs. */
export function worktreeApps(wt: Worktree, byId: Map<string, App>): App[] {
  const out: App[] = [];
  for (const id of wt.apps) {
    const app = byId.get(id);
    if (app) out.push(app);
  }
  return out;
}

export function projectApps(project: Project, byId: Map<string, App>): App[] {
  return project.worktrees.flatMap((wt) => worktreeApps(wt, byId));
}

export function visibleApps(apps: App[]): App[] {
  return apps.filter(isVisible);
}

/** "running/total" for a card: services only, so a finished install does not count as missing. */
export function serviceCounts(apps: App[]): { running: number; total: number } {
  let running = 0;
  let total = 0;
  for (const a of apps) {
    if (a.kind === "job") continue;
    total++;
    if (isAlive(a.state)) running++;
  }
  return { running, total };
}

/**
 * Where the Open link goes. Apps on other machines open through the hub
 * (ADR-0005). Without portless, a local app still opens on its port.
 */
export function appHref(app: App, machine: Machine): string | undefined {
  if (!machine.local) return app.remoteUrl ?? app.url;
  if (app.url) return app.url;
  return app.port ? `http://localhost:${app.port}` : undefined;
}

/** URLs for "Open all running": apps that are up and have somewhere to open. */
export function runningUrls(apps: App[], machine: Machine): string[] {
  return apps.flatMap((a) => (a.state === "on" ? (appHref(a, machine) ?? []) : []));
}

/**
 * The URL to copy or bookmark. While an app is off, portless still knows its
 * hostname, so the URL can be built from the proxy's scheme and port.
 */
export function bookmarkUrl(app: App, tools: Tools): string | undefined {
  if (app.url) return app.url;
  if (!app.hostname) return undefined;
  const scheme = tools.proxyHttps ? "https" : "http";
  const defaultPort = tools.proxyHttps ? 443 : 80;
  const port = tools.proxyPort && tools.proxyPort !== defaultPort ? `:${tools.proxyPort}` : "";
  return `${scheme}://${app.hostname}${port}`;
}

