import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "./jobs";
import { createMockApi, type Scenario } from "./mock";
import type { Snapshot } from "./types";
import { portlessProblems } from "../views/domains/problems";

// The `?mock` portless center behaves like the real one: actions change
// its state after a job, aliases show up in the snapshot, renames change
// the app's address.

async function settle<T>(p: Promise<T>, ms = 600): Promise<T> {
  p.catch(() => {}); // handled by the caller's expect once the timers ran
  await vi.advanceTimersByTimeAsync(ms);
  return p;
}

async function finish(api: ReturnType<typeof createMockApi>, job: Job): Promise<Job> {
  for (let i = 0; i < 40; i++) {
    await vi.advanceTimersByTimeAsync(500);
    const j = await settle(api.job(job.id), 200);
    if (j.state !== "running") return j;
  }
  throw new Error("job never ended");
}

describe("mock portless", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is installed unless the scenario has no portless", async () => {
    for (const [scenario, installed] of [["default", true], ["degraded", false], ["readonly", false], ["broken", true]] as const) {
      const api = createMockApi(scenario as Scenario);
      expect((await settle(api.portlessStatus())).installed).toBe(installed);
    }
    await expect(settle(createMockApi("degraded").portlessDoctor(), 1500)).rejects.toThrow("isn't installed");
  });

  it("adds, edits and removes aliases, and the snapshot follows", async () => {
    const api = createMockApi();
    let snap: Snapshot | null = null;
    api.subscribe({ onSnapshot: (s) => (snap = s), onStatus: () => {} });
    const routes = await settle(api.portlessAddAlias({ name: "db", port: 5432, force: false }));
    expect(routes.find((r) => r.hostname === "db.localhost")?.owner?.label).toBe("postgres");
    expect(snap!.machines[0].otherPorts.find((p) => p.port === 5432)?.route).toBe("db.localhost");
    await expect(settle(api.portlessAddAlias({ name: "db", port: 6379, force: false }))).rejects.toThrow("another alias already uses that name");
    await expect(settle(api.portlessAddAlias({ name: "Bad", port: 1, force: false }))).rejects.toThrow("lowercase");
    const edited = await settle(api.portlessReplaceAlias({ from: "db.localhost", name: "postgres", port: 5432, force: false }));
    expect(edited.some((r) => r.hostname === "db.localhost")).toBe(false);
    expect(edited.some((r) => r.hostname === "postgres.localhost")).toBe(true);
    await settle(api.portlessRemoveAlias("postgres.localhost"));
    expect(snap!.machines[0].otherPorts.find((p) => p.port === 5432)?.route).toBeUndefined();
    await expect(settle(api.portlessRemoveAlias("portplane.localhost"))).rejects.toThrow("Portplane's own");
  });

  it("plans before it runs, and a job changes the state", async () => {
    const api = createMockApi("broken" as Scenario);
    const plan = await settle(api.portlessPlan("service-install"));
    expect(plan.admin).toBe(true);
    expect(plan.steps[0].terminal).toMatch(/^sudo env HOME=\/home\/dev .*portless service install --port 443 --https --tld localhost --tld test$/);
    await expect(settle(api.portlessPlan("ca-fix-ownership"))).resolves.toMatchObject({ admin: true });
    await expect(settle(api.portlessPlan("proxy-start", { port: 0, https: true, wildcard: false, lan: false, unprivileged: false }))).rejects.toThrow("between 1 and 65535");

    let doctor = await settle(api.portlessDoctor(), 1500);
    expect(doctor.failures).toBe(1);
    expect(doctor.findings.filter((f) => f.fix).map((f) => f.fix)).toEqual(expect.arrayContaining(["proxy-start", "trust", "prune", "hosts-sync", "service-install"]));

    for (const action of ["service-install", "trust", "prune", "hosts-sync"] as const) {
      const job = await settle(api.portlessRun(action));
      expect((await finish(api, job)).state).toBe("succeeded");
    }
    doctor = await settle(api.portlessDoctor(), 1500);
    expect(doctor.failures).toBe(0);
    expect(doctor.warnings).toBe(0);
    expect((await settle(api.portlessPrunePreview())).length).toBe(0);
  });

  it("renames an app where its name lives", async () => {
    const api = createMockApi();
    let snap: Snapshot | null = null;
    api.subscribe({ onSnapshot: (s) => (snap = s), onStatus: () => {} });
    const id = "/home/dev/code#my-monorepo/api";
    const info = await settle(api.portlessNameInfo("local", id));
    expect(info).toMatchObject({ source: "task", name: "api.my-monorepo", editable: true });
    expect((await settle(api.portlessNamePreview("local", id, "api.my-monorepo"))).problem).toBe("That's the name it has now.");
    expect((await settle(api.portlessNamePreview("local", id, "my-monorepo"))).problem).toContain("already used");
    const pv = await settle(api.portlessNamePreview("local", id, "backend.my-monorepo"));
    expect(pv.problem).toBeUndefined();
    expect(pv.files[0].after).toContain("[portless, backend.my-monorepo, pnpm, run, dev]");
    await expect(settle(api.portlessRename("local", id, "backend.my-monorepo", "stale"))).rejects.toThrow("changed since the preview");
    const job = await settle(api.portlessRename("local", id, "backend.my-monorepo", pv.digest!));
    expect((await finish(api, job)).state).toBe("succeeded");
    expect(snap!.machines[0].apps.find((a) => a.id === id)?.hostname).toBe("backend.my-monorepo.localhost");

    const studio = await settle(api.portlessNameInfo("local", "/home/dev/code#blog/studio"));
    expect(studio.editable).toBe(false);
    await expect(settle(api.portlessNameInfo("box", "/home/dev/src#shop/web"))).rejects.toThrow("other machines");
  });

  it("edits portless.json, refusing stale and invalid saves", async () => {
    const api = createMockApi();
    const places = await settle(api.portlessConfigs());
    expect(places.map((p) => p.wins)).toEqual(["package.json", "portless.json"]);
    const dir = places.find((p) => p.wins === "portless.json")!.dir;
    const cfg = await settle(api.portlessConfig(dir));
    expect(cfg.portless.config?.name).toBe("docs.my-monorepo");
    const pv = await settle(api.portlessConfigPreview(dir, "portless.json", '{"name": "handbook"}'));
    expect(pv.edit?.after).toBe('{"name": "handbook"}\n');
    expect((await settle(api.portlessConfigPreview(dir, "portless.json", '{"appPort": "x"}'))).problems).toHaveLength(1);
    await expect(settle(api.portlessConfigSave(dir, "portless.json", '{"name": "handbook"}', "old"))).rejects.toThrow("changed since");
    const saved = await settle(api.portlessConfigSave(dir, "portless.json", '{"name": "handbook"}', cfg.portless.digest!));
    expect(saved.portless.config?.name).toBe("handbook");
    await expect(settle(api.portlessConfig("/etc"))).rejects.toThrow("folders Portplane watches");
  });

  it("feeds the Health view's problems", async () => {
    const api = createMockApi("broken" as Scenario);
    let snap: Snapshot | null = null;
    api.subscribe({ onSnapshot: (s) => (snap = s), onStatus: () => {} });
    await vi.advanceTimersByTimeAsync(300);
    const problems = portlessProblems(snap!);
    expect(problems.map((p) => p.id)).toContain("proxy-down|local");
    expect(problems.find((p) => p.id === "proxy-down|local")?.fix?.label).toBe("Start the proxy");
  });
});
