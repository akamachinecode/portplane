import { describe, expect, it } from "vitest";
import type { NameInfo, ProxyOptions } from "../api/portless";
import type { ComposeProject, ShareInfo, ShareProvider, ShareView } from "../api/sharing";
import { composeNameProblem, previewHostname, renameProblem } from "./portless";
import { applyAction, composeFileFrom, composeHostnames, composeSummary, lanAddressProblem, lanChoice, lanOptions, replacedBy, shareState, sortShares } from "./sharing";

const provider = (kind: ShareProvider["kind"], ok: boolean): ShareProvider => ({
  kind,
  label: kind,
  public: kind !== "tailscale",
  ready: ok,
  where: "",
  notes: [],
  requirements: [{ id: `${kind}-x`, ok, label: "x", problem: ok ? undefined : `${kind} is missing` }],
});

const info = (patch: Partial<ShareInfo> = {}): ShareInfo => ({
  hostname: "web.localhost",
  source: "fragment",
  editable: true,
  running: true,
  on: [],
  env: [],
  shared: [],
  providers: [provider("tailscale", true), provider("funnel", false), provider("ngrok", true), provider("cloudflare", false)],
  ...patch,
});

describe("shareState", () => {
  it("can turn on a ready share and says what's missing for the others", () => {
    expect(shareState(info(), "tailscale")).toMatchObject({ on: false, canToggle: true });
    expect(shareState(info(), "funnel")).toMatchObject({ canToggle: false, why: "funnel is missing" });
  });

  it("can turn off a share even when its tool went missing since", () => {
    const s = shareState(info({ on: ["cloudflare"], shared: [{ kind: "cloudflare", url: "https://x.trycloudflare.com" }] }), "cloudflare");
    expect(s).toMatchObject({ on: true, canToggle: true, url: "https://x.trycloudflare.com" });
  });

  it("leaves a share the environment turns on, and an app it can't edit", () => {
    expect(shareState(info({ env: ["ngrok"] }), "ngrok")).toMatchObject({ on: true, viaEnv: true, canToggle: false });
    expect(shareState(info({ editable: false, reason: "no portless" }), "tailscale")).toMatchObject({ canToggle: false, why: "no portless" });
  });

  it("knows Funnel and the tailnet replace each other", () => {
    expect(replacedBy(info({ on: ["funnel"] }), "tailscale")).toBe("funnel");
    expect(replacedBy(info({ on: ["tailscale"] }), "funnel")).toBe("tailscale");
    expect(replacedBy(info({ on: ["ngrok"] }), "tailscale")).toBeUndefined();
  });
});

describe("sharing lists", () => {
  it("puts public shares first", () => {
    const v = (hostname: string, kind: ShareView["kind"]): ShareView => ({ hostname, kind, url: "", public: kind !== "tailscale", alive: true, editable: true });
    expect(sortShares([v("a.localhost", "tailscale"), v("b.localhost", "ngrok"), v("a.localhost", "cloudflare")]).map((s) => `${s.hostname}:${s.kind}`)).toEqual([
      "a.localhost:cloudflare",
      "b.localhost:ngrok",
      "a.localhost:tailscale",
    ]);
  });
});

