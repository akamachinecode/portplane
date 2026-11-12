import { describe, expect, it } from "vitest";
import { ApiError, createHttpApi, eventsUrl, TOKEN_HEADER, UNREACHABLE } from "./client";
import { isAbort, isStale, isUnauthorized } from "./errors";

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  return { fn, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("createHttpApi", () => {
  it("sends the token and a JSON body", async () => {
    const f = fakeFetch(() => new Response(null, { status: 202 }));
    const api = createHttpApi("tok", f.fn);
    await api.act({ machine: "local", runner: "/r", task: "web" }, "start");
    expect(f.calls).toHaveLength(1);
    const { url, init } = f.calls[0];
    expect(url).toBe("/api/actions");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers[TOKEN_HEADER]).toBe("tok");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ target: { machine: "local", runner: "/r", task: "web" }, verb: "start" });
  });

  it("omits the token header when there is no token", async () => {
    const f = fakeFetch(() => json({ folders: [] }));
    await createHttpApi(null, f.fn).settings();
    expect((f.calls[0].init.headers as Record<string, string>)[TOKEN_HEADER]).toBeUndefined();
  });

  it("parses JSON responses", async () => {
    const f = fakeFetch(() => json({ lines: ["a"], command: "dekit screen web" }));
    const ex = await createHttpApi("t", f.fn).excerpt("local", "/home/dev/code", "my app/web");
    expect(ex.lines).toEqual(["a"]);
    expect(f.calls[0].url).toBe("/api/excerpt?machine=local&runner=%2Fhome%2Fdev%2Fcode&task=my+app%2Fweb");
  });

  it("surfaces the server's error message", async () => {
    const f = fakeFetch(() => json({ error: "task not found: web" }, 404));
    const err = await createHttpApi("t", f.fn)
      .act({ machine: "local", runner: "/r", task: "web" }, "stop")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe("task not found: web");
    expect((err as ApiError).status).toBe(404);
  });

  it("falls back to the body text or the status", async () => {
    const text = await createHttpApi("t", fakeFetch(() => new Response("bad gateway", { status: 502 })).fn)
      .snapshot()
      .catch((e: Error) => e.message);
    expect(text).toBe("bad gateway");
    const empty = await createHttpApi("t", fakeFetch(() => new Response(null, { status: 500 })).fn)
      .snapshot()
      .catch((e: Error) => e.message);
    expect(empty).toBe("Request failed (500)");
  });

  it("reports a dead server as unreachable", async () => {
    const api = createHttpApi("t", async () => {
      throw new TypeError("Failed to fetch");
    });
    const err = await api.info().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe(UNREACHABLE);
    expect((err as ApiError).status).toBe(0);
  });

  it("recognises a refused token", async () => {
    const err = await createHttpApi("old", fakeFetch(() => json({ error: "bad token" }, 403)).fn)
      .snapshot()
      .catch((e: unknown) => e);
    expect(isUnauthorized(err)).toBe(true);
    expect(isUnauthorized(new ApiError("x", 500))).toBe(false);
  });

  it("maps the folder picker's answers", async () => {
    const pick = (res: Response) => createHttpApi("t", fakeFetch(() => res).fn).pickFolder();
    expect(await pick(json({ path: "/home/dev/code" }))).toEqual({ kind: "picked", path: "/home/dev/code" });
    expect(await pick(new Response(null, { status: 204 }))).toEqual({ kind: "cancelled" });
    expect(await pick(json({ error: "no picker" }, 501))).toEqual({ kind: "unsupported" });
    await expect(pick(json({ error: "boom" }, 500))).rejects.toThrow("boom");
  });

  it("sends the folder picker request as JSON, which the server requires", async () => {
    const f = fakeFetch(() => new Response(null, { status: 204 }));
    await createHttpApi("t", f.fn).pickFolder();
    const headers = f.calls[0].init.headers as Record<string, string>;
    expect(f.calls[0].init.method).toBe("POST");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(f.calls[0].init.body).toBe("{}");
  });

  it("puts settings", async () => {
    const f = fakeFetch((_u, init) => json(JSON.parse(init.body as string)));
    const s = await createHttpApi("t", f.fn).saveSettings({ folders: ["/a", "/b"] });
    expect(f.calls[0].init.method).toBe("PUT");
    expect(s).toEqual({ folders: ["/a", "/b"] });
  });
});

