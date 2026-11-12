import type { Api, PickResult } from "./client";
import { ApiError } from "./errors";
import type { FeedHandlers } from "./events";
import { clearAgentOutdated, LOCAL_MACHINE, machineScoper, type MachineParts } from "./machine";
import { MOCK_REMOTE_ROOT, scopeMockContext, type MockContext } from "./mockContext";
import { createMockDekit } from "./mockDekit";
import { createMockJobs, demoJob } from "./mockJobs";
import { createMockPolish } from "./mockPolish";
import { createMockIcons } from "./mockIcons";
import { createMockOutput } from "./mockOutput";
import { createMockPortless } from "./mockPortless";
import { createMockSetup } from "./mockSetup";
import { createMockTools, evaluateMachine } from "./mockTools";
import { DEFAULT_PREFERENCES, preferencesProblem } from "../lib/preferences";
import type {
  App,
  Excerpt,
  Proposal,
  Info,
  MachineCandidate,
  MachineSettings,
  MachineSnapshot,
  Port,
  Preferences,
  Settings,
  Snapshot,
  Target,
  Verb,
} from "./types";

// A realistic snapshot for tests and for `?mock` in dev builds (main.tsx loads
// this module only when import.meta.env.DEV). `?mock=<scenario>` picks a
// variant:
//   default    two projects, worktrees, running, starting and failed apps;
//              a remote machine online with apps, and one offline
//   degraded   portless missing and one dekit runner down
//   readonly   neither dekit nor portless: only other ports
//   empty      folders without any dekit.yaml
//   nofolders  first run, with the tools already installed
//   fresh      first run on a computer without dekit, portless or Node.js
//   node20     first run with Node.js 20 (too old for portless)
//   nopassword first run where no password dialog can open (the proxy
//              service fails with the command to run by hand)
//   many       300 apps in 25 projects (long lists, windowing)
// and, for sharing, compose and LAN mode (mockSharing.ts):
//   tailnet    every way to share ready, apps shared on the tailnet and Funnel
//   bare       no Tailscale, ngrok, cloudflared, Docker or Avahi
//   compose    Docker Compose projects: running, stopped and brought down
//
//   products   one dekit.yaml for every repository: a product of three
//              repositories, worktrees in a worktrees/ folder, a task
//              outside git next to a repository's worktree
//   oldagent   like default, but the remote machine runs an agent older
//              than this Portplane (ADR-0026: "Update the agent")
//
// The remote machine (box) has its own setup, dekit and portless state,
// reached through api.forMachine("box") like the real /api/m/box/….

export type Scenario =
  | "default"
  | "degraded"
  | "readonly"
  | "empty"
  | "nofolders"
  | "fresh"
  | "node20"
  | "nopassword"
  | "many"
  | "tailnet"
  | "bare"
  | "compose"
  | "oldagent"
  | "products";

/** The agent version ?mock=oldagent gives the remote machine: one from before the machine API. */
export const MOCK_OLD_AGENT = "0.2.0";

