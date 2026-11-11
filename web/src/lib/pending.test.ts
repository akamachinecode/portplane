import { describe, expect, it } from "vitest";
import { mockSnapshot } from "../api/mock";
import type { Snapshot } from "../api/types";
import { appsFingerprint, nextExpiry, PENDING_TIMEOUT, prunePending, runnerFingerprint, type PendingEntry } from "./pending";

function withApp(s: Snapshot, task: string, patch: object): Snapshot {
  const next = structuredClone(s);
  next.machines[0].apps = next.machines[0].apps.map((a) => (a.task === task ? { ...a, ...patch } : a));
  return next;
}

function entry(key: string, fp: (s: Snapshot) => string, base: Snapshot, startedAt = 0): PendingEntry {
  return { key, startedAt, baseline: fp(base), fingerprint: fp };
}

const base = mockSnapshot();
const web = base.machines[0].apps.find((a) => a.task === "my-monorepo/web")!;
const site = base.machines[0].apps.find((a) => a.task === "blog/site")!;

describe("prunePending", () => {
  it("keeps an entry while its app is unchanged", () => {
    const e = entry("a", appsFingerprint("local", [web.id]), base);
    const entries = [e];
    expect(prunePending(entries, base, 1000)).toBe(entries);
    // a change to another app does not release it
    expect(prunePending(entries, withApp(base, "blog/site", { state: "starting" }), 1000)).toEqual([e]);
  });
  it("drops an entry once its app changes state", () => {
    const e = entry("a", appsFingerprint("local", [web.id]), base);
    expect(prunePending([e], withApp(base, "my-monorepo/web", { state: "stopping" }), 1000)).toEqual([]);
  });
  it("catches a restart that only changed the pid", () => {
    const e = entry("a", appsFingerprint("local", [web.id]), base);
    expect(prunePending([e], withApp(base, "my-monorepo/web", { pid: 99999 }), 1000)).toEqual([]);
  });
  it("drops a group entry when any of its apps changes", () => {
    const e = entry("g", appsFingerprint("local", [web.id, site.id]), base);
    expect(prunePending([e], withApp(base, "blog/site", { state: "starting" }), 1000)).toEqual([]);
  });
  it("times out", () => {
    const e = entry("a", appsFingerprint("local", [web.id]), base, 0);
    expect(prunePending([e], null, PENDING_TIMEOUT - 1)).toEqual([e]);
    expect(prunePending([e], null, PENDING_TIMEOUT)).toEqual([]);
    expect(prunePending([e], base, PENDING_TIMEOUT + 1)).toEqual([]);
  });
  it("follows a runner coming up", () => {
    const down = mockSnapshot("degraded");
    const root = down.machines[0].runners.find((r) => !r.up)!.root;
    const e = entry("r", runnerFingerprint("local", root), down);
    const up = structuredClone(down);
    up.machines[0].runners = up.machines[0].runners.map((r) => ({ ...r, up: true, error: undefined }));
    expect(prunePending([e], down, 10)).toEqual([e]);
    expect(prunePending([e], up, 10)).toEqual([]);
  });
});

describe("nextExpiry", () => {
  it("returns the time left for the oldest entry", () => {
    const fp = () => "";
    expect(nextExpiry([], 0)).toBeUndefined();
    expect(nextExpiry([entry("a", fp, base, 1000), entry("b", fp, base, 3000)], 4000)).toBe(PENDING_TIMEOUT - 3000);
    expect(nextExpiry([entry("a", fp, base, 0)], PENDING_TIMEOUT * 2)).toBe(0);
  });
});
