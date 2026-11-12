import { describe, expect, it } from "vitest";
import { mockSnapshot } from "../api/mock";
import type { App } from "../api/types";
import { indexApps } from "./apps";
import { checkoutsText, findProject, foldedByDefault, groupState, projectRoute, sidebarProjects } from "./projects";

const snap = mockSnapshot("default");
const local = snap.machines[0];
const app = (state: App["state"], kind: App["kind"] = "service"): App => ({ ...local.apps[1], state, kind });

describe("groupState", () => {
  it("speaks for the most urgent app", () => {
    expect(groupState([app("on"), app("failed"), app("starting")])).toBe("failed");
    expect(groupState([app("on"), app("starting")])).toBe("starting");
    expect(groupState([app("off"), app("on")])).toBe("on");
    expect(groupState([app("off"), app("done", "job")])).toBe("off");
    expect(groupState([])).toBe("off");
  });
});

describe("sidebarProjects", () => {
  it("lists this computer's projects first, then online machines', skipping offline ones", () => {
    const list = sidebarProjects(snap);
    expect(list.map((p) => `${p.ms.machine.id}:${p.project.name}:${p.state}:${p.running}/${p.total}`)).toEqual(["local:my-monorepo:failed:4/6", "local:blog:off:0/4", "box:shop:on:2/3"]);
    expect(list[1].route).toEqual({ view: "project", machine: "local", name: "blog" });
  });
});

describe("projectRoute and findProject", () => {
  it("names the runner only when two projects share a name", () => {
    const blog = local.projects.find((p) => p.name === "blog")!;
    expect(projectRoute(local, blog)).toEqual({ view: "project", machine: "local", name: "blog" });
    const twin = { ...blog, runner: "/elsewhere" };
    const ms = { ...local, projects: [...local.projects, twin] };
    expect(projectRoute(ms, twin)).toEqual({ view: "project", machine: "local", name: "blog", runner: "/elsewhere" });
    expect(findProject(snap, { machine: "local", name: "blog" })?.project).toBe(blog);
    expect(findProject(snap, { machine: "local", name: "nope" })).toBeNull();
    expect(findProject(snap, { machine: "local", name: "blog", runner: "/elsewhere" })).toBeNull();
  });
});

describe("worktrees", () => {
  it("folds a linked worktree only while nothing in it runs or fails", () => {
    const byId = indexApps(local.apps);
    const mono = local.projects.find((p) => p.name === "my-monorepo")!;
    const blog = local.projects.find((p) => p.name === "blog")!;
    expect(foldedByDefault(mono.worktrees[0], byId)).toBe(false); // the main checkout never folds by itself
    expect(foldedByDefault(mono.worktrees[1], byId)).toBe(false); // starting
    expect(foldedByDefault(blog.worktrees[1], byId)).toBe(true); // idle
    expect(checkoutsText(blog)).toBe("1 worktree");
    expect(checkoutsText({ ...blog, worktrees: [blog.worktrees[0]] })).toBe("");
  });
  it("carries the branch and folder of each checkout", () => {
    const blog = local.projects.find((p) => p.name === "blog")!;
    expect(blog.worktrees.map((w) => `${w.name || "main"}@${w.branch} ${w.path}`)).toEqual(["main@main /home/dev/code/blog", "redesign@design/new /home/dev/code/worktrees/redesign"]);
  });
});
