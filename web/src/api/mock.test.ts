import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi, mockSnapshot, type Scenario } from "./mock";
import type { Job } from "./jobs";
import type { Preferences, Snapshot } from "./types";

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

describe("mock machines", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a remote machine with tunnelled apps and an offline one", () => {
    const [local, box, mini] = mockSnapshot().machines;
    expect(local.machine.local).toBe(true);
    expect(box.machine).toMatchObject({ local: false, status: "online" });
    expect(box.apps.some((a) => a.state === "on" && a.remoteUrl?.endsWith(".box.localhost"))).toBe(true);
    expect(mini.machine).toMatchObject({ local: false, status: "offline" });
    expect(mini.machine.error).toMatch(/ssh/);
  });

  it("adds, edits and removes a machine", async () => {
    const api = createMockApi();
    let last: Snapshot | null = null;
    api.subscribe({ onSnapshot: (s) => (last = s), onStatus: () => {} });
    const added = api.addMachine({ host: "dev@pi.local", name: "", folders: [" /srv/code ", ""] });
    await vi.advanceTimersByTimeAsync(3000);
    const mc = await added;
    expect(mc).toEqual({ id: "pi", name: "pi", host: "dev@pi.local", folders: ["/srv/code"] });
    const pi = () => last!.machines.find((m) => m.machine.id === "pi");
    expect(pi()?.machine.status).toBe("connecting");
    await vi.advanceTimersByTimeAsync(1600);
    expect(pi()?.machine.status).toBe("online");

    const edited = api.updateMachine("pi", { name: "Raspberry", folders: ["/srv/a", "/srv/b"] });
    await vi.advanceTimersByTimeAsync(400);
    expect(await edited).toMatchObject({ name: "Raspberry", folders: ["/srv/a", "/srv/b"] });
    expect(pi()?.machine.name).toBe("Raspberry");

    const removed = api.removeMachine("pi");
    await vi.advanceTimersByTimeAsync(400);
    await removed;
    expect(pi()).toBeUndefined();
  });

  it("reports ssh's error and can be cancelled", async () => {
    const api = createMockApi();
    const failed = api.addMachine({ host: "build", name: "", folders: [] }).catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await failed).toMatch(/Could not resolve hostname/);

    const ctl = new AbortController();
    const cancelled = api.addMachine({ host: "pi", name: "", folders: [] }, ctl.signal).catch((e: Error) => e.name);
    ctl.abort();
    expect(await cancelled).toBe("AbortError");
  });

  it("opens remote ports through a local URL, not on offline machines", async () => {
    const api = createMockApi();
    const ok = api.openPort("box", 5432);
    const off = api.openPort("mini", 22).catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(800);
    expect(await ok).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await off).toMatch(/offline/);
  });

  it("remembers start at login", async () => {
    const api = createMockApi();
    const set = api.setAutostart(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(await set).toEqual({ enabled: true });
    const get = api.autostart();
    await vi.advanceTimersByTimeAsync(200);
    expect(await get).toEqual({ enabled: true });
  });
});

describe("mock jobs and preferences", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs a demo job step by step and streams it", async () => {
    const api = createMockApi();
    const states: string[] = [];
    let last: Job | null = null;
    const stop = api.subscribe({
      onSnapshot: () => {},
      onStatus: () => {},
      onJob: (j) => {
        last = j;
        states.push(j.state);
      },
    });
    const id = api.startDemoJob();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(last!.id).toBe(id);
    expect(last!.state).toBe("succeeded");
    expect(last!.steps.every((s) => s.state === "succeeded")).toBe(true);
    expect(last!.output.length).toBeGreaterThan(3);
    expect(states[0]).toBe("running");
    const list = api.jobs();
    await vi.advanceTimersByTimeAsync(200);
    expect((await list).map((j) => j.id)).toEqual([id]);
    stop();
  });

  it("fails a job at its step, and cancels one", async () => {
    const api = createMockApi();
    const failing = api.startDemoJob(true);
    await vi.advanceTimersByTimeAsync(10_000);
    const failed = api.job(failing);
    await vi.advanceTimersByTimeAsync(100);
    const f = await failed;
    expect(f.state).toBe("failed");
    expect(f.error).toMatch(/checksum/);
    expect(f.steps.map((s) => s.state)).toEqual(["succeeded", "failed", "skipped", "skipped"]);

    const running = api.startDemoJob();
    await vi.advanceTimersByTimeAsync(300);
    const cancel = api.cancelJob(running);
    await vi.advanceTimersByTimeAsync(200);
    await cancel;
    const got = api.job(running);
    await vi.advanceTimersByTimeAsync(100);
    expect((await got).state).toBe("cancelled");
  });

  it("keeps preferences in memory and refuses invalid ones", async () => {
    const api = createMockApi();
    const first = api.preferences();
    await vi.advanceTimersByTimeAsync(200);
    const p = await first;
    expect(p.theme).toBe("system");
    const saved = api.savePreferences({ ...p, theme: "dark" });
    await vi.advanceTimersByTimeAsync(200);
    expect((await saved).theme).toBe("dark");
    const again = api.preferences();
    await vi.advanceTimersByTimeAsync(200);
    expect((await again).theme).toBe("dark");
    const bad = api.savePreferences({ ...p, density: "huge" as Preferences["density"] }).catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(200);
    expect(await bad).toMatch(/density/);
  });
});
