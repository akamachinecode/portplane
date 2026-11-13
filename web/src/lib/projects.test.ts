import { describe, expect, it } from "vitest";
import { mockSnapshot } from "../api/mock";
import type { App } from "../api/types";
import { indexApps } from "./apps";
import { checkoutKey, checkoutName, checkoutsText, findProject, foldedByDefault, groupState, projectRoute, sidebarProjects } from "./projects";

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
    expect(list.map((p) => `${p.ms.machine.id}:${p.project.name}:${p.state}:${p.running}/${p.total}`)).toEqual(["local:my-monorepo:failed:2/6", "local:blog:off:0/4", "box:shop:on:2/3"]);
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

describe("a product of several repositories (?mock=products)", () => {
  const ms = mockSnapshot("products").machines[0];
  it("groups like the agent: by folder, with each repository's worktrees", () => {
    const acme = ms.projects.find((p) => p.name === "acme")!;
    expect(acme.repos).toHaveLength(3);
    expect(acme.worktrees.map((w) => checkoutName(acme, w))).toEqual(["acme-backend", "acme-front", "acme-webapp", "acme-front / new-ui"]);
    expect(checkoutsText(acme)).toBe("3 repositories · 1 worktree");
    const sym = ms.projects.find((p) => p.name === "symposium")!;
    expect(sym.worktrees.map((w) => checkoutName(sym, w))).toEqual(["outside git", "v2"]);
    expect(ms.projects.map((p) => p.name).sort()).toEqual(["acme", "panel", "symposium"]);
    expect(new Set(ms.projects.map((p) => checkoutKey(p.worktrees[0]))).size).toBe(3);
  });
});
