import { describe, expect, it } from "vitest";
import { createHttpApi } from "./client";
import type { Job } from "./jobs";
import { createMockApi, mockPreferences, mockSnapshot } from "./mock";
import { evaluateMachine, machineFor } from "./mockTools";
import type { Requirement } from "./types";

const byId = (reqs: Requirement[]) => Object.fromEntries(reqs.map((r) => [r.id, r]));

function finished(api: ReturnType<typeof createMockApi>, id: string): Promise<Job> {
  return new Promise((resolve) => {
    const stop = api.subscribe({
      onStatus: () => {},
      onSnapshot: () => {},
      onJob: (j) => {
        if (j.id === id && j.state !== "running") {
          stop();
          resolve(j);
        }
      },
    });
  });
}

describe("mock machine", () => {
  it("starts a fresh computer with nothing installed", () => {
    const c = evaluateMachine(machineFor("fresh"));
    const r = byId(c.requirements);
    expect(c.ready).toBe(false);
    expect([r.dekit.status, r.node.status, r.portless.status, r.proxy.status, r.ca.status]).toEqual(["missing", "missing", "missing", "missing", "info"]);
    expect(r.dekit.install?.password).toBe(false);
    expect(r.path.fix).toBe("path-profile");
  });

  it("knows Node 20 is too old and offers mise", () => {
    const r = byId(evaluateMachine(machineFor("node20")).requirements);
    expect(r.node.status).toBe("outdated");
    expect(r.node.install?.alternatives?.[0].commands).toEqual(["mise use -g node@24"]);
  });

  it("first-run scenarios start on the guided setup", () => {
    for (const s of ["fresh", "node20", "nopassword", "nofolders"] as const) {
      expect(mockPreferences(s).onboarding.completed).toBe(false);
      expect(mockSnapshot(s).machines[0].folders).toEqual([]);
    }
    expect(mockPreferences("default").onboarding.completed).toBe(true);
  });
});

describe("mock tools", () => {
  it("installs dekit, Node and portless, and the snapshot follows", async () => {
    const api = createMockApi("fresh");
    let job = await api.installTool("dekit");
    expect(job.title).toBe("Install dekit");
    expect((await finished(api, job.id)).state).toBe("succeeded");
    expect((await api.snapshot()).machines[0].tools.dekit).toBe("0.10.3");

    // portless before Node fails, saying why.
    job = await api.installTool("portless");
    const failed = await finished(api, job.id);
    expect(failed.state).toBe("failed");
    expect(failed.error).toContain("Node.js 24");

    job = await api.installTool("node");
    expect((await finished(api, job.id)).state).toBe("succeeded");
    job = await api.installTool("portless");
    expect((await finished(api, job.id)).state).toBe("succeeded");
    const check = await api.checkSome(["dekit", "node", "portless"]);
    expect(check.requirements.map((r) => r.status)).toEqual(["ok", "ok", "ok"]);
    expect(check.ready).toBe(true);
  }, 30_000);

  it("installs the proxy service through the password dialog", async () => {
    const api = createMockApi("nofolders");
    const preview = await api.proxyServicePreview({ port: 443, https: true, tlds: ["localhost"], wildcard: false, lan: false, unprivileged: false });
    expect(preview.argv.slice(1)).toEqual(["service", "install", "--port", "443", "--https"]);
    expect(preview.needsAdmin).toBe(true);
    await expect(api.proxyServicePreview({ port: 0, https: true, wildcard: false, lan: false, unprivileged: false })).rejects.toThrow("between 1 and 65535");
  });

  it("fails the service without a password dialog, and offers port 1355", async () => {
    const api = createMockApi("nopassword");
    expect((await api.proxyServicePreview({ port: 443, https: true, wildcard: false, lan: false, unprivileged: false })).admin).toBe("");
    const job = await api.installProxyService({ port: 443, https: true, wildcard: false, lan: false, unprivileged: false });
    const done = await finished(api, job.id);
    expect(done.state).toBe("failed");
    expect(done.error).toContain("sudo env HOME=/home/dev");

    const start = await api.startProxy();
    expect((await finished(api, start.id)).state).toBe("succeeded");
    const snap = await api.snapshot();
    expect(snap.machines[0].tools.proxyPort).toBe(1355);
    // The CA is not trusted by the system after the 1355 route; browsers can take it without a password.
    const report = await api.browserTrust();
    expect(report.caExists && !report.systemTrusted).toBe(true);
    const ff = report.browsers[0].profiles[0];
    expect(ff.status).toBe("missing");
    expect((await api.trustBrowser("firefox", ff.id)).status).toBe("trusted");
    await expect(api.trustBrowser("firefox", "nope")).rejects.toThrow("no such browser profile");
  }, 30_000);

  it("adds the PATH line once asked", async () => {
    const api = createMockApi("fresh");
    expect((await api.pathProfile()).onPath).toBe(false);
    expect((await api.addPathToProfile()).onPath).toBe(true);
  });
});

describe("tools over HTTP", () => {
  it("calls the guided setup's routes", async () => {
    const calls: Array<[string, string | undefined, unknown]> = [];
    const fetchImpl = async (url: string, init: RequestInit = {}) => {
      calls.push([url, init.method, init.body ? JSON.parse(String(init.body)) : undefined]);
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const api = createHttpApi("t", fetchImpl);
    await api.checkSome(["port", "ca"]);
    await api.installTool("node", "mise");
    await api.installTool("dekit");
    await api.proxyServicePreview({ port: 443, https: true, wildcard: false, lan: false, unprivileged: false });
    await api.startProxy();
    await api.trustBrowser("firefox", "firefox:abc");
    await api.trustSystem();
    await api.addPathToProfile();
    await api.folderSuggestions();
    expect(calls).toEqual([
      ["/api/setup/check?only=port%2Cca", "GET", undefined],
      ["/api/tools/install", "POST", { tool: "node", method: "mise" }],
      ["/api/tools/install", "POST", { tool: "dekit" }],
      ["/api/proxy/service/preview", "POST", { options: { port: 443, https: true, wildcard: false, lan: false, unprivileged: false } }],
      ["/api/proxy/start", "POST", {}],
      ["/api/trust/browser", "POST", { browser: "firefox", profile: "firefox:abc" }],
      ["/api/trust/system", "POST", {}],
      ["/api/path/profile", "POST", {}],
      ["/api/folders/suggestions", "GET", undefined],
    ]);
  });
});
