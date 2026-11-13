import { describe, expect, it } from "vitest";
import { mockApps, mockSnapshot } from "../api/mock";
import type { App, Machine, Tools } from "../api/types";
import {
  appHref,
  bookmarkUrl,
  copyableUrl,
  indexApps,
  isAlive,
  isVisible,
  projectApps,
  runningUrls,
  serviceCounts,
  rowAddress,
  visibleApps,
  worktreeApps,
} from "./apps";

const local: Machine = { id: "local", name: "This computer", local: true, status: "online" };
const remote: Machine = { id: "box", name: "box", local: false, status: "online" };

function app(p: Partial<App>): App {
  return { id: "r#t", runner: "r", task: "t", label: "t", kind: "service", project: "p", state: "off", order: 0, ...p };
}

describe("isAlive", () => {
  it("treats on, starting and stopping as alive", () => {
    expect(["on", "starting", "stopping"].every((s) => isAlive(s as App["state"]))).toBe(true);
    expect(["off", "failed", "done", "unknown"].some((s) => isAlive(s as App["state"]))).toBe(false);
  });
});

describe("isVisible", () => {
  it("always shows services", () => {
    for (const state of ["on", "off", "done", "unknown", "failed"] as const) {
      expect(isVisible(app({ state }))).toBe(true);
    }
  });
  it("shows jobs only while they run or after they fail", () => {
    expect(isVisible(app({ kind: "job", state: "starting" }))).toBe(true);
    expect(isVisible(app({ kind: "job", state: "failed" }))).toBe(true);
    expect(isVisible(app({ kind: "job", state: "done" }))).toBe(false);
    expect(isVisible(app({ kind: "job", state: "off" }))).toBe(false);
    expect(isVisible(app({ kind: "job", state: "on" }))).toBe(false);
  });
  it("filters the mock: the finished install is hidden, the running one shows", () => {
    const shown = visibleApps(mockApps()).map((a) => a.task);
    expect(shown).not.toContain("my-monorepo/install");
    expect(shown).toContain("my-monorepo-checkout/install");
  });
});

describe("worktreeApps", () => {
  it("resolves IDs in order and skips unknown ones", () => {
    const a = app({ id: "a" });
    const b = app({ id: "b" });
    const byId = indexApps([a, b]);
    expect(worktreeApps({ name: "", running: 0, apps: ["b", "missing", "a"] }, byId)).toEqual([b, a]);
  });
  it("collects a project's apps across worktrees", () => {
    const ms = mockSnapshot().machines[0];
    const byId = indexApps(ms.apps);
    const mono = ms.projects.find((p) => p.name === "my-monorepo")!;
    expect(projectApps(mono, byId)).toHaveLength(8);
  });
});

describe("serviceCounts", () => {
  it("counts services that are up and leaves jobs out", () => {
    const apps = [
      app({ state: "on" }),
      app({ state: "starting" }),
      app({ state: "failed" }),
      app({ state: "off" }),
      app({ kind: "job", state: "starting" }),
      app({ kind: "job", state: "done" }),
    ];
    expect(serviceCounts(apps)).toEqual({ running: 1, total: 4 });
  });
});

describe("runningUrls", () => {
  it("returns the URLs of apps that are on", () => {
    const apps = [
      app({ state: "on", url: "https://web.localhost" }),
      app({ state: "on" }),
      app({ state: "starting", url: "https://api.localhost" }),
      app({ state: "off", hostname: "docs.localhost" }),
    ];
    expect(runningUrls(apps, local)).toEqual(["https://web.localhost"]);
  });
  it("opens a local app on its port when portless gives it no URL", () => {
    const a = app({ state: "on", port: 4514 });
    expect(appHref(a, local)).toBe("http://localhost:4514");
    expect(runningUrls([a], local)).toEqual(["http://localhost:4514"]);
    expect(appHref(a, remote)).toBeUndefined();
    expect(appHref(app({ state: "on" }), local)).toBeUndefined();
  });
  it("uses the hub's URL for apps on another machine", () => {
    const a = app({ state: "on", url: "https://web.localhost", remoteUrl: "http://127.0.0.1:5123/" });
    expect(runningUrls([a], remote)).toEqual(["http://127.0.0.1:5123/"]);
    expect(appHref(a, local)).toBe("https://web.localhost");
  });
});

describe("bookmarkUrl", () => {
  const https: Tools = { proxyRunning: true, proxyHttps: true, proxyPort: 443 };
  it("prefers the live URL", () => {
    expect(bookmarkUrl(app({ url: "https://web.localhost", hostname: "web.localhost" }), https)).toBe("https://web.localhost");
  });
  it("builds the URL from the hostname while the app is off", () => {
    expect(bookmarkUrl(app({ hostname: "web.localhost" }), https)).toBe("https://web.localhost");
    expect(bookmarkUrl(app({ hostname: "web.localhost" }), { proxyRunning: true, proxyHttps: false, proxyPort: 1355 })).toBe(
      "http://web.localhost:1355",
    );
    expect(bookmarkUrl(app({ hostname: "web.localhost" }), { proxyRunning: false, proxyHttps: false })).toBe("http://web.localhost");
  });
  it("has nothing to offer without a URL or a hostname", () => {
    expect(bookmarkUrl(app({}), https)).toBeUndefined();
  });
});

describe("remote addresses", () => {
  const https: Tools = { proxyRunning: true, proxyHttps: true, proxyPort: 443 };
  const on = app({ state: "on", url: "https://web.shop.localhost", hostname: "web.shop.localhost", remoteUrl: "https://web.shop.box.localhost" });
  const off = app({ state: "off", hostname: "web.shop.localhost" });

  it("shows where Open goes: the tunnelled URL on another machine", () => {
    expect(rowAddress(on, remote, appHref(on, remote))).toBe("web.shop.box.localhost");
    expect(rowAddress(on, local, appHref(on, local))).toBe("web.shop.localhost");
    expect(rowAddress(off, remote, undefined)).toBe("web.shop.localhost");
    const portOnly = app({ state: "on", port: 4514 });
    expect(rowAddress(portOnly, local, appHref(portOnly, local))).toBe("localhost:4514");
  });

  it("copies only URLs that work from here", () => {
    expect(copyableUrl(on, remote, https)).toBe("https://web.shop.box.localhost");
    expect(copyableUrl(off, remote, https)).toBeUndefined();
    expect(copyableUrl(off, local, https)).toBe("https://web.shop.localhost");
  });
});
