import { afterEach, describe, expect, it } from "vitest";
import { mockSnapshot } from "../api/mock";
import { collectProblems, problemBadge, registerProblemSource, snapshotProblems, type Problem } from "./health";

const summary = (ps: Problem[]) => ps.map((p) => `${p.severity}: ${p.title}${p.fix ? ` [${p.fix.label}]` : ""}`);

describe("snapshotProblems", () => {
  it("lists failed apps and offline machines, errors first", () => {
    expect(summary(snapshotProblems(mockSnapshot("default")))).toEqual(["error: admin failed [Start again]", "error: Can't reach mac-mini [Edit machine]"]);
  });

  it("links a failed app to its details", () => {
    const failed = snapshotProblems(mockSnapshot("default"))[0];
    expect(failed.link?.route).toEqual({ view: "apps", detail: { machine: "local", appId: "/home/dev/code#my-monorepo/admin", tab: "summary" } });
    expect(failed.fix?.pendingKey).toBe("app|local|/home/dev/code#my-monorepo/admin|start");
  });

  it("explains missing tools and a runner that is down, with their fixes", () => {
    expect(summary(snapshotProblems(mockSnapshot("degraded")))).toEqual([
      "error: admin failed [Start again]",
      "warning: dekit isn't running for legacy-app [Start runner]",
      "info: portless isn't installed [See how to install]",
    ]);
    expect(summary(snapshotProblems(mockSnapshot("readonly")))).toEqual(["warning: dekit isn't installed [See how to install]", "info: portless isn't installed [See how to install]"]);
  });

  it("reports a stopped proxy and a runner that can't be read", () => {
    const s = mockSnapshot("empty");
    s.machines[0].tools.proxyRunning = false;
    s.machines[0].runners = [{ root: "/home/dev/code", name: "code", up: true, error: "invalid dekit.yaml" }];
    expect(summary(snapshotProblems(s))).toEqual(["warning: The portless proxy isn't running [Open setup]", "warning: Problem reading code"]);
  });

  it("finds nothing wrong when all is well", () => {
    expect(snapshotProblems(mockSnapshot("empty"))).toEqual([]);
  });

  it("has stable ids", () => {
    const a = snapshotProblems(mockSnapshot("degraded")).map((p) => p.id);
    const b = snapshotProblems(mockSnapshot("degraded")).map((p) => p.id);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
  });
});

describe("problem sources", () => {
  const off: Array<() => void> = [];
  afterEach(() => off.splice(0).forEach((f) => f()));

  it("merges registered sources into the list, by severity", () => {
    off.push(registerProblemSource("test", () => [{ id: "doctor|ca", severity: "warning", title: "The local CA isn't trusted" }]));
    expect(summary(collectProblems(mockSnapshot("default")))).toEqual([
      "error: admin failed [Start again]",
      "error: Can't reach mac-mini [Edit machine]",
      "warning: The local CA isn't trusted",
    ]);
  });
});

describe("problemBadge", () => {
  it("counts errors and warnings, not notes", () => {
    expect(problemBadge(snapshotProblems(mockSnapshot("degraded")))).toEqual({ count: 2, tone: "error" });
    expect(problemBadge(snapshotProblems(mockSnapshot("readonly")))).toEqual({ count: 1, tone: "warning" });
    expect(problemBadge([])).toEqual({ count: 0, tone: null });
  });
});
