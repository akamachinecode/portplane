import type { Api, PickResult } from "./client";
import { ApiError } from "./errors";
import type { FeedHandlers } from "./events";
import type { App, Excerpt, Info, MachineSnapshot, Port, Settings, Snapshot, Target, Verb } from "./types";

// A realistic snapshot for tests and for `?mock` in dev builds (main.tsx loads
// this module only when import.meta.env.DEV). `?mock=<scenario>` picks a
// variant:
//   default    two projects, worktrees, running, starting and failed apps
//   degraded   portless missing and one dekit runner down
//   readonly   neither dekit nor portless: only other ports
//   empty      folders without any dekit.yaml
//   nofolders  first run

export type Scenario = "default" | "degraded" | "readonly" | "empty" | "nofolders";

const HOME = "/home/dev";
const ROOT = `${HOME}/code`;
const UPDATED = "2026-11-11T09:30:00Z";

function app(p: Partial<App> & Pick<App, "task" | "label" | "project" | "state" | "order">): App {
  return {
    id: `${ROOT}#${p.task}`,
    runner: ROOT,
    kind: "service",
    ...p,
  };
}

export function mockApps(): App[] {
  return [
    app({ task: "my-monorepo/install", label: "install", kind: "job", project: "my-monorepo", dir: `${ROOT}/my-monorepo`, command: ["pnpm", "install"], state: "done", rawState: "exited", order: 0 }),
    app({ task: "my-monorepo/web", label: "web", project: "my-monorepo", dir: `${ROOT}/my-monorepo/apps/web`, command: ["portless", "my-monorepo", "pnpm", "run", "dev"], deps: ["my-monorepo/install"], state: "on", rawState: "running", url: "https://my-monorepo.localhost", hostname: "my-monorepo.localhost", port: 4514, ports: [4514], pid: 41201, order: 1 }),
    app({ task: "my-monorepo/api", label: "api", project: "my-monorepo", dir: `${ROOT}/my-monorepo/apps/api`, command: ["portless", "api.my-monorepo", "pnpm", "run", "dev"], deps: ["my-monorepo/install"], state: "on", rawState: "running", url: "https://api.my-monorepo.localhost", hostname: "api.my-monorepo.localhost", port: 4515, ports: [4515, 9229], pid: 41202, order: 2 }),
    app({ task: "my-monorepo/admin", label: "admin", project: "my-monorepo", dir: `${ROOT}/my-monorepo/apps/admin`, command: ["portless", "admin.my-monorepo", "pnpm", "run", "dev"], deps: ["my-monorepo/install"], state: "failed", rawState: "exited", detail: "exit code 3", hostname: "admin.my-monorepo.localhost", order: 3 }),
    app({ task: "my-monorepo/docs", label: "docs", project: "my-monorepo", dir: `${ROOT}/my-monorepo/apps/docs`, state: "starting", rawState: "running", detail: "waiting for port", hostname: "docs.my-monorepo.localhost", pid: 41260, order: 4 }),
    app({ task: "my-monorepo-checkout/install", label: "install", kind: "job", project: "my-monorepo", worktree: "checkout", dir: `${ROOT}/my-monorepo-checkout`, state: "starting", rawState: "running", detail: "running", pid: 41310, order: 5 }),
    app({ task: "my-monorepo-checkout/web", label: "web", project: "my-monorepo", worktree: "checkout", dir: `${ROOT}/my-monorepo-checkout/apps/web`, deps: ["my-monorepo-checkout/install"], state: "starting", rawState: "waiting", detail: "waiting for install", hostname: "checkout.my-monorepo.localhost", order: 6 }),
    app({ task: "my-monorepo-checkout/api", label: "api", project: "my-monorepo", worktree: "checkout", dir: `${ROOT}/my-monorepo-checkout/apps/api`, state: "off", rawState: "stopped", hostname: "api.checkout.my-monorepo.localhost", order: 7 }),
    app({ task: "blog/site", label: "site", project: "blog", dir: `${ROOT}/blog`, state: "off", rawState: "stopped", hostname: "blog.localhost", order: 8 }),
    app({ task: "blog/studio", label: "studio", project: "blog", dir: `${ROOT}/blog/studio`, state: "off", rawState: "stopped", hostname: "studio.blog.localhost", order: 9 }),
  ];
}

