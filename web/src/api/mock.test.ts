import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi, mockSnapshot, type Scenario } from "./mock";
import type { Snapshot } from "./types";

describe("mockSnapshot", () => {
  it.each<Scenario>(["default", "degraded", "readonly", "empty", "nofolders"])("is self-consistent (%s)", (scenario) => {
    for (const ms of mockSnapshot(scenario).machines) {
      const ids = new Set(ms.apps.map((a) => a.id));
      const grouped = ms.projects.flatMap((p) => p.worktrees.flatMap((w) => w.apps));
      expect(new Set(grouped)).toEqual(ids);
      expect(grouped).toHaveLength(ids.size);
      for (const a of ms.apps) expect(ms.runners.some((r) => r.root === a.runner)).toBe(true);
    }
  });

  it("puts projects with something running first", () => {
    const names = mockSnapshot().machines[0].projects.map((p) => p.name);
    expect(names).toEqual(["my-monorepo", "blog"]);
  });

  it("covers the states the UI has to show", () => {
    const states = new Set(mockSnapshot().machines[0].apps.map((a) => a.state));
    for (const s of ["on", "starting", "failed", "off", "done"]) expect(states).toContain(s);
  });
});

describe("createMockApi", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts an app the way dekit would", async () => {
    const api = createMockApi();
    let last: Snapshot | null = null;
    const stop = api.subscribe({ onSnapshot: (s) => (last = s), onStatus: () => {} });
    await vi.advanceTimersByTimeAsync(200);
    const site = () => last!.machines[0].apps.find((a) => a.task === "blog/site")!;
    expect(site().state).toBe("off");
    const done = api.act({ machine: "local", runner: site().runner, prefix: "blog/" }, "start");
    await vi.advanceTimersByTimeAsync(250);
    await done;
    expect(site().state).toBe("starting");
    await vi.advanceTimersByTimeAsync(2000);
    expect(site().state).toBe("on");
    expect(site().url).toBe("https://blog.localhost");
    stop();
  });

  it("rejects a target that matches nothing", async () => {
    const api = createMockApi();
    const p = api.act({ machine: "local", runner: "/nowhere", task: "x" }, "start");
    const assertion = expect(p).rejects.toThrow("no task matches");
    await vi.advanceTimersByTimeAsync(300);
    await assertion;
  });
});
