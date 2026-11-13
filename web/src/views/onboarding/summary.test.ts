import { describe, expect, it, vi } from "vitest";
import type { App, AppProposal, MachineSnapshot, Proposal } from "../../api/types";
import { browsersNeedAction, folderRows, hasFixedPorts, missingManagers, proxyOptionsFor } from "./helpers";
import { setupProblems } from "./problems";
import { byProject, count, describeProposal, firstWorking, nothingToWrite, preselect, startCandidates, startPhase, startTargets } from "./summary";

const HOME = "/home/dev";
const ROOT = `${HOME}/code`;

function proposal(p: Partial<Proposal>): Proposal {
  return { folder: ROOT, apps: [], warnings: [], change: { added: [], changed: [], removed: [] }, files: [], digest: "d", ...p };
}

describe("describeProposal", () => {
  it("says what writing does, in plain words", () => {
    const p = proposal({
      change: { added: ["shop/install", "shop/web", "shop/api", "blog/install", "blog/web", "blog/studio"], changed: [], removed: [] },
      files: [
        { path: `${ROOT}/.portplane/tasks.yaml`, before: "", after: "tasks:\n", created: true, changed: true },
        { path: `${ROOT}/shop/dekit.yaml`, before: "tasks:\n  db: {}\n", after: "tasks:\n  db: {}\nload:\n  - x\n", created: false, changed: true },
      ],
    });
    expect(describeProposal(p, HOME)).toEqual(["Six new tasks in two projects", "~/code/.portplane/tasks.yaml created", "Two lines added to ~/code/shop/dekit.yaml"]);
  });

  it("covers updates, removals and edits", () => {
    const p = proposal({
      change: { added: [], changed: ["shop/web"], removed: ["shop/old", "shop/older"] },
      files: [{ path: `${ROOT}/dekit.yaml`, before: "a\nb\n", after: "a\nc\nd\n", created: false, changed: true }],
    });
    expect(describeProposal(p, HOME)).toEqual(["One task updated", "Two tasks removed", "~/code/dekit.yaml: 2 lines added, 1 removed"]);
    expect(describeProposal(proposal({}), HOME)).toEqual([]);
    expect(nothingToWrite([proposal({})])).toBe(true);
    expect(nothingToWrite([p])).toBe(false);
  });

  it("counts in words up to ten", () => {
    expect(count(1, "app")).toBe("one app");
    expect(count(0, "app")).toBe("no apps");
    expect(count(12, "git repository", "git repositories")).toBe("12 git repositories");
  });
});

const app = (p: Partial<App> & Pick<App, "task" | "project" | "order">): App => ({
  id: `${ROOT}#${p.task}`,
  runner: ROOT,
  label: p.task.split("/").pop()!,
  kind: "service",
  state: "off",
  ...p,
});

describe("first start", () => {
  const apps = [
    app({ task: "shop/install", project: "shop", order: 0, kind: "job" }),
    app({ task: "shop/api", project: "shop", order: 2, hostname: "api.shop.localhost" }),
    app({ task: "shop/web", project: "shop", order: 1, hostname: "shop.localhost" }),
    app({ task: "shop/wt/web", project: "shop", worktree: "wt", order: 3, hostname: "wt.shop.localhost" }),
    app({ task: "blog/site", project: "blog", order: 4, hostname: "blog.localhost" }),
    app({ task: "other/x", project: "other", order: 5, runner: "/elsewhere", id: "/elsewhere#other/x" }),
  ];
  const ms = { apps } as MachineSnapshot;

  it("offers the services of the folders just set up, in order", () => {
    expect(startCandidates(ms, [ROOT]).map((a) => a.task)).toEqual(["shop/web", "shop/api", "shop/wt/web", "blog/site"]);
    expect(startCandidates(undefined, [ROOT])).toEqual([]);
  });

  it("ticks each project's main app, not its worktrees", () => {
    const picked = preselect(startCandidates(ms, [ROOT]));
    expect([...picked].sort()).toEqual([`${ROOT}#blog/site`, `${ROOT}#shop/web`]);
  });

  it("ticks only the first project's main app when there are many projects", () => {
    const many = ["a", "b", "c", "d"].flatMap((p, i) => [
      app({ task: `${p}/api`, project: p, order: i * 2, hostname: `api.${p}.localhost` }),
      app({ task: `${p}/web`, project: p, order: i * 2 + 1, hostname: `${p}.localhost` }),
    ]);
    expect([...preselect(many)]).toEqual([`${ROOT}#a/web`]);
    expect(byProject(many).map((g) => [g.project, g.apps.length])).toEqual([
      ["a", 2],
      ["b", 2],
      ["c", 2],
      ["d", 2],
    ]);
  });

  it("starts one target per runner", () => {
    const ids = new Set([`${ROOT}#shop/web`, `${ROOT}#blog/site`, "/elsewhere#other/x"]);
    expect(startTargets("local", apps, ids)).toEqual([
      { machine: "local", runner: ROOT, tasks: ["shop/web", "blog/site"] },
      { machine: "local", runner: "/elsewhere", tasks: ["other/x"] },
    ]);
  });

  it("follows each app until it is on", () => {
    expect(startPhase(app({ task: "a", project: "a", order: 0, state: "starting" }))).toBe("starting");
    expect(startPhase(app({ task: "a", project: "a", order: 0, state: "failed" }))).toBe("failed");
    expect(startPhase(undefined)).toBe("waiting");
    const on = [app({ task: "a", project: "a", order: 0, state: "on" }), app({ task: "b", project: "b", order: 1, state: "on", url: "https://b.localhost" })];
    expect(firstWorking(on, new Set(on.map((a) => a.id)))?.task).toBe("b");
    expect(firstWorking(on, new Set())).toBeUndefined();
  });
});

