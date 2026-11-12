import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "./jobs";
import { createMockApi } from "./mock";

// The `?mock` sharing, compose and LAN endpoints behave like the real ones:
// requirements first, a preview, then a job that changes what they report.

const ROOT = "/home/dev/code";
const WEB = `${ROOT}#my-monorepo/web`;
const API = `${ROOT}#my-monorepo/api`;

async function settle<T>(p: Promise<T>, ms = 800): Promise<T> {
  p.catch(() => {});
  await vi.advanceTimersByTimeAsync(ms);
  return p;
}

async function finish(api: ReturnType<typeof createMockApi>, job: Job): Promise<Job> {
  for (let i = 0; i < 40; i++) {
    await vi.advanceTimersByTimeAsync(500);
    const j = await settle(api.job(job.id), 200);
    if (j.state !== "running") return j;
  }
  throw new Error("job never ended");
}

describe("mock sharing", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("says what each way to share needs, per scenario", async () => {
    const ready = (o: Awaited<ReturnType<ReturnType<typeof createMockApi>["portlessSharing"]>>) => Object.fromEntries(o.providers.map((p) => [p.kind, p.ready]));
    expect(ready(await settle(createMockApi().portlessSharing()))).toEqual({ tailscale: true, funnel: false, ngrok: false, cloudflare: false });
    expect(ready(await settle(createMockApi("tailnet").portlessSharing()))).toEqual({ tailscale: true, funnel: true, ngrok: true, cloudflare: true });
    const bare = await settle(createMockApi("bare").portlessSharing());
    expect(ready(bare)).toEqual({ tailscale: false, funnel: false, ngrok: false, cloudflare: false });
    expect(bare.shares).toEqual([]);
    expect(bare.providers[0].requirements[0]).toMatchObject({ id: "tailscale-installed", ok: false, url: "https://tailscale.com/download" });
  });

  it("lists what's shared, and who can stop it", async () => {
    const ov = await settle(createMockApi("tailnet").portlessSharing());
    const byHost = Object.fromEntries(ov.shares.map((s) => [`${s.hostname}:${s.kind}`, s]));
    expect(byHost["my-monorepo.localhost:tailscale"]).toMatchObject({ public: false, editable: true, url: "https://workstation.tail4c2a.ts.net" });
    expect(byHost["api.my-monorepo.localhost:funnel"]).toMatchObject({ public: true, editable: true, url: "https://workstation.tail4c2a.ts.net:8443" });
    expect(byHost["storybook.localhost:ngrok"]).toMatchObject({ editable: false });
    expect(byHost["storybook.localhost:ngrok"].reason).toContain("outside Portplane");
  });

  it("shares an app after a preview, with a confirmation when it's public", async () => {
    const api = createMockApi("tailnet");
    const pv = await settle(api.portlessSharePreview("local", WEB, "cloudflare", true));
    expect(pv.public).toBe(true);
    expect(pv.problem).toBeUndefined();
    expect(pv.files[0].after).toContain('"--cloudflare", "--tailscale"');
    expect(pv.steps).toEqual(["Write tasks.yaml", "Reload dekit", "Restart web", "Wait for the shared address"]);
    await expect(settle(api.portlessShare("local", WEB, "cloudflare", true, pv.digest!, false))).rejects.toThrow("confirmation");
    await expect(settle(api.portlessShare("local", WEB, "cloudflare", true, "stale", true))).rejects.toThrow("changed since the preview");
    const job = await finish(api, await settle(api.portlessShare("local", WEB, "cloudflare", true, pv.digest!, true)));
    expect(job.state).toBe("succeeded");
    expect(job.result).toMatchObject({ kind: "cloudflare", url: expect.stringContaining("trycloudflare.com") });
    const info = await settle(api.portlessShareInfo("local", WEB));
    expect(info.on).toEqual(["cloudflare", "tailscale"]);
    expect(info.shared.map((s) => s.kind)).toEqual(["cloudflare", "tailscale"]);
    const routes = await settle(api.portlessRoutes());
    expect(routes.find((r) => r.hostname === "my-monorepo.localhost")?.shared).toHaveLength(2);

    // Funnel replaces the tailnet share, and stopping needs no wait.
    const funnel = await settle(api.portlessSharePreview("local", WEB, "funnel", true));
    expect(funnel.replaces).toBe("tailscale");
    const stop = await settle(api.portlessSharePreview("local", API, "funnel", false));
    expect(stop.steps).not.toContain("Wait for the shared address");
    expect(stop.public).toBe(false);
  });

  it("asks for what's missing first, and saves the ngrok authtoken", async () => {
    const api = createMockApi();
    const pv = await settle(api.portlessSharePreview("local", WEB, "ngrok", true));
    expect(pv.problem).toContain("isn't ready");
    expect(pv.missing.map((r) => r.id)).toEqual(["ngrok-authtoken"]);
    await expect(settle(api.portlessNgrokAuthtoken("short"))).rejects.toThrow("doesn't look like");
    const ov = await settle(api.portlessNgrokAuthtoken("2abcDEFghiJKLmnoPQRstuVWX_0123456789"));
    expect(ov.providers.find((p) => p.kind === "ngrok")?.ready).toBe(true);
    expect((await settle(api.portlessSharePreview("local", WEB, "ngrok", true))).problem).toBeUndefined();
  });

  it("explains apps it can't share", async () => {
    const api = createMockApi();
    expect((await settle(api.portlessShareInfo("local", `${ROOT}#blog/studio`))).reason).toContain("JavaScript");
    expect((await settle(api.portlessShareInfo("local", `${ROOT}#my-monorepo/install`))).editable).toBe(false);
    await expect(settle(api.portlessShareInfo("box", WEB))).rejects.toThrow("other machines");
  });
});