describe("setup, machines and autostart endpoints", () => {
  const echo = () => fakeFetch((url, init) => json({ url, method: init.method, body: init.body ? JSON.parse(init.body as string) : null }));

  it("sends each request where the server expects it", async () => {
    const f = echo();
    const api = createHttpApi("t", f.fn);
    await api.setupCheck();
    await api.setupScan("/home/dev/code", { skip: { "shop/web": true } });
    await api.setupApply("/home/dev/code", "abc", { names: { "shop/web": "store" } });
    await api.machines();
    await api.machineCandidates();
    await api.addMachine({ host: "box", name: "", folders: ["/srv/code"] });
    await api.updateMachine("my box", { folders: [] });
    await api.autostart();
    await api.setAutostart(true);
    expect(f.calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      "GET /api/setup/check",
      "POST /api/setup/scan",
      "POST /api/setup/apply",
      "GET /api/machines",
      "GET /api/machines/candidates",
      "POST /api/machines",
      "PUT /api/machines/my%20box",
      "GET /api/autostart",
      "PUT /api/autostart",
    ]);
    const body = (i: number) => JSON.parse(f.calls[i].init.body as string);
    expect(body(1)).toEqual({ folder: "/home/dev/code", overrides: { skip: { "shop/web": true } } });
    expect(body(2)).toEqual({ folder: "/home/dev/code", digest: "abc", overrides: { names: { "shop/web": "store" } } });
    expect(body(5)).toEqual({ host: "box", name: "", folders: ["/srv/code"] });
    expect(body(8)).toEqual({ enabled: true });
    for (const c of f.calls) expect((c.init.headers as Record<string, string>)[TOKEN_HEADER]).toBe("t");
  });

  it("removes a machine and opens a port", async () => {
    const f = fakeFetch((url) => (url.startsWith("/api/machines/") ? new Response(null, { status: 204 }) : json({ url: "http://127.0.0.1:41234" })));
    const api = createHttpApi("t", f.fn);
    await api.removeMachine("box");
    expect(await api.openPort("box", 5432)).toBe("http://127.0.0.1:41234");
    expect(f.calls[0].init.method).toBe("DELETE");
    expect(f.calls[0].url).toBe("/api/machines/box");
    expect(JSON.parse(f.calls[1].init.body as string)).toEqual({ machine: "box", port: 5432 });
  });

  it("reports a stale setup write as a 409", async () => {
    const err = await createHttpApi("t", fakeFetch(() => json({ error: "the folder changed" }, 409)).fn)
      .setupApply("/x", "d", {})
      .catch((e: unknown) => e);
    expect(isStale(err)).toBe(true);
    expect(isStale(new ApiError("x", 400))).toBe(false);
  });

  it("passes an abort through instead of calling the server unreachable", async () => {
    const ctl = new AbortController();
    const api = createHttpApi("t", (_u, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });
    const p = api.addMachine({ host: "box", name: "", folders: [] }, ctl.signal).catch((e: unknown) => e);
    ctl.abort();
    const err = await p;
    expect(isAbort(err)).toBe(true);
    expect(err).not.toBeInstanceOf(ApiError);
  });
});

describe("eventsUrl", () => {
  it("passes the token as a query parameter", () => {
    expect(eventsUrl("a+b/c")).toBe("/api/events?token=a%2Bb%2Fc");
    expect(eventsUrl(null)).toBe("/api/events");
  });
});

describe("jobs and preferences endpoints", () => {
  it("sends each request where the server expects it", async () => {
    const f = fakeFetch((url) => (url.endsWith("/cancel") ? new Response(null, { status: 202 }) : json(url.includes("/api/jobs/") ? { id: "a b" } : [])));
    const api = createHttpApi("t", f.fn);
    await api.jobs();
    await api.job("a b");
    await api.cancelJob("a b");
    await api.preferences();
    expect(f.calls.map((c) => `${c.init.method} ${c.url}`)).toEqual(["GET /api/jobs", "GET /api/jobs/a%20b", "POST /api/jobs/a%20b/cancel", "GET /api/preferences"]);
    expect(f.calls[2].init.body).toBe("{}");
  });

  it("puts the whole preferences object and surfaces a refusal", async () => {
    const prefs = {
      theme: "dark" as const,
      density: "compact" as const,
      favorites: [],
      notifications: { failures: true, recoveries: false, jobs: true },
      updateCheck: "manual" as const,
      onboarding: { completed: true, skipped: false, done: [] },
    };
    const ok = fakeFetch((_u, init) => json(JSON.parse(init.body as string)));
    expect(await createHttpApi("t", ok.fn).savePreferences(prefs)).toEqual(prefs);
    expect(ok.calls[0].init.method).toBe("PUT");
    expect(ok.calls[0].url).toBe("/api/preferences");
    const bad = createHttpApi("t", fakeFetch(() => json({ error: "theme must be one of system, light, dark" }, 400)).fn);
    await expect(bad.savePreferences(prefs)).rejects.toThrow("theme must be one of system, light, dark");
  });
});