/** Scenarios that start on the guided setup, with no folders. */
export const FIRST_RUN: readonly Scenario[] = ["nofolders", "fresh", "node20", "nopassword"];

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
  const mono = { repo: `${ROOT}/my-monorepo`, checkout: `${ROOT}/my-monorepo`, branch: "main" };
  const monoWt = { repo: `${ROOT}/my-monorepo`, checkout: `${ROOT}/my-monorepo-checkout`, branch: "feat/checkout" };
  const blog = { repo: `${ROOT}/blog`, checkout: `${ROOT}/blog`, branch: "main" };
  // A worktree whose tasks sit in a "worktrees/" folder of the same
  // dekit.yaml: the agent puts it under its repository (JoinWorktrees).
  const blogWt = { repo: `${ROOT}/blog`, checkout: `${ROOT}/worktrees/redesign`, branch: "design/new", worktree: "redesign" };
  return [
    app({ task: "my-monorepo/install", label: "install", kind: "job", project: "my-monorepo", ...mono, dir: `${ROOT}/my-monorepo`, command: ["pnpm", "install"], state: "done", rawState: "exited", order: 0 }),
    app({ task: "my-monorepo/web", label: "web", project: "my-monorepo", ...mono, dir: `${ROOT}/my-monorepo/apps/web`, command: ["portless", "my-monorepo", "pnpm", "run", "dev"], deps: ["my-monorepo/install"], tags: ["frontend", "autostart"], state: "on", rawState: "running", url: "https://my-monorepo.localhost", hostname: "my-monorepo.localhost", port: 4514, ports: [4514], pid: 41201, order: 1 }),
    app({ task: "my-monorepo/api", label: "api", project: "my-monorepo", ...mono, dir: `${ROOT}/my-monorepo/apps/api`, command: ["portless", "api.my-monorepo", "pnpm", "run", "dev"], deps: ["my-monorepo/install"], tags: ["backend", "autostart"], state: "on", rawState: "running", url: "https://api.my-monorepo.localhost", hostname: "api.my-monorepo.localhost", port: 4515, ports: [4515, 9229], pid: 41202, order: 2 }),
    app({ task: "my-monorepo/admin", label: "admin", project: "my-monorepo", ...mono, dir: `${ROOT}/my-monorepo/apps/admin`, command: ["portless", "admin.my-monorepo", "pnpm", "run", "dev"], deps: ["my-monorepo/install"], tags: ["frontend"], state: "failed", rawState: "exited", detail: "exit code 3", hostname: "admin.my-monorepo.localhost", order: 3 }),
    app({ task: "my-monorepo/docs", label: "docs", project: "my-monorepo", ...mono, dir: `${ROOT}/my-monorepo/apps/docs`, tags: ["docs"], state: "starting", rawState: "running", detail: "waiting for port", hostname: "docs.my-monorepo.localhost", pid: 41260, order: 4 }),
    app({ task: "my-monorepo-checkout/install", label: "install", kind: "job", project: "my-monorepo", worktree: "checkout", ...monoWt, dir: `${ROOT}/my-monorepo-checkout`, state: "starting", rawState: "running", detail: "running", pid: 41310, order: 5 }),
    app({ task: "my-monorepo-checkout/web", label: "web", project: "my-monorepo", worktree: "checkout", ...monoWt, dir: `${ROOT}/my-monorepo-checkout/apps/web`, deps: ["my-monorepo-checkout/install"], tags: ["frontend"], state: "starting", rawState: "waiting", detail: "waiting for install", hostname: "checkout.my-monorepo.localhost", order: 6 }),
    app({ task: "my-monorepo-checkout/api", label: "api", project: "my-monorepo", worktree: "checkout", ...monoWt, dir: `${ROOT}/my-monorepo-checkout/apps/api`, tags: ["backend"], state: "off", rawState: "stopped", hostname: "api.checkout.my-monorepo.localhost", order: 7 }),
    app({ task: "blog/site", label: "site", project: "blog", ...blog, dir: `${ROOT}/blog`, tags: ["frontend"], state: "off", rawState: "stopped", hostname: "blog.localhost", order: 8 }),
    app({ task: "blog/studio", label: "studio", project: "blog", ...blog, dir: `${ROOT}/blog/studio`, tags: ["cms"], state: "off", rawState: "stopped", hostname: "studio.blog.localhost", order: 9 }),
    app({ task: "worktrees/redesign/site", label: "site", project: "blog", ...blogWt, dir: `${ROOT}/worktrees/redesign`, tags: ["frontend"], state: "off", rawState: "stopped", hostname: "redesign.blog.localhost", order: 10 }),
    app({ task: "worktrees/redesign/studio", label: "studio", project: "blog", ...blogWt, dir: `${ROOT}/worktrees/redesign/studio`, tags: ["cms"], state: "off", rawState: "stopped", hostname: "studio.redesign.blog.localhost", order: 11 }),
  ];
}