export function mockOtherPorts(): Port[] {
  return [
    { port: 5432, address: "127.0.0.1", pid: 1201, process: "postgres", inFolder: false },
    { port: 3000, address: "::1", pid: 52011, process: "node", dir: `${ROOT}/scratch`, project: "scratch", inFolder: true },
    { port: 6379, address: "127.0.0.1", pid: 1188, process: "redis-server", inFolder: false },
    { port: 8000, address: "0.0.0.0", pid: 60412, process: "python3", dir: `${HOME}/Downloads/report`, inFolder: false },
    { port: 5173, address: "127.0.0.1", pid: 52230, process: "node", dir: `${ROOT}/my-monorepo/packages/ui`, project: "my-monorepo", inFolder: true, route: "ui.my-monorepo.localhost" },
  ];
}

/** Groups like internal/model.Group, enough for the mock (the server does this for real). */
export function groupForMock(apps: App[]): MachineSnapshot["projects"] {
  const byProject = new Map<string, App[]>();
  for (const a of apps) byProject.set(a.project, [...(byProject.get(a.project) ?? []), a]);
  const alive = (a: App) => a.kind !== "job" && ["on", "starting", "stopping"].includes(a.state);
  const projects = [...byProject.entries()].map(([name, list]) => {
    const wts = new Map<string, App[]>();
    for (const a of list) wts.set(a.worktree ?? "", [...(wts.get(a.worktree ?? "") ?? []), a]);
    const multiWorktree = wts.size > 1;
    return {
      name,
      runner: list[0].runner,
      prefix: multiWorktree ? undefined : `${list[0].task.split("/")[0]}/`,
      running: list.filter(alive).length,
      total: list.length,
      worktrees: [...wts.entries()].map(([wt, wl]) => ({
        name: wt,
        prefix: `${wl[0].task.split("/")[0]}/`,
        running: wl.filter(alive).length,
        apps: wl.map((a) => a.id),
      })),
      order: Math.min(...list.map((a) => a.order)),
    };
  });
  projects.sort((a, b) => Number(b.running > 0) - Number(a.running > 0) || a.order - b.order);
  return projects.map(({ order: _order, ...p }) => p);
}

export function mockSnapshot(scenario: Scenario = "default"): Snapshot {
  const apps = scenario === "empty" || scenario === "nofolders" || scenario === "readonly" ? [] : mockApps();
  const ms: MachineSnapshot = {
    machine: { id: "local", name: "This computer", local: true, hostname: "workstation", os: "linux", arch: "amd64", status: "online" },
    tools: { dekit: "0.10.3", portless: "0.16.0", proxyRunning: true, proxyHttps: true, proxyPort: 443 },
    folders: scenario === "nofolders" ? [] : [ROOT],
    runners: apps.length ? [{ root: ROOT, name: "code", up: true }] : [],
    apps,
    otherPorts: mockOtherPorts(),
    projects: groupForMock(apps),
    updatedAt: UPDATED,
  };
  if (scenario === "degraded") {
    ms.tools = { dekit: "0.10.3", proxyRunning: false, proxyHttps: false };
    ms.runners = [
      { root: ROOT, name: "code", up: true },
      { root: `${HOME}/work/legacy-app`, name: "legacy-app", up: false, error: "dekit is not running in this folder" },
    ];
    for (const a of ms.apps) {
      delete a.url;
      delete a.hostname;
    }
  }
  if (scenario === "readonly") {
    ms.tools = { proxyRunning: false, proxyHttps: false };
  }
  return { machines: [ms], version: 1 };
}

const EXCERPT: Excerpt = {
  lines: [
    "> admin@0.0.0 dev",
    "> vite --port 4516 --host 127.0.0.1",
    "",
    "failed to load config from apps/admin/vite.config.ts",
    "error when starting dev server:",
    "Error: Cannot find module '@my-monorepo/ui/vite'",
    "Require stack:",
    "- apps/admin/vite.config.ts",
    "    at Module._resolveFilename (node:internal/modules/cjs/loader:1405:15)",
    "    at defaultResolveImpl (node:internal/modules/cjs/loader:1061:19)",
    " ELIFECYCLE  Command failed with exit code 3.",
  ],
  command: "dekit -C ~/code screen my-monorepo/admin",
};

