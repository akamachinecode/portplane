import { describe, expect, it } from "vitest";
import { mockSnapshot } from "../api/mock";
import type { Project } from "../api/types";
import { indexApps } from "./apps";
import { appTarget, projectTarget, worktreeTarget } from "./targets";

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

describe("projectTarget", () => {
  it("uses the prefix when the project has one", () => {
    expect(projectTarget("local", blog, byId)).toEqual({ machine: "local", runner: blog.runner, prefix: "blog/" });
  });
  it("lists every task, jobs included, when the tasks share no folder", () => {
    expect(mono.prefix ?? "").toBe("");
    const t = projectTarget("local", mono, byId);
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
    expect(projectTarget("local", p, byId).tasks).toEqual(["blog/site", "blog/studio"]);
  });
});

describe("worktreeTarget", () => {
  it("uses the worktree's own prefix", () => {
    const wt = mono.worktrees.find((w) => w.name === "checkout")!;
    expect(worktreeTarget("local", mono, wt, byId)).toEqual({ machine: "local", runner: mono.runner, prefix: "my-monorepo-checkout/" });
  });
  it("falls back to the worktree's tasks", () => {
    const wt = { ...mono.worktrees[0], prefix: undefined };
    expect(worktreeTarget("local", mono, wt, byId).tasks).toEqual([
      "my-monorepo/install",
      "my-monorepo/web",
      "my-monorepo/api",
      "my-monorepo/admin",
      "my-monorepo/docs",
    ]);
  });
});
