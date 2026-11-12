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
    expect(parseRoute("#/setup/box/check")).toEqual({ view: "onboarding", machine: "box", step: "check" });
    expect(parseRoute("#/setup/box")).toEqual({ view: "onboarding", machine: "box" });
    expect(parseRoute("#/setup")).toEqual({ view: "apps" });
    expect(parseRoute("#/setup/local/check")).toEqual({ view: "apps" });
    expect(href({ view: "onboarding", machine: "local", step: "check" })).toBe("#/onboarding/check");
    expect(parseRoute("#/runners/box")).toEqual({ view: "runners", machine: "box" });
    expect(parseRoute("#/runners/box/x")).toEqual({ view: "apps" });
    expect(parseRoute("#/domains/certificates/box")).toEqual({ view: "domains", section: "certificates", machine: "box" });
    expect(parseRoute("#/domains/nope/box")).toEqual({ view: "apps" });
    expect(parseRoute("#/domains/proxy/box/x")).toEqual({ view: "apps" });
    expect(parseRoute("#/addresses")).toEqual({ view: "addresses", filter: "all" });
    expect(parseRoute("#/addresses/aliases/box")).toEqual({ view: "addresses", filter: "aliases", machine: "box" });
    expect(parseRoute("#/addresses/nope")).toEqual({ view: "apps" });
    expect(parseRoute("#/dekit/box")).toEqual({ view: "dekit", machine: "box" });
    expect(href({ view: "domains", section: "proxy", machine: "box" })).toBe("#/domains/proxy/box");
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

  it("decodes a project, with its runner when two share a name", () => {
    expect(parseRoute("#/project/local/shop")).toEqual({ view: "project", machine: "local", name: "shop" });
    const runner = encodeURIComponent("/home/dev/code");
    expect(parseRoute(`#/project/box/shop/${runner}`)).toEqual({ view: "project", machine: "box", name: "shop", runner: "/home/dev/code" });
    expect(href({ view: "project", machine: "box", name: "my shop", runner: "/r" })).toBe("#/project/box/my%20shop/%2Fr");
    expect(parseRoute("#/project/local")).toEqual({ view: "apps" });
  });

  it("accepts a missing hash, a missing slash and a trailing slash", () => {
    expect(parseRoute("")).toEqual({ view: "apps" });
    expect(parseRoute("#")).toEqual({ view: "apps" });
    expect(parseRoute("#/")).toEqual({ view: "apps" });
    expect(parseRoute("health")).toEqual({ view: "health" });
    expect(parseRoute("#/settings/folders/")).toEqual({ view: "settings", section: "folders" });
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

describe("the M5 layout's addresses", () => {
  it("open where those pages went (ADR-0028)", () => {
    expect(parseRoute("#/domains/routes")).toEqual({ view: "addresses", filter: "all" });
    expect(parseRoute("#/domains/aliases/box")).toEqual({ view: "addresses", filter: "aliases", machine: "box" });
    expect(parseRoute("#/domains/compose")).toEqual({ view: "addresses", filter: "compose" });
    expect(parseRoute("#/domains/doctor")).toEqual({ view: "health" });
    expect(parseRoute("#/settings/tools")).toEqual({ view: "dekit" });
    expect(parseRoute("#/settings/network")).toEqual({ view: "settings", section: "advanced" });
  });

  it("reads a project's tab after its runner", () => {
    expect(parseRoute("#/project/local/shop/config")).toEqual({ view: "project", machine: "local", name: "shop", tab: "config" });
    expect(parseRoute("#/project/local/shop/apps")).toEqual({ view: "project", machine: "local", name: "shop" });
    expect(parseRoute(`#/project/local/shop/${encodeURIComponent("/srv")}/config`)).toEqual({ view: "project", machine: "local", name: "shop", runner: "/srv", tab: "config" });
    expect(parseRoute(`#/project/local/shop/${encodeURIComponent("/srv")}/nope`)).toEqual({ view: "apps" });
  });
});

describe("href", () => {
  it("leaves out default tabs and sections", () => {
    expect(href(appRoute("local", APP_ID))).toBe(`#/apps/local/${encodeURIComponent(APP_ID)}`);
    expect(href(appRoute("local", APP_ID, "output"))).toBe(`#/apps/local/${encodeURIComponent(APP_ID)}/output`);
    expect(href({ view: "domains", section: "proxy" })).toBe("#/domains");
    expect(href({ view: "settings", section: "general" })).toBe("#/settings");
    expect(href({ view: "settings", section: "updates" })).toBe("#/settings/updates");
    expect(href({ view: "addresses", filter: "all" })).toBe("#/addresses");
    expect(href({ view: "addresses", filter: "all", machine: "box" })).toBe("#/addresses/all/box");
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
      { view: "domains", section: "lan" },
      { view: "addresses", filter: "all" },
      { view: "addresses", filter: "compose", machine: "box" },
      { view: "dekit" },
      { view: "project", machine: "local", name: "shop", tab: "config" },
      { view: "project", machine: "local", name: "shop", runner: "/srv", tab: "config" },
      { view: "runners" },
      { view: "machines" },
      { view: "health" },
      { view: "settings", section: "general" },
      { view: "settings", section: "advanced" },
      { view: "onboarding" },
      { view: "onboarding", step: "tools" },
      { view: "onboarding", machine: "box" },
      { view: "runners", machine: "box" },
      { view: "runners", machine: "local" },
      { view: "domains", section: "proxy", machine: "box" },
      { view: "domains", section: "certificates", machine: "my box" },
      { view: "onboarding", machine: "box", step: "check" },
    ];
    for (const r of routes) expect(parseRoute(href(r))).toEqual(r);
  });

  it("compares routes by their canonical hash", () => {
    expect(sameRoute(parseRoute("#/domains/proxy"), { view: "domains", section: "proxy" })).toBe(true);
    expect(sameRoute({ view: "health" }, { view: "runners" })).toBe(false);
  });
});
