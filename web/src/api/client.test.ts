import { describe, expect, it } from "vitest";
import { ApiError, createHttpApi, eventsUrl, TOKEN_HEADER, UNREACHABLE } from "./client";
import { isUnauthorized } from "./errors";

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

  it("puts settings", async () => {
    const f = fakeFetch((_u, init) => json(JSON.parse(init.body as string)));
    const s = await createHttpApi("t", f.fn).saveSettings({ folders: ["/a", "/b"] });
    expect(f.calls[0].init.method).toBe("PUT");
    expect(s).toEqual({ folders: ["/a", "/b"] });
  });
});

describe("eventsUrl", () => {
  it("passes the token as a query parameter", () => {
    expect(eventsUrl("a+b/c")).toBe("/api/events?token=a%2Bb%2Fc");
    expect(eventsUrl(null)).toBe("/api/events");
  });
});