/** 25 projects of 12 apps each, in every state: for long lists. */
export function mockManyApps(): App[] {
  const names = ["web", "api", "admin", "docs", "worker", "auth", "billing", "search", "mail", "cron", "gateway", "storybook"];
  const states: Array<App["state"]> = ["on", "on", "off", "on", "off", "starting", "on", "off", "failed", "on", "off", "on"];
  const out: App[] = [];
  for (let p = 0; p < 25; p++) {
    const project = `service-${String(p + 1).padStart(2, "0")}`;
    names.forEach((name, i) => {
      const state = states[(i + p) % states.length];
      const host = `${name}.${project}.localhost`;
      out.push(
        app({
          task: `${project}/${name}`,
          label: name,
          project,
          dir: `${ROOT}/${project}/apps/${name}`,
          tags: [i % 3 === 0 ? "frontend" : "backend", ...(i < 2 ? ["autostart"] : [])],
          state,
          rawState: state === "on" ? "running" : state === "failed" ? "exited" : "stopped",
          hostname: host,
          ...(state === "on" ? { url: `https://${host}`, port: 4000 + out.length, ports: [4000 + out.length], pid: 30000 + out.length } : {}),
          ...(state === "failed" ? { detail: "exit code 1" } : {}),
          order: out.length,
        }),
      );
    });
  }
  return out;
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

/** The longest folder prefix ("a/b/") every task path shares, like model.CommonPrefix. */
function commonPrefix(tasks: string[]): string {
  if (!tasks.length) return "";
  const dir = (t: string) => (t.includes("/") ? t.slice(0, t.lastIndexOf("/")).split("/") : []);
  let common = dir(tasks[0]);
  for (const t of tasks.slice(1)) {
    const d = dir(t);
    let n = 0;
    while (n < common.length && n < d.length && common[n] === d[n]) n++;
    common = common.slice(0, n);
  }
  return common.length ? `${common.join("/")}/` : "";
}

/**
 * Groups like internal/model.Group (the server does this for real): a task
 * folder with the repositories configured in it and their worktrees from
 * any folder, plus tasks outside git in a folder of the same name. Renames
 * each app's project, as the agent does.
 */
export function groupForMock(apps: App[]): MachineSnapshot["projects"] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x);
    if (p === undefined) {
      parent.set(x, x);
      return x;
    }
    if (p === x) return x;
    const r = find(p);
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  const folderNode = (a: App) => `f\u0000${a.runner}\u0000${a.project}`;
  const repoNode = (r: string) => `r\u0000${r}`;
  const node = apps.map((a) => {
    const n = a.repo ? repoNode(a.repo) : folderNode(a);
    if (a.repo && !a.worktree) union(folderNode(a), n);
    else find(n);
    return n;
  });
  const naming = () => {
    const folders = new Map<string, string[]>();
    const repos = new Map<string, string[]>();
    const push = (m: Map<string, string[]>, k: string, v: string) => {
      const l = m.get(k) ?? [];
      if (!l.includes(v)) l.push(v);
      m.set(k, l);
    };
    for (const a of apps) {
      if (a.repo) push(repos, find(repoNode(a.repo)), a.repo);
      if (a.repo && a.worktree) continue;
      push(folders, find(folderNode(a)), a.project);
    }
    const names = new Map<string, string>();
    for (const n of node) {
      const root = find(n);
      if (names.has(root)) continue;
      const f = folders.get(root) ?? [];
      const r = repos.get(root) ?? [];
      const base = (x: string) => x.split("/").pop() ?? x;
      names.set(root, f.length === 1 ? f[0] : r.length === 1 || (f.length === 0 && r.length > 0) ? base(r[0]) : f[0]);
    }
    return { names, repos };
  };
  let { names, repos } = naming();
  const withRepo = new Map<string, string[]>();
  for (const [root, n] of names) if ((repos.get(root) ?? []).length) withRepo.set(n, [...(withRepo.get(n) ?? []), root]);
  let merged = false;
  for (const [root, n] of names) {
    const target = withRepo.get(n);
    if (!(repos.get(root) ?? []).length && target?.length === 1) {
      union(target[0], root);
      merged = true;
    }
  }
  if (merged) ({ names, repos } = naming());
  apps.forEach((a, i) => (a.project = names.get(find(node[i]))!));

  const byProject = new Map<string, App[]>();
  apps.forEach((a, i) => {
    const k = find(node[i]);
    byProject.set(k, [...(byProject.get(k) ?? []), a]);
  });
  const alive = (a: App) => a.kind !== "job" && ["on", "starting", "stopping"].includes(a.state);
  const clash = (runner: string, prefix: string, members: App[]) => apps.some((a) => a.runner === runner && a.task.startsWith(prefix) && !members.includes(a));
  const projects = [...byProject.entries()].map(([root, list]) => {
    const wts = new Map<string, App[]>();
    for (const a of list) {
      const k = a.checkout || `\u0000${a.worktree ?? ""}`;
      wts.set(k, [...(wts.get(k) ?? []), a]);
    }
    const runners = [...new Set(list.map((a) => a.runner))];
    const main = list.find((a) => !a.repo || !a.worktree) ?? list[0];
    const rs = repos.get(root) ?? [];
    const prefix = runners.length === 1 ? commonPrefix(list.map((a) => a.task)) : "";
    return {
      name: names.get(root)!,
      runner: main.runner,
      ...(runners.length > 1 ? { runners } : {}),
      ...(rs.length === 1 ? { repo: rs[0] } : rs.length > 1 ? { repos: rs } : {}),
      prefix: prefix && !clash(main.runner, prefix, list) ? prefix : undefined,
      running: list.filter(alive).length,
      total: list.filter((a) => a.kind !== "job").length,
      worktrees: [...wts.values()]
        .sort((a, b) => Number(!!a[0].worktree) - Number(!!b[0].worktree))
        .map((wl) => {
          const wtRunners = new Set(wl.map((a) => a.runner));
          const p = wtRunners.size === 1 ? commonPrefix(wl.map((a) => a.task)) : "";
          return {
            name: wl[0].worktree ?? "",
            ...(wl[0].checkout ? { path: wl[0].checkout } : {}),
            ...(wl[0].branch ? { branch: wl[0].branch } : {}),
            ...(wl[0].repo ? { repo: wl[0].repo } : {}),
            ...(wtRunners.size === 1 ? { runner: wl[0].runner } : {}),
            prefix: p && !clash(wl[0].runner, p, wl) ? p : undefined,
            running: wl.filter(alive).length,
            apps: wl.map((a) => a.id),
          };
        }),
      order: Math.min(...list.map((a) => a.order)),
    };
  });
  projects.sort((a, b) => Number(b.running > 0) - Number(a.running > 0) || a.order - b.order);
  return projects.map(({ order: _order, ...p }) => p);
}

