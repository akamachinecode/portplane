import { describe, expect, it } from "vitest";
import { mockPreferences, mockSnapshot } from "../api/mock";
import { checklist, checklistVisible, doneCount } from "./gettingStarted";

const local = (scenario: Parameters<typeof mockSnapshot>[0]) => mockSnapshot(scenario).machines.find((m) => m.machine.local);

describe("checklist", () => {
  it("reads every step from the live state", () => {
    const items = checklist(local("default"));
    expect(items.map((i) => `${i.id}:${i.done}`)).toEqual(["tools:true", "https:true", "projects:true", "start:true"]);
    const fresh = checklist(local("nofolders"));
    expect(fresh.map((i) => `${i.id}:${i.done}`)).toEqual(["tools:true", "https:true", "projects:false", "start:false"]);
    expect(doneCount(fresh)).toBe(2);
  });
  it("knows nothing without a machine", () => {
    expect(doneCount(checklist(undefined))).toBe(0);
  });
  it("shows until it is done or hidden", () => {
    const prefs = mockPreferences("nofolders");
    const fresh = checklist(local("nofolders"));
    expect(checklistVisible(prefs, fresh)).toBe(true);
    expect(checklistVisible(null, fresh)).toBe(false);
    expect(checklistVisible({ ...prefs, onboarding: { ...prefs.onboarding, choices: { checklist: "hidden" } } }, fresh)).toBe(false);
    expect(checklistVisible(prefs, checklist(local("default")))).toBe(false);
  });
});
