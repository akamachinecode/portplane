import { describe, expect, it } from "vitest";
import { mockSnapshot } from "../../api/mock";
import {
  bulkTargets,
  collectEntries,
  entryKey,
  filterEntries,
  filterOptions,
  hasFilters,
  layoutApps,
  matchScore,
  NO_FILTERS,
  pruneSelection,
  selectBy,
  selectRange,
  stateFilter,
  toggleFavorite,
  toggleSelection,
  type AppFilters,
} from "./model";

const ROOT = "/home/dev/code";
const key = (task: string) => entryKey("local", `${ROOT}#${task}`);
const labels = (entries: Array<{ app: { label: string; worktree?: string } }>) => entries.map((e) => e.app.label + (e.app.worktree ? `@${e.app.worktree}` : ""));
const f = (over: Partial<AppFilters>): AppFilters => ({ ...NO_FILTERS, ...over });

describe("collectEntries", () => {
  it("lists visible apps of machines it can see, marking the pinned ones", () => {
    const entries = collectEntries(mockSnapshot("default"), new Set([key("my-monorepo/web")]));
    // the finished install job is hidden, the running checkout install shows; the offline mac-mini has none
    expect(entries.map((e) => `${e.ms.machine.id}:${e.app.label}`)).toEqual([
      "local:web",
      "local:api",
      "local:admin",
      "local:docs",
      "local:install",
      "local:web",
      "local:api",
      "local:site",
      "local:studio",
      "box:web",
      "box:api",
      "box:worker",
    ]);
    expect(entries.filter((e) => e.favorite).map((e) => e.key)).toEqual([key("my-monorepo/web")]);
  });
});

describe("filters", () => {
  const entries = collectEntries(mockSnapshot("default"), new Set());

  it("filters by state, machine, project and tag, all together", () => {
    expect(labels(filterEntries(entries, f({ states: ["failed"] })).map((x) => x.entry))).toEqual(["admin"]);
    expect(labels(filterEntries(entries, f({ states: ["running", "busy"] })).map((x) => x.entry))).toEqual(["web", "api", "docs", "install@checkout", "web@checkout", "web", "api"]);
    expect(labels(filterEntries(entries, f({ machines: ["box"] })).map((x) => x.entry))).toEqual(["web", "api", "worker"]);
    expect(labels(filterEntries(entries, f({ projects: ["local|blog"] })).map((x) => x.entry))).toEqual(["site", "studio"]);
    expect(labels(filterEntries(entries, f({ tags: ["backend"], machines: ["local"] })).map((x) => x.entry))).toEqual(["api", "api@checkout"]);
    expect(filterEntries(entries, f({ tags: ["backend"], states: ["failed"] }))).toEqual([]);
  });

  it("searches name, URL and path, the name first", () => {
    const e = (task: string) => entries.find((x) => x.app.task === task)!;
    expect(matchScore(e("blog/studio"), "studio")).toBeGreaterThan(matchScore(e("blog/site"), "blog")!);
    expect(matchScore(e("my-monorepo/api"), "api.my-mono")).not.toBeNull(); // the hostname
    expect(matchScore(e("my-monorepo/docs"), "apps/docs")).not.toBeNull(); // the path
    expect(matchScore(e("my-monorepo/docs"), "zzz")).toBeNull();
    const hits = filterEntries(entries, f({ query: "studio" }));
    expect(labels(hits.map((x) => x.entry))).toEqual(["studio"]);
  });

  it("knows when any filter is on", () => {
    expect(hasFilters(NO_FILTERS)).toBe(false);
    expect(hasFilters(f({ query: "  " }))).toBe(false);
    expect(hasFilters(f({ tags: ["x"] }))).toBe(true);
  });

  it("offers each option with its count", () => {
    const o = filterOptions(mockSnapshot("default"));
    expect(o.states).toEqual([
      { value: "running", label: "Running", count: 4 },
      { value: "busy", label: "Starting or stopping", count: 3 },
      { value: "failed", label: "Failed", count: 1 },
      { value: "stopped", label: "Stopped", count: 4 },
    ]);
    expect(o.machines.map((m) => `${m.label}=${m.count}`)).toEqual(["This computer=9", "box=3"]);
    expect(o.projects.map((m) => `${m.label}=${m.count}`)).toEqual(["blog · This computer=2", "my-monorepo · This computer=7", "shop · box=3"]);
    expect(o.tags.map((m) => `${m.label}=${m.count}`)).toEqual(["autostart=2", "backend=2", "cms=1", "docs=1", "frontend=4"]);
  });
});

