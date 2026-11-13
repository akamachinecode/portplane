import { describe, expect, it } from "vitest";
import type { Requirement, ShareProvider } from "../../api/sharing";
import { needsWord, ownNeeds } from "./shareStatus";

const req = (id: string, ok: boolean): Requirement => ({ id, ok, label: id });
const provider = (kind: ShareProvider["kind"], label: string, reqs: Requirement[]): ShareProvider => ({ kind, label, public: kind !== "tailscale", ready: reqs.every((r) => r.ok), where: "", requirements: reqs, notes: [] });

describe("needsWord", () => {
  it("says Ready when nothing is missing", () => {
    expect(needsWord([req("tailscale-installed", true)])).toBe("Ready");
  });
  it("names the tool once, however many of its needs are missing", () => {
    expect(needsWord([req("tailscale-installed", true), req("tailscale-running", false), req("tailscale-https", false)])).toBe("Needs Tailscale");
    expect(needsWord([req("ngrok-installed", false), req("ngrok-authtoken", false)])).toBe("Needs ngrok");
  });
  it("names two tools, and counts what it can't name", () => {
    expect(needsWord([req("tailscale-running", false), req("tailscale-funnel", false)])).toBe("Needs Tailscale and Funnel allowed");
    expect(needsWord([req("something-else", false), req("ngrok-installed", false)])).toBe("2 things missing");
  });
});

describe("ownNeeds", () => {
  it("lists a need once, under the first way that has it", () => {
    const off = req("tailscale-running", false);
    const list = [provider("tailscale", "Your tailnet", [req("tailscale-installed", true), off]), provider("funnel", "Funnel", [off, req("tailscale-funnel", false)]), provider("ngrok", "ngrok", [req("ngrok-installed", false)])];
    const m = ownNeeds(list);
    expect(m.get("tailscale")).toEqual({ own: [off], sharedWith: undefined });
    expect(m.get("funnel")?.own.map((r) => r.id)).toEqual(["tailscale-funnel"]);
    expect(m.get("funnel")?.sharedWith).toBe("Your tailnet");
    expect(m.get("ngrok")?.own.map((r) => r.id)).toEqual(["ngrok-installed"]);
  });
});
