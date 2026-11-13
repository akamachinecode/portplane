import { describe, expect, it } from "vitest";
import type { Why } from "../../api/dekit";
import { affectedRunning, changeText, rawStateText, runnerTone, signalName, sinceText, whyMarks, whySentence } from "./why";

// Shapes captured from dekit 0.10.3 (internal/dekit/testdata/0.10.3).
const base: Why = { id: 4, path: "web", state: "idle", wanted: true, supported: false, vetoed: false, pinned: true, required_by: [], deps: [{ path: "api", state: "idle", wanted: true, satisfied: false }], attempts: 0 };

describe("rawStateText", () => {
  it("keeps how the last run ended", () => {
    expect(rawStateText({ state: "backoff", signal: 15, reason: "ready_timeout" })).toBe("backoff (not ready in time)");
    expect(rawStateText({ state: "exited", exit_code: 3 })).toBe("exited (code 3)");
    expect(rawStateText({ state: "exited", signal: 9 })).toBe("exited (signal SIGKILL)");
    expect(rawStateText({ state: "idle", reason: "kill_timeout" })).toBe("idle (stop timed out)");
    expect(rawStateText({ state: "done", exit_code: 0 })).toBe("done");
    expect(signalName("SIGTERM")).toBe("SIGTERM");
    expect(signalName("2")).toBe("SIGINT");
  });
});

describe("whySentence", () => {
  it("reads dekit why as a sentence", () => {
    expect(whySentence(base)).toBe("Waiting for api (idle).");
    expect(whySentence({ ...base, state: "backoff", signal: 15, reason: "ready_timeout", supported: true, deps: [], attempts: 5 })).toBe("It stopped (not ready in time) and dekit will start it again (attempt 6).");
    expect(whySentence({ ...base, vetoed: true, wanted: false })).toMatch(/kept stopped/);
    expect(whySentence({ ...base, state: "ready", pinned: false, supported: true, required_by: ["web", "admin"] })).toBe("Running and ready, because web and admin need it.");
    expect(whySentence({ ...base, state: "exited", exit_code: 3, deps: [] })).toBe("It exited (code 3) and nothing restarts it.");
    expect(whySentence({ ...base, state: "idle", wanted: false, pinned: false, deps: [], required_by: ["web"] })).toBe("Stopped. It starts when web starts.");
  });
  it("lists the marks", () => {
    const marks = whyMarks({ ...base, vetoed: true, required_by: ["web", "admin", "docs", "blog"], attempts: 1 }, { dynamic: true });
    expect(marks.map((m) => m.label)).toEqual(["Started by you", "Kept stopped", "Needed by web, admin, docs and 1 more", "1 restart attempt", "Run once"]);
  });
});

describe("reload plans", () => {
  it("says what a reload does", () => {
    expect(changeText({ path: "worker", kind: "added", apply: true })).toMatch(/added/);
    expect(changeText({ path: "api", kind: "removed", apply: false, reason: "running" })).toMatch(/running: kept/);
    expect(changeText({ path: "web", kind: "changed", apply: true, fields: [{ key: "cmd", base: null, here: null, config: null, conflict: false, take: true }] })).toBe("Command changed");
  });
  it("restarts only running tasks a reload changed", () => {
    const changes = [
      { path: "web", kind: "changed" as const, apply: true },
      { path: "api", kind: "changed" as const, apply: true },
      { path: "worker", kind: "added" as const, apply: true },
    ];
    expect(affectedRunning(changes, [{ task: "web", state: "on" }, { task: "api", state: "off" }, { task: "worker", state: "on" }])).toEqual(["web"]);
  });
});

describe("runners", () => {
  it("tones and durations", () => {
    expect(runnerTone({ state: "stale" })).toBe("off");
    expect(runnerTone({ state: "absent" })).toBe("off");
    const now = Date.parse("2026-11-12T12:00:00Z");
    expect(sinceText("2026-11-12T11:59:30Z", now)).toBe("for less than a minute");
    expect(sinceText("2026-11-12T09:00:00Z", now)).toBe("for 3 hours");
    expect(sinceText("2026-11-08T12:00:00Z", now)).toBe("for 4 days");
    expect(sinceText(undefined, now)).toBe("");
  });
});
