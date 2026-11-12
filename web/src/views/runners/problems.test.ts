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

const machine = (id: string, dekit: string, local: boolean, status: MachineSnapshot["machine"]["status"] = "online"): MachineSnapshot =>
  ({
    machine: { id, name: local ? "this computer" : id, local, status },
    tools: { dekit, proxyRunning: true, proxyHttps: true },
    folders: [],
    runners: [],
    apps: [],
    otherPorts: [],
    projects: [],
    updatedAt: "",
  }) as MachineSnapshot;

const snap = (dekit = "0.10.3", boxStatus: MachineSnapshot["machine"]["status"] = "online"): Snapshot => ({
  version: 1,
  machines: [machine("local", dekit, true), machine("box", "0.10.3", false, boxStatus)],
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
    const ps = runnerProblems(snap(), { machine: "local", runners: r });
    expect(ps.map((p) => [p.id, p.fix?.label])).toEqual([
      ["dekit-stale|local", "Clean stale records"],
      ["dekit-restart-required|local|/home/dev/code/blog", "Restart runner"],
    ]);
    expect(ps[0].title).toBe("dekit has a stale record for old");
  });

  it("offers no in-place restart where dekit can't do it", () => {
    expect(runnerProblems(snap(), { machine: "local", runners: { ...r, live: false } }).find((p) => p.id.startsWith("dekit-restart"))?.fix).toBeUndefined();
  });

  it("says nothing without dekit or before the runners load", () => {
    expect(runnerProblems(snap(""), { machine: "local", runners: r })).toEqual([]);
    expect(runnerProblems(snap())).toEqual([]);
  });

  it("reports a machine over SSH under its own id, linking to its runners", () => {
    const ps = runnerProblems(snap(), { machine: "box", runners: r });
    expect(ps.map((p) => p.id)).toEqual(["dekit-stale|box", "dekit-restart-required|box|/home/dev/code/blog"]);
    expect(ps[0].machine).toEqual({ id: "box", name: "box" });
    expect(ps[0].link?.route).toEqual({ view: "runners", machine: "box" });
    expect(ps[1].fix?.pendingKey).toBe("dekit-restart|box|/home/dev/code/blog");
  });

  it("says nothing about a machine that is offline", () => {
    expect(runnerProblems(snap("0.10.3", "offline"), { machine: "box", runners: r })).toEqual([]);
  });
});
