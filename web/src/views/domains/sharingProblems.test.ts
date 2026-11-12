import { describe, expect, it } from "vitest";
import type { LanView, Requirement, ShareProvider, SharingOverview, ShareView } from "../../api/sharing";
import type { MachineSnapshot, Snapshot } from "../../api/types";
import { sharingProblems } from "./sharingProblems";

const snap = (portless: string | undefined = "0.16.0"): Snapshot => ({
  version: 1,
  machines: [
    {
      machine: { id: "local", name: "This computer", local: true, status: "online" },
      tools: { portless, proxyRunning: true, proxyHttps: true },
      folders: [],
      runners: [],
      apps: [],
      otherPorts: [],
      projects: [],
      updatedAt: "",
    } as MachineSnapshot,
  ],
});

const req = (id: string, ok: boolean, extra: Partial<Requirement> = {}): Requirement => ({ id, ok, label: id, ...extra });
const provider = (kind: ShareProvider["kind"], reqs: Requirement[]): ShareProvider => ({ kind, label: kind, public: kind !== "tailscale", ready: reqs.every((r) => r.ok), where: "", notes: [], requirements: reqs });
const share = (hostname: string, kind: ShareView["kind"], alive = true): ShareView => ({ hostname, kind, url: `https://${hostname}.example`, public: kind !== "tailscale", alive, editable: true });

describe("sharingProblems", () => {
  const ready: SharingOverview = {
    os: "linux",
    providers: [provider("tailscale", [req("tailscale-running", true)]), provider("ngrok", [req("ngrok-installed", true)])],
    shares: [share("web.localhost", "tailscale")],
  };

  it("says nothing when nothing is open and every share works", () => {
    expect(sharingProblems(snap(), ready, undefined, false)).toEqual([]);
    expect(sharingProblems(snap(undefined), ready, undefined, false)).toEqual([]);
    expect(sharingProblems(snap(), undefined, undefined, false)).toEqual([]);
  });

  it("warns when the way an app is shared stopped working", () => {
    const broken: SharingOverview = {
      ...ready,
      providers: [provider("tailscale", [req("tailscale-running", false, { problem: "You aren't signed in to Tailscale on this computer.", fix: "Sign in.", command: "sudo tailscale up" })])],
    };
    const [p] = sharingProblems(snap(), broken, undefined, false);
    expect(p).toMatchObject({ id: "share-broken|local|tailscale", severity: "warning", code: "sudo tailscale up", link: { route: { view: "domains", section: "sharing" } } });
    expect(p.title).toBe("An app shared with Tailnet may not be reachable");
    expect(p.detail).toBe("You aren't signed in to Tailscale on this computer. Sign in.");
    expect(p.fix).toBeUndefined();
  });

  it("offers the operator fix Portplane runs itself", () => {
    const op: SharingOverview = { ...ready, providers: [provider("tailscale", [req("tailscale-operator", false, { action: "tailscale-operator" })])] };
    expect(sharingProblems(snap(), op, undefined, false)[0].fix?.label).toBe("Let your user share");
  });

  it("lists apps open to the internet, but not stopped ones", () => {
    const open: SharingOverview = { ...ready, shares: [share("api.localhost", "funnel"), share("api.localhost", "ngrok"), share("docs.localhost", "cloudflare", false), share("web.localhost", "tailscale")] };
    const [p] = sharingProblems(snap(), open, undefined, false);
    expect(p).toMatchObject({ id: "share-public|local", severity: "info", title: "api.localhost is open to the internet" });
    expect(p.detail).toContain("api.localhost (Funnel), api.localhost (ngrok)");
    expect(p.detail).not.toContain("docs.localhost");
  });

  it("warns when LAN mode is on but names can't be published", () => {
    const lan = { requirements: [req("mdns-tool", false, { problem: "avahi-publish-address isn't installed.", command: "sudo apt install avahi-utils" })] } as LanView;
    expect(sharingProblems(snap(), undefined, lan, false)).toEqual([]);
    const [p] = sharingProblems(snap(), undefined, lan, true);
    expect(p).toMatchObject({ id: "lan-broken|local", severity: "warning", code: "sudo apt install avahi-utils", link: { route: { view: "domains", section: "lan" } } });
  });
});
