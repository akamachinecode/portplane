import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDekitHttp } from "./dekit";
import { createHttp } from "./http";
import { createMockApi } from "./mock";

const ROOT = "/home/dev/code";

describe("the dekit mock", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function run<T>(p: Promise<T>): Promise<T> {
    await vi.advanceTimersByTimeAsync(5000);
    return p;
  }
  async function refused(p: Promise<unknown>, re: RegExp) {
    const check = expect(p).rejects.toThrow(re);
    await vi.advanceTimersByTimeAsync(5000);
    await check;
  }

  it("lists runners with the host runner and stale records", async () => {
    const api = createMockApi("default");
    const r = await run(api.dekitRunners());
    expect(r.available).toBe(true);
    expect(r.host.kind).toBe("host");
    expect(r.stale).toBe(1);
    expect(r.runners.find((x) => x.root === ROOT)?.state).toBe("running");
    expect(r.runners.some((x) => x.restartRequired)).toBe(true);
    const none = await run(createMockApi("readonly").dekitRunners());
    expect(none.available).toBe(false);
  });

  it("previews, writes, then reviews and applies the reload", async () => {
    const api = createMockApi("default");
    const cfg = await run(api.dekitConfig(ROOT));
    const task = cfg.tasks.find((t) => t.path === "my-monorepo/api")!;
    const file = cfg.files.find((f) => f.path === task.file)!;
    const req = { runner: ROOT, file: task.file, digests: { [file.path]: file.digest }, ops: [{ op: "set" as const, path: ["tasks", task.key], key: "label", value: "API" }], write: false };
    const preview = await run(api.dekitEdit(req));
    expect(preview.written).toBe(false);
    expect(preview.files[0].after).toContain("label: API\n");
    const saved = await run(api.dekitEdit({ ...req, write: true }));
    expect(saved.written).toBe(true);
    expect(saved.reload?.plan.changes.map((c) => c.path)).toContain("my-monorepo/api");
    await refused(api.dekitEdit({ ...req, write: true }), /changed on disk/);
    const applied = await run(api.dekitReload(ROOT, true));
    expect(applied.restarted).toContain("my-monorepo/api");
    expect((await run(api.dekitReloadPlan(ROOT))).reload?.plan.changes).toEqual([]);
  });

  it("refuses to rewrite !js values", async () => {
    const api = createMockApi("default");
    const cfg = await run(api.dekitConfig(ROOT));
    const docs = cfg.tasks.find((t) => t.path === "my-monorepo/docs")!;
    await refused(api.dekitEdit({ runner: ROOT, file: docs.file, ops: [{ op: "set", path: ["tasks", docs.key], key: "env", value: { A: "1" } }], write: false }), /can't be edited/);
  });

  it("spawns a dynamic task that Remove takes away", async () => {
    const api = createMockApi("default");
    await run(api.dekitSpawn(ROOT, { path: "tmp/migrate", cmd: ["pnpm", "run", "migrate"] }));
    const app = (await run(api.snapshot())).machines[0].apps.find((a) => a.task === "tmp/migrate")!;
    expect(app.dynamic).toBe(true);
    expect(app.state).toBe("on");
    await run(api.act({ machine: "local", runner: ROOT, task: "tmp/migrate" }, "rm"));
    expect((await run(api.snapshot())).machines[0].apps.some((a) => a.task === "tmp/migrate")).toBe(false);
    await refused(api.act({ machine: "local", runner: ROOT, task: "my-monorepo/docs" }, "rm"), /dekit.yaml/);
  });

  it("keeps a vetoed app stopped and says so in why", async () => {
    const api = createMockApi("default");
    await run(api.act({ machine: "local", runner: ROOT, task: "my-monorepo/api" }, "veto"));
    const why = await run(api.dekitWhy(ROOT, "my-monorepo/api"));
    expect(why.vetoed).toBe(true);
    expect(why.state).toBe("idle");
  });

  it("adds an app to Portplane's fragment with a URL alias for a fixed port", async () => {
    const api = createMockApi("default");
    const res = await run(api.dekitAddApp({ runner: ROOT, target: "portplane", write: true, app: { path: "blog/php", folder: `${ROOT}/blog`, cmd: ["php", "-S", "127.0.0.1:8000"], name: "blog", port: 8000 } }));
    expect(res.written).toBe(true);
    const after = res.files[0].after;
    expect(after).toContain("blog/php-url:");
    expect(after).toContain(`cmd: [portless, alias, blog, "8000", --force]`);
    expect(after).toContain("cwd: ../blog");
    const app = (await run(api.snapshot())).machines[0].apps.find((a) => a.task === "blog/php")!;
    expect(app.portplane).toBe(true);
  });

  it("serves dekit's own help", async () => {
    const help = await run(createMockApi("default").dekitHelp());
    expect(help.dekit).toBe("0.10.3");
    expect(help.fields.some((f) => f.key === "tasks.*.cmd")).toBe(true);
  });
});

describe("createDekitHttp", () => {
  it("calls the dekit routes", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const h = createHttp("tok", async (url, init = {}) => {
      calls.push({ url, init });
      return new Response(url.includes("validate") ? JSON.stringify({ problems: [] }) : "{}", { status: 200 });
    });
    const api = createDekitHttp(h);
    await api.dekitWhy(ROOT, "web");
    await api.dekitRunnerAction(ROOT, "up");
    await api.dekitReload(ROOT, true);
    expect(await api.dekitValidate("tasks: {}")).toEqual([]);
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      `GET /api/dekit/why?runner=%2Fhome%2Fdev%2Fcode&task=web`,
      "POST /api/dekit/runners/action",
      "POST /api/dekit/reload",
      "POST /api/dekit/config/validate",
    ]);
    expect(JSON.parse(calls[1].init.body as string)).toEqual({ root: ROOT, action: "up" });
    expect(JSON.parse(calls[2].init.body as string)).toEqual({ runner: ROOT, restart: true });
  });
});
