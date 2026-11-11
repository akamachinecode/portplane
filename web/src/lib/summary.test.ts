import { describe, expect, it } from "vitest";
import { mockSnapshot } from "../api/mock";
import type { App, Snapshot } from "../api/types";
import { documentTitle, summarize, summaryText } from "./summary";

function snap(apps: Array<Partial<App>>): Snapshot {
  const base = mockSnapshot("empty");
  base.machines[0].apps = apps.map((p, i) => ({
    id: `r#${i}`,
    runner: "r",
    task: `t${i}`,
    label: `t${i}`,
    kind: "service",
    project: "p",
    state: "off",
    order: i,
    ...p,
  }));
  return base;
}

describe("summarize", () => {
  it("counts the mock", () => {
    // web and api on; docs, the checkout install and the checkout web starting; admin failed
    expect(summarize(mockSnapshot())).toEqual({ running: 2, starting: 3, stopping: 0, failed: 1 });
  });
  it("leaves hidden jobs out", () => {
    const s = summarize(snap([{ kind: "job", state: "done" }, { kind: "job", state: "on" }, { kind: "job", state: "failed" }]));
    expect(s).toEqual({ running: 0, starting: 0, stopping: 0, failed: 1 });
  });
  it("adds up every machine", () => {
    const one = snap([{ state: "on" }]);
    const two: Snapshot = { ...one, machines: [one.machines[0], { ...one.machines[0], machine: { ...one.machines[0].machine, id: "box" } }] };
    expect(summarize(two).running).toBe(2);
  });
});

describe("summaryText", () => {
  it("joins the non-zero counts, running always first", () => {
    expect(summaryText({ running: 4, failed: 1, starting: 2, stopping: 0 })).toBe("4 running · 1 failed · 2 starting");
    expect(summaryText({ running: 0, failed: 0, starting: 0, stopping: 1 })).toBe("0 running · 1 stopping");
  });
});

describe("documentTitle", () => {
  it("shows what runs and what failed", () => {
    expect(documentTitle(null)).toBe("Portplane");
    expect(documentTitle({ running: 0, failed: 0, starting: 3, stopping: 0 })).toBe("Portplane");
    expect(documentTitle({ running: 2, failed: 1, starting: 0, stopping: 0 })).toBe("Portplane · 2 running, 1 failed");
  });
});