/** The owner's kind of setup (?mock=products): one dekit.yaml for every repository. */
export function mockProductApps(): App[] {
  const R = ROOT;
  const at = (repo: string, checkout = repo, branch = "main", worktree?: string) => ({ repo: `${R}/${repo}`, checkout: `${R}/${checkout}`, branch, ...(worktree ? { worktree } : {}) });
  return [
    app({ task: "acme/api", label: "api", project: "acme", ...at("acme-backend"), dir: `${R}/acme-backend`, state: "on", rawState: "running", url: "https://api.acme.localhost", hostname: "api.acme.localhost", port: 4637, ports: [4637], pid: 5001, order: 0 }),
    app({ task: "acme/web", label: "web", project: "acme", ...at("acme-front"), dir: `${R}/acme-front`, state: "on", rawState: "running", url: "https://acme.localhost", hostname: "acme.localhost", port: 4405, ports: [4405], pid: 5002, order: 1 }),
    app({ task: "acme/app", label: "app", project: "acme", ...at("acme-webapp"), dir: `${R}/acme-webapp`, state: "on", rawState: "running", url: "https://app.acme.localhost", hostname: "app.acme.localhost", port: 4609, ports: [4609], pid: 5003, order: 2 }),
    app({ task: "worktrees/new-ui/web", label: "web (feat/new-ui)", project: "worktrees", ...at("acme-front", "worktrees/new-ui", "feat/new-ui", "new-ui"), dir: `${R}/worktrees/new-ui`, state: "off", rawState: "stopped", hostname: "new-ui.acme.localhost", order: 3 }),
    app({ task: "worktrees/v2/web", label: "web (v2)", project: "worktrees", ...at("symposium", "worktrees/v2", "v2/new-platform", "v2"), dir: `${R}/worktrees/v2`, state: "off", rawState: "stopped", hostname: "v2.symposium.localhost", order: 4 }),
    app({ task: "worktrees/v2/api", label: "api (v2)", project: "worktrees", ...at("symposium", "worktrees/v2", "v2/new-platform", "v2"), dir: `${R}/worktrees/v2/api`, state: "off", rawState: "stopped", hostname: "api.v2.symposium.localhost", order: 5 }),
    app({ task: "symposium/install", label: "install", kind: "job", project: "symposium", state: "done", rawState: "exited", order: 6 }),
    app({ task: "panel", label: "panel", project: "panel", ...at("panel"), dir: `${R}/panel`, state: "on", rawState: "running", url: "https://panel.localhost", hostname: "panel.localhost", port: 4136, ports: [4136], pid: 5010, order: 7 }),
  ];
}

const REMOTE_ROOT = MOCK_REMOTE_ROOT;

function remoteApp(p: Partial<App> & Pick<App, "task" | "label" | "state" | "order">): App {
  return { id: `${REMOTE_ROOT}#${p.task}`, runner: REMOTE_ROOT, kind: "service", project: "shop", ...p };
}

