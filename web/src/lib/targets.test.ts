import { describe, expect, it } from "vitest";
import { mockSnapshot } from "../api/mock";
import type { Project } from "../api/types";
import { indexApps } from "./apps";
import { appTarget, projectTargets, worktreeTargets } from "./targets";

const ms = mockSnapshot().machines[0];
const byId = indexApps(ms.apps);
const mono = ms.projects.find((p) => p.name === "my-monorepo")!;
const blog = ms.projects.find((p) => p.name === "blog")!;

describe("appTarget", () => {
  it("names one task", () => {
    const web = ms.apps.find((a) => a.task === "my-monorepo/web")!;
    expect(appTarget("local", web)).toEqual({ machine: "local", runner: web.runner, task: "my-monorepo/web" });
  });
});

describe("projectTargets", () => {
  it("lists the tasks when the project's prefix would reach other apps", () => {
    // blog's worktree sits under worktrees/, so blog/ is not the whole project
    expect(projectTargets("local", blog, byId)).toEqual([{ machine: "local", runner: blog.runner, tasks: ["blog/site", "blog/studio", "worktrees/redesign/site", "worktrees/redesign/studio"] }]);
  });
  it("uses the prefix when the project has one", () => {
    const shop = mockSnapshot().machines.find((m) => m.machine.id === "box")!;
    const p = shop.projects[0];
    expect(projectTargets("box", p, indexApps(shop.apps))).toEqual([{ machine: "box", runner: p.runner, prefix: "shop/" }]);
  });
  it("lists every task, jobs included, when the tasks share no folder", () => {
    expect(mono.prefix ?? "").toBe("");
    const [t] = projectTargets("local", mono, byId);
    expect(t.prefix).toBeUndefined();
    expect(t.tasks).toEqual([
      "my-monorepo/install",
      "my-monorepo/web",
      "my-monorepo/api",
      "my-monorepo/admin",
      "my-monorepo/docs",
      "my-monorepo-checkout/install",
      "my-monorepo-checkout/web",
      "my-monorepo-checkout/api",
    ]);
  });
  it("treats an empty prefix like a missing one", () => {
    const p: Project = { ...blog, prefix: "" };
    expect(projectTargets("local", p, byId)[0].tasks).toEqual(["blog/site", "blog/studio", "worktrees/redesign/site", "worktrees/redesign/studio"]);
  });
});

describe("worktreeTargets", () => {
  it("uses the worktree's own prefix", () => {
    const wt = mono.worktrees.find((w) => w.name === "checkout")!;
    expect(worktreeTargets("local", mono, wt, byId)).toEqual([{ machine: "local", runner: mono.runner, prefix: "my-monorepo-checkout/" }]);
  });
  it("falls back to the worktree's tasks", () => {
    const wt = { ...mono.worktrees[0], prefix: undefined };
    expect(worktreeTargets("local", mono, wt, byId)[0].tasks).toEqual([
      "my-monorepo/install",
      "my-monorepo/web",
      "my-monorepo/api",
      "my-monorepo/admin",
      "my-monorepo/docs",
    ]);
  });
});

describe("a project over two runners", () => {
  it("acts with one target per runner", () => {
    const web = { ...ms.apps[0], id: "/a#shop/web", runner: "/a", task: "shop/web" };
    const wtWeb = { ...ms.apps[0], id: "/b#worktrees/x/web", runner: "/b", task: "worktrees/x/web", worktree: "x" };
    const p: Project = { name: "shop", runner: "/a", runners: ["/a", "/b"], running: 0, total: 2, worktrees: [{ name: "", running: 0, apps: [web.id] }, { name: "x", runner: "/b", prefix: "worktrees/x/", running: 0, apps: [wtWeb.id] }] };
    const index = indexApps([web, wtWeb]);
    expect(projectTargets("local", p, index)).toEqual([
      { machine: "local", runner: "/a", tasks: ["shop/web"] },
      { machine: "local", runner: "/b", tasks: ["worktrees/x/web"] },
    ]);
    expect(worktreeTargets("local", p, p.worktrees[1], index)).toEqual([{ machine: "local", runner: "/b", prefix: "worktrees/x/" }]);
  });
});
