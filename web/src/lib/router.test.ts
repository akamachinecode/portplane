import { describe, expect, it } from "vitest";
import { appRoute, href, parseRoute, sameRoute, type Route } from "./router";

const APP_ID = "/home/dev/code#my-monorepo/web";

describe("parseRoute", () => {
  it("parses every view", () => {
    expect(parseRoute("#/apps")).toEqual({ view: "apps" });
    expect(parseRoute("#/projects")).toEqual({ view: "projects" });
    expect(parseRoute("#/runners")).toEqual({ view: "runners" });
    expect(parseRoute("#/machines")).toEqual({ view: "machines" });
    expect(parseRoute("#/health")).toEqual({ view: "health" });
    expect(parseRoute("#/onboarding")).toEqual({ view: "onboarding" });
    expect(parseRoute("#/onboarding/folders")).toEqual({ view: "onboarding", step: "folders" });
  });

  it("gives domains and settings their default section", () => {
    expect(parseRoute("#/domains")).toEqual({ view: "domains", section: "proxy" });
    expect(parseRoute("#/domains/certificates")).toEqual({ view: "domains", section: "certificates" });
    expect(parseRoute("#/settings")).toEqual({ view: "settings", section: "general" });
    expect(parseRoute("#/settings/folders")).toEqual({ view: "settings", section: "folders" });
  });

  it("decodes an app's detail, summary by default", () => {
    const encoded = encodeURIComponent(APP_ID);
    expect(parseRoute(`#/apps/local/${encoded}`)).toEqual(appRoute("local", APP_ID));
    expect(parseRoute(`#/apps/box/${encoded}/config`)).toEqual({ view: "apps", detail: { machine: "box", appId: APP_ID, tab: "config" } });
  });

  it("decodes a project's runner", () => {
    expect(parseRoute(`#/projects/local/${encodeURIComponent("/home/dev/code")}`)).toEqual({
      view: "projects",
      runner: { machine: "local", root: "/home/dev/code" },
    });
  });

  it("accepts a missing hash, a missing slash and a trailing slash", () => {
    expect(parseRoute("")).toEqual({ view: "apps" });
    expect(parseRoute("#")).toEqual({ view: "apps" });
    expect(parseRoute("#/")).toEqual({ view: "apps" });
    expect(parseRoute("health")).toEqual({ view: "health" });
    expect(parseRoute("#/settings/tools/")).toEqual({ view: "settings", section: "tools" });
  });

  it("sends anything unknown to the apps", () => {
    for (const hash of [
      "#/nope",
      "#/domains/nope",
      "#/settings/nope",
      "#/settings/tools/extra",
      "#/apps/local",
      `#/apps/local/${encodeURIComponent(APP_ID)}/logs`,
      `#/apps/local/${encodeURIComponent(APP_ID)}/summary/extra`,
      "#/projects/local",
      "#/health/extra",
      "#/apps/%E0%A4%A",
    ]) {
      expect(parseRoute(hash), hash).toEqual({ view: "apps" });
    }
  });
});

describe("href", () => {
  it("leaves out default tabs and sections", () => {
    expect(href(appRoute("local", APP_ID))).toBe(`#/apps/local/${encodeURIComponent(APP_ID)}`);
    expect(href(appRoute("local", APP_ID, "output"))).toBe(`#/apps/local/${encodeURIComponent(APP_ID)}/output`);
    expect(href({ view: "domains", section: "proxy" })).toBe("#/domains");
    expect(href({ view: "settings", section: "general" })).toBe("#/settings");
    expect(href({ view: "settings", section: "network" })).toBe("#/settings/network");
  });

  it("escapes slashes and spaces in segments", () => {
    expect(href({ view: "projects", runner: { machine: "my box", root: "/srv/code" } })).toBe("#/projects/my%20box/%2Fsrv%2Fcode");
  });

  it("round-trips through parseRoute", () => {
    const routes: Route[] = [
      { view: "apps" },
      appRoute("local", APP_ID),
      appRoute("box", "/home/dev/src#shop/api", "url"),
      { view: "projects" },
      { view: "projects", runner: { machine: "local", root: "/home/dev/code" } },
      { view: "domains", section: "proxy" },
      { view: "domains", section: "doctor" },
      { view: "runners" },
      { view: "machines" },
      { view: "health" },
      { view: "settings", section: "general" },
      { view: "settings", section: "advanced" },
      { view: "onboarding" },
      { view: "onboarding", step: "tools" },
    ];
    for (const r of routes) expect(parseRoute(href(r))).toEqual(r);
  });

  it("compares routes by their canonical hash", () => {
    expect(sameRoute(parseRoute("#/domains/proxy"), { view: "domains", section: "proxy" })).toBe(true);
    expect(sameRoute({ view: "health" }, { view: "runners" })).toBe(false);
  });
});