describe("mock compose", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("lists projects with their services and routes", async () => {
    const ov = await settle(createMockApi("compose").portlessCompose());
    expect(ov.docker).toBe(true);
    expect(ov.projects.map((p) => `${p.name}:${p.state}`)).toEqual(["analytics:stopped", "legacy:down", "shop:running"]);
    const shop = ov.projects[2];
    expect(shop.routes.map((r) => r.hostname)).toEqual(["backend.shop.localhost", "8080.backend.shop.localhost", "9229.backend.shop.localhost", "web.shop.localhost"]);
    expect(shop.routes[0]).toMatchObject({ service: "api", listening: true });
    expect((await settle(createMockApi().portlessCompose())).projects).toEqual([]);
    expect((await settle(createMockApi("bare").portlessCompose())).docker).toBe(false);
  });

  it("starts and stops a project as a job", async () => {
    const api = createMockApi("compose");
    const plan = await settle(api.portlessComposePreview({ op: "down", project: "shop" }));
    expect(plan.terminal).toBe(`cd ${ROOT}/shop && /home/dev/.npm-global/bin/portless compose -p shop -f ${ROOT}/shop/compose.yaml down`);
    expect((await finish(api, await settle(api.portlessComposeRun({ op: "down", project: "shop" })))).state).toBe("succeeded");
    let ov = await settle(api.portlessCompose());
    expect(ov.projects.find((p) => p.name === "shop")?.state).toBe("down");
    expect((await finish(api, await settle(api.portlessComposeRun({ op: "up", project: "shop" })))).state).toBe("succeeded");
    ov = await settle(api.portlessCompose());
    expect(ov.projects.find((p) => p.name === "shop")?.state).toBe("running");
    await expect(settle(api.portlessComposePreview({ op: "up", file: "compose.yaml" }))).rejects.toThrow("full path");
    const added = await finish(api, await settle(api.portlessComposeRun({ op: "up", file: `${ROOT}/notes/compose.yaml` })));
    expect(added.result).toMatchObject({ project: "notes" });
  });

  it("renames a service through its portless.name label", async () => {
    const api = createMockApi("compose");
    const info = await settle(api.portlessNameInfo("local", "", "web.shop.localhost"));
    expect(info).toMatchObject({ source: "compose", service: "web", name: "web", suffix: "shop.localhost", editable: true, running: true });
    expect((await settle(api.portlessNamePreview("local", "", "backend", "web.shop.localhost"))).problem).toContain("api service");
    const pv = await settle(api.portlessNamePreview("local", "", "store", "web.shop.localhost"));
    expect(pv.hostname).toBe("store.shop.localhost");
    expect(pv.files[0].after).toContain("portless.name: store");
    expect(pv.steps).toEqual(["Write compose.yaml", "Start shop again with the new name", "Remove the old address"]);
    expect((await finish(api, await settle(api.portlessRename("local", "", "store", pv.digest!, "web.shop.localhost")))).state).toBe("succeeded");
    const routes = await settle(api.portlessRoutes());
    expect(routes.some((r) => r.hostname === "store.shop.localhost" && r.kind === "compose")).toBe(true);
  });
});

describe("mock LAN", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("lists .local addresses and turns on through the proxy options", async () => {
    const api = createMockApi();
    const v = await settle(api.portlessLan());
    expect(v.enabled).toBe(false);
    expect(v.ready).toBe(true);
    expect(v.apps.map((a) => a.hostname)).toContain("my-monorepo.local");
    expect(v.apps.some((a) => a.hostname === "portplane.local")).toBe(false);
    const plan = await settle(api.portlessPlan("service-install", { ...v.options, lan: true, tlds: ["local"], lanIp: "192.168.1.20" }));
    expect(plan.steps[0].terminal).toContain("--lan --ip 192.168.1.20");
    await finish(api, await settle(api.portlessRun("service-install", { ...v.options, lan: true, tlds: ["local"], lanIp: "192.168.1.20" })));
    expect(await settle(api.portlessLan())).toMatchObject({ enabled: true, ip: "192.168.1.20" });
    const bare = await settle(createMockApi("bare").portlessLan());
    expect(bare.ready).toBe(false);
    expect(bare.requirements.find((r) => !r.ok)?.command).toBe("sudo dnf install avahi-tools");
  });
});
