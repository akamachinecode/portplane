import { afterEach, describe, expect, it } from "vitest";
import { createHttpApi } from "./client";
import { ApiError } from "./errors";
import { createHttp, machineHttp } from "./http";
import { agentIsOutdated, clearAgentOutdated, isAgentOutdated, machineScoper, markAgentOutdated, outdatedSnapshot } from "./machine";
import { createMockApi } from "./mock";

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function fakeFetch(respond: (url: string, init: RequestInit) => Response) {
  const calls: Call[] = [];
  const fn = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body as string) : undefined });
    return respond(url, init);
  };
  return { fn, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => {
  for (const id of ["box", "old"]) clearAgentOutdated(id);
});

describe("machineHttp", () => {
  it("sends /api/<path> to /api/m/<machine>/<path>, escaping the machine", async () => {
    const f = fakeFetch(() => json({}));
    const h = machineHttp(createHttp("tok", f.fn), "my box");
    await h.json("GET", "/api/portless/routes?x=1");
    await h.none("POST", "/api/dekit/reload", { runner: "/r" });
    await h.send("GET", "/elsewhere");
    expect(f.calls.map((c) => c.url)).toEqual(["/api/m/my%20box/portless/routes?x=1", "/api/m/my%20box/dekit/reload", "/elsewhere"]);
    expect(f.calls[1].body).toEqual({ runner: "/r" });
  });
});

describe("api.forMachine over HTTP", () => {
  it("sends setup, dekit, tools and portless to the machine, and the rest to Portplane", async () => {
    const f = fakeFetch((url) => {
      if (url === "/api/machines") return json([{ id: "box", name: "box", host: "dev@box", folders: ["/home/dev/src"] }]);
      if (url.endsWith("/agent/update")) return new Response(null, { status: 202 });
      return json([]);
    });
    const api = createHttpApi("tok", f.fn);
    const box = api.forMachine("box");
    expect(api.forMachine("box")).toBe(box);
    expect(api.forMachine("local")).toBe(api);

    await box.portlessRoutes();
    await box.dekitRunners();
    await box.setupScan("/home/dev/src", {});
    await box.checkSome(["proxy"]);
    await box.snapshot().catch(() => undefined);
    await box.jobs();
    expect(f.calls.map((c) => c.url)).toEqual([
      "/api/m/box/portless/routes",
      "/api/m/box/dekit/runners",
      "/api/m/box/setup/scan",
      "/api/m/box/setup/check?only=proxy",
      "/api/snapshot",
      "/api/jobs",
    ]);
  });

  it("keeps a remote machine's folders in its machine settings, with no folder picker", async () => {
    const f = fakeFetch((url, init) => {
      if (url === "/api/machines") return json([{ id: "box", name: "box", host: "box", folders: ["/srv/a"] }]);
      if (url === "/api/machines/box" && init.method === "PUT") return json({ id: "box", name: "box", host: "box", folders: JSON.parse(init.body as string).folders });
      return json({}, 404);
    });
    const box = createHttpApi(null, f.fn).forMachine("box");
    expect(await box.settings()).toEqual({ folders: ["/srv/a"] });
    expect(await box.saveSettings({ folders: ["/srv/a", "/srv/b"] })).toEqual({ folders: ["/srv/a", "/srv/b"] });
    expect(f.calls.at(-1)).toMatchObject({ url: "/api/machines/box", method: "PUT", body: { folders: ["/srv/a", "/srv/b"] } });
    expect(await box.pickFolder()).toEqual({ kind: "unsupported" });
    await expect(createHttpApi(null, f.fn).forMachine("gone").settings()).rejects.toThrow('unknown machine "gone"');
  });

  it("marks a machine whose agent is too old, and updating the agent clears it", async () => {
    const f = fakeFetch((url) => {
      if (url.startsWith("/api/m/old/portless")) return json({ error: "Update the agent on old-box: it is older than this Portplane and can't do this yet.", code: "agent-outdated" }, 501);
      return new Response(null, { status: 202 });
    });
    const api = createHttpApi(null, f.fn);
    const before = outdatedSnapshot();
    const err = await api
      .forMachine("old")
      .portlessStatus()
      .catch((e: unknown) => e);
    expect(isAgentOutdated(err)).toBe(true);
    expect((err as Error).message).toContain("Update the agent on old-box");
    expect(agentIsOutdated("old")).toBe(true);
    expect(outdatedSnapshot()).toBeGreaterThan(before);
    await api.updateAgent("old");
    expect(f.calls.at(-1)?.url).toBe("/api/m/old/agent/update");
    expect(agentIsOutdated("old")).toBe(false);
  });
});

describe("machineScoper", () => {
  it("leaves other failures alone", async () => {
    const base = createMockApi("default");
    const scoped = machineScoper(
      () => base,
      () => ({ portlessRoutes: () => Promise.reject(new ApiError("box is offline", 503)) }),
    )("box");
    await expect(scoped.portlessRoutes()).rejects.toThrow("box is offline");
    expect(agentIsOutdated("box")).toBe(false);
    markAgentOutdated("box");
    markAgentOutdated("box");
    expect(agentIsOutdated("box")).toBe(true);
  });
});

describe("the mock's remote machine", () => {
  it("has its own portless, dekit and setup, and its jobs say where they run", async () => {
    const api = createMockApi("default");
    const box = api.forMachine("box");
    const [here, there] = await Promise.all([api.portlessRoutes(), box.portlessRoutes()]);
    expect(there).not.toEqual(here);
    const runners = await box.dekitRunners();
    expect(runners.host.name).toBe("box");
    expect(runners.runners.map((r) => r.root)).toEqual(["/home/dev/src"]);
    const cfg = await box.dekitConfig("/home/dev/src");
    expect(cfg.files.map((x) => x.rel)).toEqual(["dekit.yaml", ".portplane/tasks.yaml"]);
    const check = await box.setupCheck();
    expect(check.requirements.length).toBeGreaterThan(0);
    const status = await box.portlessStatus();
    expect(status.method).toBe("");
    const job = await box.dekitRunnerAction("host", "up");
    expect(job.machine).toBe("box");
    expect(job.id.startsWith("box:")).toBe(true);
    await expect(box.dekitOpenFile("/home/dev/src", "/home/dev/src/dekit.yaml")).rejects.toThrow("no desktop");
  });

  it("refuses calls while the machine is offline", async () => {
    const api = createMockApi("default");
    await expect(api.forMachine("mini").portlessRoutes()).rejects.toMatchObject({ status: 503 });
    await expect(api.forMachine("nowhere").portlessRoutes()).rejects.toBeInstanceOf(ApiError);
  });

  it("answers like an older agent in ?mock=oldagent until it is updated", async () => {
    const api = createMockApi("oldagent");
    await expect(api.forMachine("box").dekitRunners()).rejects.toMatchObject({ status: 501 });
    expect(agentIsOutdated("box")).toBe(true);
    await api.updateAgent("box");
    expect(agentIsOutdated("box")).toBe(false);
  });
});
