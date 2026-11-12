import { describe, expect, it } from "vitest";
import type { RunnerInfo, RunnersResponse } from "../../api/dekit";
import type { MachineSnapshot, Snapshot } from "../../api/types";
import { runnerProblems } from "./problems";

const runner = (p: Partial<RunnerInfo> & Pick<RunnerInfo, "root" | "name">): RunnerInfo => ({
  kind: "project",
  state: "running",
  restartRequired: false,
  warnings: [],
  watched: true,
  configExists: true,
  ...p,
});

const snap = (dekit = "0.10.3"): Snapshot => ({
  version: 1,
  machines: [
    {
      machine: { id: "local", name: "this computer", local: true, status: "online" },
      tools: { dekit, proxyRunning: true, proxyHttps: true },
      folders: [],
      runners: [],
      apps: [],
      otherPorts: [],
      projects: [],
      updatedAt: "",
    } as MachineSnapshot,
  ],
});

describe("runnerProblems", () => {
  const r: RunnersResponse = {
    available: true,
    live: true,
    stale: 2,
    host: runner({ root: "host", name: "This computer", kind: "host", state: "absent" }),
    runners: [
      runner({ root: "/home/dev/old", name: "old", state: "stale", watched: false }),
      runner({ root: "/home/dev/code/shop", name: "shop", state: "stale", watched: true }),
      runner({ root: "/home/dev/code/blog", name: "blog", restartRequired: true, selectedBinary: "/home/dev/.local/bin/dekit" }),
    ],
  };

  it("reports stale records outside watched folders, and runners that need a restart", () => {
    const ps = runnerProblems(snap(), r);
    expect(ps.map((p) => [p.id, p.fix?.label])).toEqual([
      ["dekit-stale|local", "Clean stale records"],
      ["dekit-restart-required|local|/home/dev/code/blog", "Restart runner"],
    ]);
    expect(ps[0].title).toBe("dekit has a stale record for old");
  });

  it("offers no in-place restart where dekit can't do it", () => {
    expect(runnerProblems(snap(), { ...r, live: false }).find((p) => p.id.startsWith("dekit-restart"))?.fix).toBeUndefined();
  });

  it("says nothing without dekit or before the runners load", () => {
    expect(runnerProblems(snap(""), r)).toEqual([]);
    expect(runnerProblems(snap(), null)).toEqual([]);
  });
});