/** A Linux box reached over SSH, with a project running (ADR-0015, ADR-0016). */
export function mockRemote(): MachineSnapshot {
  const apps: App[] = [
    remoteApp({ task: "shop/install", label: "install", kind: "job", dir: `${REMOTE_ROOT}/shop`, state: "done", rawState: "exited", order: 0 }),
    remoteApp({ task: "shop/web", label: "web", dir: `${REMOTE_ROOT}/shop/apps/web`, deps: ["shop/install"], state: "on", rawState: "running", url: "https://shop.localhost", hostname: "shop.localhost", remoteUrl: "https://shop.box.localhost", port: 4310, ports: [4310], pid: 2210, order: 1 }),
    remoteApp({ task: "shop/api", label: "api", dir: `${REMOTE_ROOT}/shop/apps/api`, deps: ["shop/install"], state: "on", rawState: "running", url: "https://api.shop.localhost", hostname: "api.shop.localhost", remoteUrl: "https://api.shop.box.localhost", port: 4311, ports: [4311], pid: 2214, order: 2 }),
    remoteApp({ task: "shop/worker", label: "worker", dir: `${REMOTE_ROOT}/shop/apps/worker`, deps: ["shop/install"], state: "off", rawState: "stopped", hostname: "worker.shop.localhost", order: 3 }),
  ];
  return {
    machine: { id: "box", name: "box", local: false, hostname: "box", os: "linux", arch: "arm64", status: "online", agent: "0.0.0-mock" },
    tools: { dekit: "0.10.3", portless: "0.16.0", proxyRunning: true, proxyHttps: true, proxyPort: 443 },
    folders: [REMOTE_ROOT],
    runners: [{ root: REMOTE_ROOT, name: "src", up: true }],
    apps,
    otherPorts: [
      { port: 5432, address: "127.0.0.1", pid: 812, process: "postgres", inFolder: false },
      { port: 8080, address: "0.0.0.0", pid: 3012, process: "node", dir: `${REMOTE_ROOT}/scratch`, project: "scratch", inFolder: true },
    ],
    projects: groupForMock(apps),
    updatedAt: UPDATED,
  };
}

/** A machine that was added but can't be reached right now. */
export function mockOffline(): MachineSnapshot {
  return {
    machine: { id: "mini", name: "mac-mini", local: false, status: "offline", error: "ssh: connect to host mac-mini.local port 22: Operation timed out" },
    tools: { proxyRunning: false, proxyHttps: false },
    folders: ["/Users/dev/code"],
    runners: [],
    apps: [],
    otherPorts: [],
    projects: [],
    updatedAt: UPDATED,
  };
}

const MOCK_MACHINES: MachineSettings[] = [
  { id: "box", name: "box", host: "box", folders: [REMOTE_ROOT] },
  { id: "mini", name: "mac-mini", host: "dev@mac-mini.local", folders: ["/Users/dev/code"] },
];

export const MOCK_CANDIDATES: MachineCandidate[] = [
  { host: "box", name: "box", source: "ssh-config" },
  { host: "build", name: "build", source: "ssh-config" },
  { host: "pi", name: "pi", source: "ssh-config" },
  { host: "mac-mini", name: "mac-mini", source: "tailscale", os: "macOS", online: false },
  { host: "box", name: "box", source: "tailscale", os: "linux", online: true },
  { host: "pi", name: "pi", source: "tailscale", os: "linux", online: true },
];