describe("helpers", () => {
  const ap = (p: Partial<AppProposal>): AppProposal => ({
    task: "t",
    project: "p",
    name: "p",
    hostname: "p.localhost",
    dir: ".",
    framework: "vite",
    packageManager: "pnpm",
    command: [],
    status: "new",
    skipped: false,
    ...p,
  });

  it("names the package managers apps need that are missing", () => {
    const p = proposal({ apps: [ap({ task: "a", packageManager: "pnpm" }), ap({ task: "b", packageManager: "yarn" }), ap({ task: "c", packageManager: "bun", status: "manual" })] });
    expect(missingManagers([p], { npm: "10", pnpm: "", yarn: "", bun: "" }, () => false)).toEqual(["pnpm", "yarn"]);
    expect(missingManagers([p], { npm: "10", pnpm: "", yarn: "", bun: "" }, (t) => t === "a")).toEqual(["yarn"]);
    expect(missingManagers([p], undefined, () => false)).toEqual([]);
  });

  it("spots dev scripts with a fixed port", () => {
    expect(hasFixedPorts(proposal({ apps: [ap({ notes: ["The dev script pins port 4516, which would win over portless."] })] }))).toBe(true);
    expect(hasFixedPorts(proposal({ apps: [ap({})] }))).toBe(false);
  });

  it("lists saved folders first, and ticks the busiest suggestion on a first run", () => {
    const sugg = [
      { path: `${HOME}/src`, repos: 1 },
      { path: `${HOME}/code`, repos: 6 },
    ];
    expect(folderRows([], sugg)).toEqual([
      { path: `${HOME}/src`, repos: 1, checked: false },
      { path: `${HOME}/code`, repos: 6, checked: true },
    ]);
    expect(folderRows([`${HOME}/work`], sugg).map((r) => [r.path, r.checked])).toEqual([
      [`${HOME}/work`, true],
      [`${HOME}/src`, false],
      [`${HOME}/code`, false],
    ]);
  });

  it("turns the proxy form into options", () => {
    const adv = { tld: ".Test", wildcard: true, httpOnly: false, cert: " /c.pem ", key: "/k.pem" };
    expect(proxyOptionsFor("service", adv)).toEqual({ port: 443, https: true, tlds: ["test"], wildcard: true, lan: false, unprivileged: false, certPath: "/c.pem", keyPath: "/k.pem" });
    const plain = proxyOptionsFor("unprivileged", { ...adv, tld: "", httpOnly: true });
    expect([plain.port, plain.https, plain.tlds, plain.certPath]).toEqual([1355, false, ["localhost"], undefined]);
  });

  it("knows when a browser still needs the CA", () => {
    const report = (status: "trusted" | "system" | "missing" | "unknown") => ({
      caExists: true,
      systemTrusted: true,
      p11kit: false,
      browsers: [{ id: "firefox" as const, name: "Firefox", store: "nss" as const, profiles: [{ id: "f", name: "default", status, canAdd: true }] }],
    });
    expect(browsersNeedAction(report("trusted"))).toBe(false);
    expect(browsersNeedAction(report("system"))).toBe(false);
    expect(browsersNeedAction(report("missing"))).toBe(true);
    expect(browsersNeedAction(report("unknown"))).toBe(true);
  });
});

describe("setupProblems", () => {
  const ms = (tools: MachineSnapshot["tools"], local = true, status: MachineSnapshot["machine"]["status"] = "online"): MachineSnapshot => ({
    machine: { id: local ? "local" : "box", name: local ? "x" : "box", local, status },
    tools,
    folders: [],
    runners: [],
    apps: [],
    otherPorts: [],
    projects: [],
    updatedAt: "",
  });

  it("offers the installs on this computer (F3); the proxy is the portless center's", () => {
    const none = setupProblems(ms({ proxyRunning: false, proxyHttps: false }));
    expect(none.map((p) => [p.id, p.fix?.label])).toEqual([
      ["no-dekit|local", "Install dekit"],
      ["no-portless|local", "Install portless"],
    ]);
    const down = setupProblems(ms({ dekit: "0.10.3", portless: "0.16.0", proxyRunning: false, proxyHttps: false }));
    expect(down).toEqual([]);
  });

  it("offers the installs on a machine over SSH through its own setup (ADR-0026)", () => {
    const box = setupProblems(ms({ proxyRunning: false, proxyHttps: false }, false));
    expect(box.map((p) => [p.id, p.title])).toEqual([
      ["no-dekit|box", "dekit isn't installed on box"],
      ["no-portless|box", "portless isn't installed on box"],
    ]);
    expect(box[0].detail).toContain("into your home folder there, without a password");
    const location = { hash: "" };
    vi.stubGlobal("window", { location, history: { state: null, replaceState() {} }, dispatchEvent() {} });
    try {
      box[0].fix!.run({} as never);
      expect(location.hash).toBe("#/setup/box/install");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(setupProblems(ms({ proxyRunning: false, proxyHttps: false }, false, "offline"))).toEqual([]);
  });
});