describe("LAN options", () => {
  const base: ProxyOptions = { port: 443, https: true, tlds: ["localhost", "test"], wildcard: false, lan: false, unprivileged: false };

  it("switches the domains to .local and back", () => {
    const on = lanOptions(base, true, " 192.168.1.20 ");
    expect(on).toMatchObject({ lan: true, lanIp: "192.168.1.20", tlds: ["local"], port: 443 });
    expect(lanOptions(base, true, "")).not.toHaveProperty("lanIp");
    const off = lanOptions(on, false);
    expect(off).toMatchObject({ lan: false, tlds: ["localhost"] });
    expect(off).not.toHaveProperty("lanIp");
  });

  it("reads which address LAN mode publishes", () => {
    const addresses = [{ ip: "192.168.1.20", interface: "wlan0", default: true }];
    expect(lanChoice({ options: { ...base, lan: true }, addresses })).toEqual({ mode: "follow" });
    expect(lanChoice({ options: { ...base, lan: true, lanIp: "192.168.1.20" }, addresses })).toEqual({ mode: "pin", ip: "192.168.1.20" });
    expect(lanChoice({ options: { ...base, lan: true, lanIp: "10.8.0.2" }, addresses })).toEqual({ mode: "custom", ip: "10.8.0.2" });
  });

  it("accepts only an IPv4 address other devices can reach", () => {
    expect(lanAddressProblem(" 192.168.1.20 ")).toBeNull();
    expect(lanAddressProblem("10.0.0.5")).toBeNull();
    expect(lanAddressProblem("")).toMatch(/Type the address/);
    expect(lanAddressProblem("192.168.1")).toMatch(/IPv4/);
    expect(lanAddressProblem("192.168.1.256")).toMatch(/IPv4/);
    expect(lanAddressProblem("192.168.01.2")).toMatch(/IPv4/);
    expect(lanAddressProblem("fe80::1")).toMatch(/IPv4/);
    expect(lanAddressProblem("127.0.0.1")).toMatch(/this computer only/);
    expect(lanAddressProblem("169.254.10.2")).toMatch(/link-local/);
    expect(lanAddressProblem("239.1.1.1")).toMatch(/isn't an address/);
  });

  it("applies through the service when there is one", () => {
    expect(applyAction(true, true)).toBe("service-install");
    expect(applyAction(false, true)).toBe("proxy-restart");
    expect(applyAction(false, false)).toBe("proxy-start");
  });
});

describe("compose", () => {
  const project: ComposeProject = {
    name: "shop",
    label: "shop",
    started: true,
    ports: {},
    state: "running",
    routes: [{ hostname: "web.shop.localhost", url: "", port: 14001, listening: true }],
    services: [
      { name: "web", label: "web", enabled: true, ports: [{ target: 5173, hostPort: 14001, routed: true }] },
      { name: "api", label: "backend", nameLabel: "backend", enabled: true, ports: [{ target: 8080, routed: true }, { target: 9229, routed: true }] },
      { name: "db", label: "db", enabled: true, ports: [{ target: 5432, routed: false, reason: "not HTTP" }] },
    ],
  };

  it("builds a service's addresses as portless does", () => {
    expect(composeHostnames(project, project.services[0], "localhost")).toEqual(["web.shop.localhost"]);
    expect(composeHostnames(project, project.services[1], "test")).toEqual(["backend.shop.test", "8080.backend.shop.test", "9229.backend.shop.test"]);
    expect(composeHostnames(project, project.services[2], "localhost")).toEqual([]);
  });

  it("summarises a project and where its file came from", () => {
    expect(composeSummary(project)).toBe("3 services · 1 address");
    expect(composeSummary({ ...project, services: [], routes: [] })).toBe("No services known yet");
    expect(composeFileFrom({ fileFrom: "containers" })).toContain("Docker");
    expect(composeFileFrom({})).toBe("not found");
  });

  it("checks a compose name and previews its address", () => {
    expect(composeNameProblem("store")).toBeNull();
    expect(composeNameProblem("proxy")).toBeNull();
    expect(composeNameProblem("api.v2")).toContain("without dots");
    expect(composeNameProblem("a_b")).toContain("letters, digits and dashes");
    const name: NameInfo = { source: "compose", name: "web", inferred: false, hostname: "web.shop.localhost", editable: true, reason: "", tld: "localhost", runMode: false, suffix: "shop.localhost", taken: ["api.shop.localhost"], notes: [], running: true };
    expect(previewHostname(name, "Store")).toBe("store.shop.localhost");
    expect(previewHostname(name, "store.shop.localhost")).toBe("store.shop.localhost");
    expect(renameProblem(name, "web")).toBe("That's the name it has now.");
    expect(renameProblem(name, "api")).toContain("already used");
    expect(renameProblem(name, "a.b")).toContain("without dots");
    expect(renameProblem(name, "store")).toBeNull();
  });
});
