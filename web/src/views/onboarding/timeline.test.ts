import { describe, expect, it } from "vitest";
import { mockSnapshot } from "../../api/mock";
import type { Requirement } from "../../api/types";
import { stepDone, stepRecord, stepStatuses, type TimelineFacts } from "./timeline";

const ms = mockSnapshot("default").machines[0];
const req = (id: Requirement["id"], status: Requirement["status"], version?: string): Requirement => ({ id, name: id, why: "", ok: status === "ok", status, version, privilege: false });

const facts = (over: Partial<TimelineFacts> = {}): TimelineFacts => ({
  checks: { dekit: req("dekit", "ok", "0.10.3"), node: req("node", "ok", "24.18.0"), portless: req("portless", "ok", "0.17.0"), ca: req("ca", "ok") },
  flow: { toolsReady: true, proxyReady: true, browsersNeeded: false },
  folders: ["/home/dev/code"],
  ms,
  done: new Set(["welcome"]),
  home: "/home/dev",
  ...over,
});

describe("the setup timeline", () => {
  it("reads each step from how things are now, not only from the saved progress", () => {
    const f = facts();
    expect(stepDone("install", f)).toBe(true);
    expect(stepDone("proxy", f)).toBe(true);
    expect(stepDone("folders", f)).toBe(true);
    expect(stepDone("start", f)).toBe(true);
    expect(stepDone("install", facts({ flow: { toolsReady: false, proxyReady: true, browsersNeeded: false } }))).toBe(false);
    expect(stepDone("folders", facts({ folders: [] }))).toBe(false);
  });

  it("says in one line what each step found", () => {
    const f = facts();
    expect(stepRecord("install", f)).toBe("dekit 0.10.3 · Node.js 24.18.0 · portless 0.17.0");
    expect(stepRecord("folders", f)).toBe("~/code");
    expect(stepRecord("check", f)).toBe("All 4 checks pass");
    expect(stepRecord("install", facts({ checks: { dekit: req("dekit", "missing") }, flow: { toolsReady: false, proxyReady: false, browsersNeeded: null } }))).toBe("Missing: dekit, Node.js, portless");
    expect(stepRecord("proxy", f)).toMatch(/^HTTPS on port \d+ · certificate trusted$/);
    expect(stepRecord("apps", f)).toMatch(/^\d+ apps in \d+ projects$/);
  });

  it("marks the open step current and the rest done or to do", () => {
    const s = stepStatuses(["welcome", "check", "install", "folders", "done"], "install", facts({ folders: [] }));
    expect(s).toEqual({ welcome: "done", check: "done", install: "current", folders: "todo", done: "todo" });
  });
});
