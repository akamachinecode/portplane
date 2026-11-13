import { describe, expect, it } from "vitest";
import type { MachineSnapshot, Preferences, Requirement } from "../../api/types";
import { DEFAULT_PREFERENCES } from "../../lib/preferences";
import { CHECK_ORDER, firstFixStep, firstRunAction, flowOf, nextStep, parseStep, prevStep, problems, progressOf, reached, resumeStep, statusOf, STEP_IDS } from "./steps";

const req = (p: Partial<Requirement> & Pick<Requirement, "id">): Requirement => ({ name: p.id, why: "", ok: false, privilege: false, ...p });

const ready = { toolsReady: true, proxyReady: true, browsersNeeded: false, pathNeeded: false };

describe("steps", () => {
  it("parses steps, falling back to the welcome", () => {
    expect(parseStep("proxy")).toBe("proxy");
    expect(parseStep(undefined)).toBe("welcome");
    expect(parseStep("nonsense")).toBe("welcome");
    expect(progressOf("welcome")).toBe(0);
    expect(progressOf("done")).toBe(1);
  });

  it("skips steps with nothing left to do, never the last", () => {
    expect(nextStep("welcome", ready)).toBe("check");
    expect(nextStep("check", ready)).toBe("proxy");
    expect(nextStep("check", { ...ready, toolsReady: false })).toBe("install");
    expect(nextStep("check", { ...ready, pathNeeded: true })).toBe("install");
    expect(nextStep("proxy", ready)).toBe("folders");
    expect(nextStep("proxy", { ...ready, browsersNeeded: null })).toBe("browsers");
    expect(nextStep("proxy", { ...ready, browsersNeeded: true })).toBe("browsers");
    expect(nextStep("start", ready)).toBe("done");
    expect(nextStep("done", ready)).toBe("done");
    expect(prevStep("proxy")).toBe("install");
    expect(prevStep("welcome")).toBe("welcome");
  });

  it("sends Fix everything to the first step with work", () => {
    expect(firstFixStep({ ...ready, toolsReady: false })).toBe("install");
    expect(firstFixStep({ ...ready, proxyReady: false })).toBe("proxy");
    expect(firstFixStep({ ...ready, browsersNeeded: true })).toBe("browsers");
    expect(firstFixStep(ready)).toBe("folders");
  });

  it("records reached steps as done, in order, keeping the rest", () => {
    const p = reached({ completed: false, skipped: true, done: ["check"], choices: { proxy: "service" } }, "proxy");
    expect(p.step).toBe("proxy");
    expect(p.done).toEqual(["welcome", "check", "install"]);
    expect(p.skipped).toBe(true);
    expect(p.choices).toEqual({ proxy: "service" });
  });

  it("resumes at the saved step, or the record once completed", () => {
    expect(resumeStep({ completed: false, skipped: false, done: [], step: "apps" })).toBe("apps");
    expect(resumeStep({ completed: true, skipped: false, done: [], step: "check" })).toBe("done");
    expect(resumeStep({ completed: false, skipped: false, done: [] })).toBe("welcome");
  });

  it("derives statuses from older binaries' answers", () => {
    expect(statusOf(req({ id: "dekit", ok: true }))).toBe("ok");
    expect(statusOf(req({ id: "git", optional: true }))).toBe("warning");
    expect(statusOf(req({ id: "dekit" }))).toBe("missing");
    expect(statusOf(req({ id: "hosts", ok: true, status: "skipped" }))).toBe("skipped");
  });

  it("counts problems, never notes or skipped checks", () => {
    const list = [
      req({ id: "dekit", status: "missing" }),
      req({ id: "git", status: "warning", optional: true }),
      req({ id: "packages", ok: true, status: "info" }),
      req({ id: "hosts", ok: true, status: "skipped" }),
      req({ id: "node", status: "outdated" }),
    ];
    expect(problems(list).map((r) => r.id)).toEqual(["dekit", "git", "node"]);
    expect(CHECK_ORDER[0]).toBe("dekit");
  });

  it("reads the flow from a check", () => {
    const f = flowOf({
      dekit: req({ id: "dekit", ok: true, status: "ok" }),
      node: req({ id: "node", ok: true, status: "ok" }),
      portless: req({ id: "portless", ok: true, status: "ok" }),
      proxy: req({ id: "proxy", ok: true, status: "ok" }),
      ca: req({ id: "ca", status: "warning", problem: "Not trusted yet by Firefox.", fix: "trust-browsers" }),
      path: req({ id: "path", status: "warning", optional: true }),
    });
    expect(f).toEqual({ toolsReady: true, proxyReady: true, browsersNeeded: true, pathNeeded: true });
    const untrusted = flowOf({ proxy: req({ id: "proxy", ok: true, status: "ok" }), ca: req({ id: "ca", status: "missing", problem: "x", fix: "trust-system" }) });
    expect(untrusted.proxyReady).toBe(false);
    expect(untrusted.toolsReady).toBe(false);
    expect(flowOf({}, false).browsersNeeded).toBe(false);
  });
});

describe("firstRunAction", () => {
  const ms = (folders: string[], dekit?: string, portless?: string): MachineSnapshot => ({
    machine: { id: "local", name: "This computer", local: true, status: "online" },
    tools: { dekit, portless, proxyRunning: false, proxyHttps: false },
    folders,
    runners: [],
    apps: [],
    otherPorts: [],
    projects: [],
    updatedAt: "",
  });
  const prefs = (o: Partial<Preferences["onboarding"]>): Preferences => ({ ...DEFAULT_PREFERENCES, onboarding: { ...DEFAULT_PREFERENCES.onboarding, ...o } });

  it("shows the setup on a first run", () => {
    expect(firstRunAction(prefs({}), ms([]))).toBe("show");
    expect(firstRunAction(prefs({}), ms(["/home/dev/code"], "0.10.3"))).toBe("show");
  });
  it("marks someone already set up as done, silently", () => {
    expect(firstRunAction(prefs({}), ms(["/home/dev/code"], "0.10.3", "0.16.0"))).toBe("complete");
  });
  it("leaves it alone once completed or skipped", () => {
    expect(firstRunAction(prefs({ completed: true }), ms([]))).toBeNull();
    expect(firstRunAction(prefs({ skipped: true }), ms([]))).toBeNull();
    expect(firstRunAction(prefs({}), undefined)).toBeNull();
  });
  it("lists every step once", () => {
    expect(new Set(STEP_IDS).size).toBe(STEP_IDS.length);
  });
});