describe("layoutApps", () => {
  it("groups by machine, project and worktree, busiest first", () => {
    const l = layoutApps(mockSnapshot("default"), new Set(), NO_FILTERS, "activity");
    expect(l.pinned).toEqual([]);
    expect(l.machines.map((m) => m.ms.machine.id)).toEqual(["local", "box"]);
    const local = l.machines[0].projects;
    expect(local.map((p) => p.project.name)).toEqual(["my-monorepo", "blog"]);
    expect(local[0].multi).toBe(true);
    expect(local[0].worktrees.map((w) => `${w.name || "main"}: ${labels(w.entries).join(", ")}`)).toEqual([
      "main: web, api, docs, admin",
      "checkout: install@checkout, web@checkout, api@checkout",
    ]);
    expect(l.order).toHaveLength(12);
    expect(l.total).toBe(12);
  });

  it("puts failures first when sorting by state, and sorts by name", () => {
    const byState = layoutApps(mockSnapshot("default"), new Set(), NO_FILTERS, "state");
    expect(labels(byState.machines[0].projects[0].worktrees[0].entries)).toEqual(["admin", "docs", "web", "api"]);
    const byName = layoutApps(mockSnapshot("default"), new Set(), NO_FILTERS, "name");
    expect(byName.machines[0].projects.map((p) => p.project.name)).toEqual(["blog", "my-monorepo"]);
    expect(labels(byName.machines[0].projects[1].worktrees[0].entries)).toEqual(["admin", "api", "docs", "web"]);
  });

  it("pins favourites on top, once", () => {
    const l = layoutApps(mockSnapshot("default"), new Set([key("blog/studio"), entryKey("box", "/home/dev/src#shop/web")]), NO_FILTERS, "activity");
    expect(l.pinned.map((e) => `${e.ms.machine.id}:${e.app.label}`)).toEqual(["box:web", "local:studio"]);
    const blog = l.machines[0].projects.find((p) => p.project.name === "blog")!;
    expect(labels(blog.worktrees[0].entries)).toEqual(["site"]);
    expect(l.order.slice(0, 2).map((e) => e.app.label)).toEqual(["web", "studio"]);
    expect(new Set(l.order.map((e) => e.key)).size).toBe(l.order.length);
  });

  it("drops empty groups and ranks matches when searching", () => {
    const l = layoutApps(mockSnapshot("default"), new Set(), f({ query: "worker" }), "activity");
    expect(l.machines.map((m) => m.projects.length)).toEqual([0, 1]);
    expect(labels(l.order)).toEqual(["worker"]);
  });
});

describe("selection", () => {
  const l = layoutApps(mockSnapshot("default"), new Set(), NO_FILTERS, "activity");
  const k = l.order.map((e) => e.key);

  it("toggles, and selects a range with Shift", () => {
    let s = toggleSelection(new Set(), k[1]);
    expect([...s]).toEqual([k[1]]);
    s = selectRange(s, l.order, k[1], k[3]);
    expect([...s].sort()).toEqual([k[1], k[2], k[3]].sort());
    s = selectRange(s, l.order, null, k[6]); // no anchor: just that one
    expect(s.has(k[6])).toBe(true);
    expect(toggleSelection(s, k[6]).has(k[6])).toBe(false);
  });

  it("selects by state, project and tag", () => {
    expect(selectBy(new Set(), l.order, { kind: "state", state: "stopped" }).size).toBe(4);
    expect(selectBy(new Set(), l.order, { kind: "project", project: "box|shop" }).size).toBe(3);
    expect([...selectBy(new Set(), l.order, { kind: "tag", tag: "backend" })]).toEqual([key("my-monorepo/api"), key("my-monorepo-checkout/api")]);
    expect(selectBy(new Set(), l.order, { kind: "all" }).size).toBe(12);
  });

  it("forgets what is no longer shown", () => {
    const s = new Set([k[0], "gone|x"]);
    expect([...pruneSelection(s, l.order)]).toEqual([k[0]]);
    const same = new Set([k[0]]);
    expect(pruneSelection(same, l.order)).toBe(same);
  });

  it("starts what is stopped, stops and restarts what runs, where dekit is", () => {
    const all = l.order;
    expect(labels(bulkTargets(all, "start"))).toEqual(["admin", "api@checkout", "site", "studio", "worker"]);
    expect(labels(bulkTargets(all, "stop"))).toEqual(["web", "api", "docs", "install@checkout", "web@checkout", "web", "api"]);
    const noDekit = mockSnapshot("default");
    noDekit.machines[0].tools.dekit = undefined;
    const l2 = layoutApps(noDekit, new Set(), NO_FILTERS, "activity");
    expect(labels(bulkTargets(l2.order, "start"))).toEqual(["worker"]);
  });
});

describe("helpers", () => {
  it("maps states to filters", () => {
    expect(["on", "starting", "stopping", "failed", "off", "done", "unknown"].map((s) => stateFilter(s as never))).toEqual([
      "running",
      "busy",
      "busy",
      "failed",
      "stopped",
      "stopped",
      "stopped",
    ]);
  });

  it("pins at the end and unpins", () => {
    expect(toggleFavorite(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleFavorite(["a", "b"], "a")).toEqual(["b"]);
  });
});