/** An in-memory Api: actions change the mock snapshot after a short delay, like dekit would. */
export function createMockApi(scenario: Scenario = "default"): Api {
  let snapshot = mockSnapshot(scenario);
  let folders = [...snapshot.machines[0].folders];
  const listeners = new Set<FeedHandlers>();
  let nextPid = 50000;
  let nextPort = 4600;

  const emit = () => {
    snapshot = { ...snapshot, version: snapshot.version + 1 };
    for (const l of listeners) l.onSnapshot(snapshot);
  };
  const update = (fn: (ms: MachineSnapshot) => void) => {
    const ms = structuredClone(snapshot.machines[0]);
    fn(ms);
    ms.projects = groupForMock(ms.apps);
    ms.updatedAt = new Date().toISOString();
    snapshot = { ...snapshot, machines: [ms] };
    emit();
  };
  const setState = (ids: Set<string>, patch: (a: App) => Partial<App>) =>
    update((ms) => {
      ms.apps = ms.apps.map((a) => (ids.has(a.id) ? { ...a, ...patch(a) } : a));
    });
  const later = (ms: number, fn: () => void) => setTimeout(fn, ms);

  const matches = (t: Target, a: App) =>
    a.runner === t.runner &&
    (t.task ? a.task === t.task : t.prefix ? a.task.startsWith(t.prefix) : (t.tasks ?? []).includes(a.task));

  const running = (a: App): Partial<App> => {
    const port = a.port ?? nextPort++;
    return {
      state: "on",
      rawState: "running",
      detail: undefined,
      pid: nextPid++,
      port,
      ports: [port],
      url: a.hostname ? `https://${a.hostname}` : undefined,
    };
  };

  const delay = <T>(value: T, ms = 150) => new Promise<T>((r) => setTimeout(() => r(value), ms));

  return {
    info: () => delay<Info>({ version: "0.0.0-mock", os: "linux", arch: "amd64", url: "https://portplane.localhost", picker: true }),
    snapshot: () => delay(snapshot),
    async act(target, verb: Verb) {
      await delay(undefined, 200);
      const ids = new Set(snapshot.machines[0].apps.filter((a) => matches(target, a)).map((a) => a.id));
      if (ids.size === 0) throw new ApiError("no task matches this target", 404);
      if (verb === "stop") {
        setState(ids, () => ({ state: "stopping", rawState: "stopping" }));
        later(900, () => setState(ids, (a) => ({ state: a.kind === "job" ? "done" : "off", rawState: "stopped", pid: undefined, port: undefined, ports: undefined, url: undefined, detail: undefined })));
        return;
      }
      setState(ids, () => ({ state: "starting", rawState: "running", detail: "waiting for port" }));
      later(1600, () => setState(ids, (a) => (a.kind === "job" ? { state: "done", rawState: "exited", detail: undefined } : running(a))));
    },
    async runnerUp(_machine, root) {
      await delay(undefined, 400);
      update((ms) => {
        ms.runners = ms.runners.map((r) => (r.root === root ? { ...r, up: true, error: undefined } : r));
      });
    },
    excerpt: () => delay(EXCERPT, 300),
    open: () => delay(undefined),
    reveal: () => delay(undefined),
    settings: () => delay<Settings>({ folders }),
    async saveSettings(s) {
      await delay(undefined);
      if (s.folders.some((f) => !f.startsWith("/") && !/^[A-Za-z]:\\/.test(f))) {
        throw new ApiError("folder must be an absolute path", 400);
      }
      folders = [...s.folders];
      update((ms) => {
        ms.folders = [...folders];
        if (folders.length && ms.apps.length === 0 && scenario !== "empty" && scenario !== "readonly") {
          ms.apps = mockApps();
          ms.runners = [{ root: ROOT, name: "code", up: true }];
        }
        if (!folders.length) {
          ms.apps = [];
          ms.runners = [];
        }
      });
      return { folders };
    },
    pickFolder: () => delay<PickResult>({ kind: "picked", path: `${HOME}/projects` }, 600),
    subscribe(handlers) {
      listeners.add(handlers);
      handlers.onStatus("connecting");
      const t = setTimeout(() => {
        handlers.onStatus("live");
        handlers.onSnapshot(snapshot);
      }, 120);
      return () => {
        clearTimeout(t);
        listeners.delete(handlers);
      };
    },
  };
}
