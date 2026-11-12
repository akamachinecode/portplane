import { describe, expect, it } from "vitest";
import { createHttp } from "./http";
import { createMockApi } from "./mock";
import { createPolishHttp } from "./polish";

function fakeFetch(respond: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  return {
    calls,
    fn: async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return respond(url, init);
    },
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("createPolishHttp", () => {
  it("talks to the polish endpoints", async () => {
    const f = fakeFetch((url) => (url === "/api/updates" ? json(null) : url === "/api/updates/check" ? json({ checkedAt: "x", items: [] }) : new Response(null, { status: 204 })));
    const api = createPolishHttp(createHttp("t", f.fn));
    expect(await api.updates()).toBeNull();
    expect(await api.checkUpdates()).toEqual({ checkedAt: "x", items: [] });
    await api.testNotification();
    await api.setWindowTheme("dark");
    expect(f.calls.map((c) => `${c.init.method} ${c.url}`)).toEqual(["GET /api/updates", "POST /api/updates/check", "POST /api/notifications/test", "PUT /api/window/theme"]);
    expect(f.calls[3].init.body).toBe('{"theme":"dark"}');
  });

  it("returns null when the save dialog is cancelled, and the place otherwise", async () => {
    const cancelled = createPolishHttp(createHttp("t", fakeFetch(() => new Response(null, { status: 204 })).fn));
    expect(await cancelled.exportDiagnostics()).toBeNull();
    const saved = createPolishHttp(createHttp("t", fakeFetch(() => json({ path: "/home/dev/Downloads/r.zip", dialog: false, revealed: true })).fn));
    expect(await saved.exportDiagnostics()).toEqual({ path: "/home/dev/Downloads/r.zip", dialog: false, revealed: true });
    const failed = createPolishHttp(createHttp("t", fakeFetch(() => json({ error: "couldn't save the report: disk full" }, 500)).fn));
    await expect(failed.exportDiagnostics()).rejects.toThrow("disk full");
  });
});

describe("mock", () => {
  it("answers an update check with something new", async () => {
    const api = createMockApi("default");
    expect(await api.updates()).toBeNull();
    const r = await api.checkUpdates();
    expect(r.items.map((i) => `${i.id}:${i.update}`)).toEqual(["portplane:true", "dekit:false", "portless:true"]);
    expect(await api.updates()).toEqual(r);
  });
});
