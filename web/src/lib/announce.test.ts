import { describe, expect, it } from "vitest";
import { mockSnapshot } from "../api/mock";
import type { Snapshot, State } from "../api/types";
import { announceChanges } from "./announce";

function withStates(s: Snapshot, states: Record<string, State>): Snapshot {
  const next = structuredClone(s);
  for (const ms of next.machines) for (const a of ms.apps) if (states[a.task]) a.state = states[a.task];
  return next;
}

describe("announceChanges", () => {
  const base = mockSnapshot("default");

  it("says nothing at first or when nothing changed", () => {
    expect(announceChanges(null, base)).toBe("");
    expect(announceChanges(base, structuredClone(base))).toBe("");
  });

  it("names a few changes", () => {
    expect(announceChanges(base, withStates(base, { "my-monorepo/admin": "on", "blog/site": "starting" }))).toBe("admin is running. site is starting.");
    expect(announceChanges(base, withStates(base, { "shop/worker": "failed" }))).toBe("worker on box failed.");
  });

  it("counts many changes", () => {
    const next = withStates(base, { "my-monorepo/web": "off", "my-monorepo/api": "off", "blog/site": "on", "blog/studio": "on" });
    expect(announceChanges(base, next)).toBe("4 apps changed: 2 stopped, 2 running.");
  });
});