export function mockSnapshot(scenario: Scenario = "default"): Snapshot {
  const first = FIRST_RUN.includes(scenario);
  const apps = scenario === "empty" || scenario === "readonly" || first ? [] : scenario === "many" ? mockManyApps() : scenario === "products" ? mockProductApps() : mockApps();
  const ms: MachineSnapshot = {
    machine: { id: "local", name: "This computer", local: true, hostname: "workstation", os: "linux", arch: "amd64", status: "online" },
    tools: { dekit: "0.10.3", portless: "0.16.0", proxyRunning: true, proxyHttps: true, proxyPort: 443 },
    folders: first ? [] : [ROOT],
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
  if (scenario === "readonly" || scenario === "fresh" || scenario === "node20") {
    ms.tools = { proxyRunning: false, proxyHttps: false };
  }
  if (scenario === "nopassword") {
    ms.tools = { dekit: "0.10.3", portless: "0.16.0", proxyRunning: false, proxyHttps: false };
  }
  if (scenario === "default") return { machines: [ms, mockRemote(), mockOffline()], version: 1 };
  if (scenario === "oldagent") {
    const box = mockRemote();
    box.machine.agent = MOCK_OLD_AGENT;
    return { machines: [ms, box, mockOffline()], version: 1 };
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

/** What a scan of a folder other than ~/code finds in the mock: a Django site. */
function otherFolderProposal(folder: string): Proposal {
  return {
    folder,
    apps: [],
    unsupported: [{ project: "django-site", dir: "django-site", kinds: ["Docker Compose", "Python"] }],
    warnings: [],
    change: { added: [], changed: [], removed: [] },
    files: [],
    digest: "00000000",
  };
}

/** Test and debug hooks of the mock, on top of the Api. */
export interface MockControls {
  /** Edits the folder behind setup's back: the next write gets a 409. */
  touchSetupFolder(): void;
  /** Starts a fake install job (the palette's "Run a demo job"); returns its id. */
  startDemoJob(fail?: boolean): string;
}

/** Preferences a mock starts with: first run has not been through onboarding. */
export function mockPreferences(scenario: Scenario): Preferences {
  const done = !FIRST_RUN.includes(scenario);
  return { ...structuredClone(DEFAULT_PREFERENCES), onboarding: { completed: done, skipped: false, done: [] } };
}

/** An in-memory Api: actions change the mock snapshot after a short delay, like dekit would. */
export function createMockApi(scenario: Scenario = "default"): Api & MockControls {
  let snapshot = mockSnapshot(scenario);
  let folders = [...snapshot.machines[0].folders];
  let machines: MachineSettings[] = scenario === "default" || scenario === "oldagent" ? structuredClone(MOCK_MACHINES) : [];
  let autostart = false;
  let preferences = mockPreferences(scenario);
  const jobs = createMockJobs();
  const setup = createMockSetup(scenario === "empty" || scenario === "readonly" || FIRST_RUN.includes(scenario) ? "fresh" : "existing", ROOT);
  const listeners = new Set<FeedHandlers>();
  let nextPid = 50000;
  let nextPort = 4600;

  const emit = () => {
    snapshot = { ...snapshot, version: snapshot.version + 1 };
    for (const l of listeners) l.onSnapshot(snapshot);
  };
  const update = (fn: (ms: MachineSnapshot) => void, machine = "local") => {
    const i = snapshot.machines.findIndex((m) => m.machine.id === machine);
    if (i < 0) return;
    const ms = structuredClone(snapshot.machines[i]);
    fn(ms);
    ms.projects = groupForMock(ms.apps);
    ms.updatedAt = new Date().toISOString();
    snapshot = { ...snapshot, machines: snapshot.machines.map((m, j) => (j === i ? ms : m)) };
    emit();
  };
  const setState = (machine: string, ids: Set<string>, patch: (a: App) => Partial<App>) =>
    update((ms) => {
      ms.apps = ms.apps.map((a) => (ids.has(a.id) ? { ...a, ...patch(a) } : a));
    }, machine);
  const machineSnap = (id: string) => snapshot.machines.find((m) => m.machine.id === id);
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
  const abortable = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new DOMException("The request was cancelled", "AbortError"));
      });
    });
  const machineError = (id: string) => new ApiError(`unknown machine "${id}"`, 400);

  jobs.onChange((job) => {
    for (const l of listeners) l.onJob?.(job);
  });
  const ctx: MockContext = { scenario, snapshot: () => snapshot, update, delay, later, jobs };
  const tools = createMockTools(ctx);

  const api: Api & MockControls = {
    ...createMockPortless(ctx),
    ...createMockDekit(ctx),
    ...tools,
    ...createMockPolish(ctx),
    ...createMockIcons(ctx),
    info: () => delay<Info>({ version: "0.0.0-mock", os: "linux", arch: "amd64", url: "https://portplane.localhost", picker: true }),
    snapshot: () => delay(snapshot),
    async act(target, verb: Verb) {
      await delay(undefined, 200);
      const m = target.machine;
      const ids = new Set((machineSnap(m)?.apps ?? []).filter((a) => matches(target, a)).map((a) => a.id));
      if (ids.size === 0) throw new ApiError("no task matches this target", 404);
      if (verb === "rm") {
        const apps = machineSnap(m)?.apps.filter((a) => ids.has(a.id)) ?? [];
        const kept = apps.find((a) => !a.dynamic && !a.portplane);
        if (kept) throw new ApiError(`${kept.label} is in your dekit.yaml: remove it there (Portplane only removes the tasks it added or ones started with Run a command)`, 400);
        update((ms) => (ms.apps = ms.apps.filter((a) => !ids.has(a.id))), m);
        return;
      }
      if (verb === "stop" || verb === "kill" || verb === "veto") {
        const detail = verb === "veto" ? "kept stopped" : undefined;
        setState(m, ids, () => ({ state: "stopping", rawState: "stopping" }));
        later(verb === "kill" ? 200 : 900, () => setState(m, ids, (a) => ({ state: a.kind === "job" ? "done" : "off", rawState: "idle", pid: undefined, port: undefined, ports: undefined, url: undefined, remoteUrl: undefined, detail })));
        return;
      }
      setState(m, ids, () => ({ state: "starting", rawState: "running", detail: "waiting for port" }));
      later(1600, () =>
        setState(m, ids, (a) => {
          if (a.kind === "job") return { state: "done", rawState: "exited", detail: undefined };
          const up = running(a);
          return m === "local" || !a.hostname ? up : { ...up, remoteUrl: `https://${a.hostname.replace(/\.localhost$/, "")}.${m}.localhost` };
        }),
      );
    },
    async runnerUp(machine, root) {
      await delay(undefined, 400);
      update((ms) => {
        ms.runners = ms.runners.map((r) => (r.root === root ? { ...r, up: true, error: undefined } : r));
      }, machine);
    },
    excerpt: () => delay(EXCERPT, 300),
    ...createMockOutput(ctx),
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
        // A first run gets its apps from setup; the other scenarios show the demo apps at once.
        if (folders.length && ms.apps.length === 0 && scenario !== "empty" && scenario !== "readonly" && !FIRST_RUN.includes(scenario)) {
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

    setupCheck: () => delay(evaluateMachine(tools.machine()), 350),
    async setupScan(folder, overrides) {
      await delay(undefined, 500);
      if (!folders.includes(folder)) throw new ApiError("set up only folders Portplane watches: add it in Settings first", 400);
      // Other folders hold only a project setup can't write tasks for.
      if (folder !== ROOT) return otherFolderProposal(folder);
      return setup.scan(folder, overrides);
    },
    async setupApply(folder, digest, overrides) {
      await delay(undefined, 600);
      if (!folders.includes(folder)) throw new ApiError("set up only folders Portplane watches: add it in Settings first", 400);
      if (folder !== ROOT) {
        if (digest !== otherFolderProposal(folder).digest) throw new ApiError("the folder changed since this proposal was made: scan again and review the new changes", 409);
        return { written: [], reloaded: false };
      }
      const { written, tasks } = setup.apply(folder, digest, overrides);
      const runner = machineSnap("local")?.runners.find((r) => r.root === folder);
      if (written.length && !runner) {
        // A folder without dekit config until now: its runner appears, down,
        // with the new tasks. (Folders set up before keep their mock apps.)
        update((ms) => {
          ms.runners.push({ root: folder, name: folder.split("/").pop() ?? folder, up: false });
          ms.apps = [...ms.apps, ...tasks];
        });
      }
      return { written, reloaded: written.length > 0 && !!runner?.up };
    },

    machines: () => delay(structuredClone(machines)),
    machineCandidates: () => delay(structuredClone(MOCK_CANDIDATES), 700),
    async addMachine(req, signal) {
      await abortable(2600, signal);
      const host = req.host.trim();
      if (!host || host.startsWith("-") || /[\s'"`$;|&]/.test(host)) {
        throw new ApiError("enter an SSH host, such as an alias from ~/.ssh/config or user@host", 400);
      }
      if (host === "build") throw new ApiError("ssh: Could not resolve hostname build: Name or service not known", 400);
      const dup = machines.find((m) => m.host === host);
      if (dup) throw new ApiError(`${host} is already added as ${dup.name}`, 400);
      const name = req.name.trim() || host.replace(/^.*@/, "").replace(/\..*$/, "");
      let id = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
      for (let i = 2; id === "local" || machines.some((m) => m.id === id); i++) id = `${name.toLowerCase()}-${i}`;
      const mc: MachineSettings = { id, name, host, folders: req.folders.map((f) => f.trim()).filter(Boolean) };
      machines = [...machines, mc];
      const placeholder: MachineSnapshot = {
        machine: { id, name, local: false, status: "connecting" },
        tools: { proxyRunning: false, proxyHttps: false },
        folders: mc.folders,
        runners: [],
        apps: [],
        otherPorts: [],
        projects: [],
        updatedAt: new Date().toISOString(),
      };
      snapshot = { ...snapshot, machines: [...snapshot.machines, placeholder] };
      emit();
      later(1500, () =>
        update((ms) => {
          ms.machine = { ...ms.machine, status: "online", hostname: host.replace(/^.*@/, ""), os: "linux", arch: "amd64", agent: "0.0.0-mock" };
          ms.tools = { dekit: "0.10.3", portless: "0.16.0", proxyRunning: true, proxyHttps: true, proxyPort: 443 };
          ms.otherPorts = [{ port: 22, address: "0.0.0.0", process: "sshd", inFolder: false }];
        }, id),
      );
      return mc;
    },
    async updateMachine(id, req) {
      await delay(undefined, 300);
      const mc = machines.find((m) => m.id === id);
      if (!mc) throw machineError(id);
      const next: MachineSettings = { ...mc, name: req.name?.trim() || mc.name, folders: req.folders.map((f) => f.trim()).filter(Boolean) };
      machines = machines.map((m) => (m.id === id ? next : m));
      update((ms) => {
        ms.machine.name = next.name;
        ms.folders = next.folders;
      }, id);
      return next;
    },
    async removeMachine(id) {
      await delay(undefined, 300);
      if (!machines.some((m) => m.id === id)) throw machineError(id);
      machines = machines.filter((m) => m.id !== id);
      snapshot = { ...snapshot, machines: snapshot.machines.filter((m) => m.machine.id !== id) };
      emit();
    },
    async openPort(machine, port) {
      await delay(undefined, 700);
      if (machine === "local") return `http://localhost:${port}`;
      const ms = machineSnap(machine);
      if (!ms) throw machineError(machine);
      if (ms.machine.status !== "online") throw new ApiError("machine is offline", 400);
      return `http://127.0.0.1:${41000 + (port % 1000)}`;
    },

    autostart: () => delay({ enabled: autostart }),
    async setAutostart(enabled) {
      await delay(undefined, 250);
      autostart = enabled;
      return { enabled };
    },
    jobs: () => delay(jobs.list(), 120),
    async job(id) {
      await delay(undefined, 80);
      return jobs.get(id);
    },
    async cancelJob(id) {
      await delay(undefined, 120);
      jobs.cancel(id);
    },
    preferences: () => delay(structuredClone(preferences), 120),
    async savePreferences(p) {
      await delay(undefined, 150);
      const problem = preferencesProblem(p);
      if (problem) throw new ApiError(problem, 400);
      preferences = structuredClone(p);
      return structuredClone(preferences);
    },
    touchSetupFolder: () => setup.touch(),
    startDemoJob: (fail = false) => jobs.start(demoJob(fail)).id,

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

    forMachine: (machine) => forMachine(machine),
    async updateAgent(id) {
      await delay(undefined, 300);
      const ms = machineSnap(id);
      if (!ms) throw machineError(id);
      if (ms.machine.local) throw new ApiError("this computer runs Portplane itself: there is no agent to update", 400);
      update((m) => (m.machine = { ...m.machine, status: "connecting" }), id);
      clearAgentOutdated(id);
      later(1800, () => update((m) => (m.machine = { ...m.machine, status: "online", agent: "0.0.0-mock", error: undefined }), id));
    },
  };

  // A machine over SSH (ADR-0026): its own portless, dekit, tools and
  // setup, on a context that shows it as the local machine.
  const machineParts = (id: string): MachineParts => {
    const name = machineSnap(id)?.machine.name ?? id;
    const sctx = scopeMockContext(ctx, id, name);
    const mtools = createMockTools(sctx);
    const msetup = createMockSetup("fresh", REMOTE_ROOT);
    const watched = (folder: string) => {
      if (!machineSnap(id)?.folders.includes(folder)) throw new ApiError("set up only folders Portplane watches: add it in Settings first", 400);
    };
    const parts: MachineParts = {
      ...createMockPortless(sctx),
      ...createMockDekit(sctx),
      ...mtools,
      setupCheck: () => delay(evaluateMachine(mtools.machine()), 350),
      async setupScan(folder, overrides) {
        await delay(undefined, 500);
        watched(folder);
        return folder === REMOTE_ROOT ? msetup.scan(folder, overrides) : otherFolderProposal(folder);
      },
      async setupApply(folder, digest, overrides) {
        await delay(undefined, 600);
        watched(folder);
        if (folder !== REMOTE_ROOT) return { written: [], reloaded: false };
        const { written, tasks } = msetup.apply(folder, digest, overrides);
        update((ms) => (ms.apps = [...ms.apps, ...tasks.filter((t) => !ms.apps.some((a) => a.id === t.id))]), id);
        return { written, reloaded: written.length > 0 };
      },
      settings: () => delay<Settings>({ folders: machines.find((m) => m.id === id)?.folders ?? [] }),
      saveSettings: async (s) => ({ folders: (await api.updateMachine(id, { folders: s.folders })).folders }),
      pickFolder: () => delay<PickResult>({ kind: "unsupported" }),
    };
    // Every call checks the machine first, like the server does.
    const guarded: Record<string, unknown> = {};
    for (const [k, fn] of Object.entries(parts)) {
      guarded[k] =
        typeof fn !== "function"
          ? fn
          : (...args: unknown[]) => {
              const ms = machineSnap(id);
              if (!ms) return Promise.reject(machineError(id));
              if (ms.machine.status !== "online") return Promise.reject(new ApiError(`${ms.machine.name} is offline. Portplane reconnects on its own: try again once it's back`, 503));
              if (ms.machine.agent === MOCK_OLD_AGENT) return Promise.reject(new ApiError(`Update the agent on ${ms.machine.name}: it is older than this Portplane and can't do this yet.`, 501));
              return (fn as (...a: unknown[]) => unknown)(...args);
            };
    }
    return guarded as MachineParts;
  };
  const forMachine = machineScoper(() => api, (id) => (id === LOCAL_MACHINE ? {} : machineParts(id)));
  return api;
}
