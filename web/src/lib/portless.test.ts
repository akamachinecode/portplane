import { describe, expect, it } from "vitest";
import type { Finding, NameInfo, ProxyOptions, RouteView } from "../api/portless";
import {
  baseName,
  checkConfigText,
  cleanTlds,
  configText,
  describeOptions,
  doctorSummary,
  expiry,
  extraKeys,
  groupFindings,
  hostnameFor,
  hostsSectionVisible,
  isUserAlias,
  nameProblem,
  normalizeOptions,
  optionsProblems,
  previewHostname,
  proxyUrl,
  renameProblem,
  routeAge,
  sameOptions,
  sortRoutes,
  suggestName,
  tldProblem,
  tldWarning,
} from "./portless";

describe("nameProblem", () => {
  it("accepts what portless accepts", () => {
    for (const n of ["web", "api.shop", "a-b.c-d", "x1", "web.localhost", "a".repeat(63)]) expect(nameProblem(n)).toBeNull();
    expect(nameProblem("proxy.shop")).toBeNull();
  });
  it.each([
    ["", "Type a name."],
    ["Web", "Use lowercase letters."],
    ["-web", "Start the name with a letter or a digit."],
    ["web.", "End the name with a letter or a digit."],
    ["a..b", "Two dots in a row aren't allowed."],
    ["a_b", '"_" isn\'t allowed: use letters, digits, dashes and dots.'],
    ["a.-b", "Each part between dots must start and end with a letter or a digit."],
    ["a".repeat(64), `"${"a".repeat(64)}" is longer than 63 characters, the limit for one part of a name.`],
    ["proxy", '"proxy" is one of portless\'s own commands; pick another name.'],
    ["ab.".repeat(84) + "c", "The address would be longer than 253 characters."],
  ])("refuses %j", (name, problem) => {
    expect(nameProblem(name)).toBe(problem);
  });
  it("strips the domain it is given", () => {
    expect(nameProblem("web.test", "test")).toBeNull();
    expect(nameProblem(".test", "test")).toBe("Type a name.");
    expect(nameProblem("-x.test", "test")).toBe("Start the name with a letter or a digit.");
  });
});

describe("hostnames and URLs", () => {
  it("builds and splits hostnames", () => {
    expect(hostnameFor("Api.Shop", "test")).toBe("api.shop.test");
    expect(hostnameFor("web.test", "test")).toBe("web.test");
    expect(hostnameFor("  ")).toBe("");
    expect(baseName("api.shop.test", ["test"])).toBe("api.shop");
    expect(baseName("x.localhost")).toBe("x");
    expect(baseName("x.dev")).toBe("x.dev");
  });
  it("puts the worktree in front for portless run", () => {
    expect(previewHostname({ runMode: true, prefix: "feature", tld: "localhost" }, "Docs")).toBe("feature.docs.localhost");
    expect(previewHostname({ runMode: false, prefix: "feature", tld: "test" }, "docs")).toBe("docs.test");
    expect(previewHostname({ runMode: true, tld: "localhost" }, "")).toBe("");
  });
  it("leaves out the default port", () => {
    expect(proxyUrl("web.localhost", { port: 443, https: true })).toBe("https://web.localhost");
    expect(proxyUrl("web.localhost", { port: 1355, https: true })).toBe("https://web.localhost:1355");
    expect(proxyUrl("web.localhost", { port: 80, https: false })).toBe("http://web.localhost");
    expect(proxyUrl("web.localhost", { port: 0, https: true })).toBe("https://web.localhost");
  });
  it("checks a rename against the app's own name and the names in use", () => {
    const info = { name: "shop", inferred: false, tld: "localhost", runMode: false, taken: ["api.shop.localhost"] } as NameInfo;
    expect(renameProblem(info, "shop")).toBe("That's the name it has now.");
    expect(renameProblem(info, "Shop")).toBe("That's the name it has now.");
    expect(renameProblem(info, "api.shop")).toBe("api.shop.localhost is already used by another app or route.");
    expect(renameProblem(info, "run")).toContain("own commands");
    expect(renameProblem(info, "store")).toBeNull();
    expect(renameProblem({ ...info, inferred: true }, "shop")).toBeNull();
  });
});

describe("proxy options", () => {
  const base: ProxyOptions = { port: 443, https: true, tlds: ["localhost"], wildcard: false, lan: false, unprivileged: false };

  it("warns about risky domains like portless does", () => {
    expect(tldWarning("test")).toBeNull();
    expect(tldWarning("localhost")).toBeNull();
    expect(tldWarning(".dev")).toContain("Google");
    expect(tldWarning("local")).toContain("mDNS");
    expect(tldWarning("com")).toContain("public");
    expect(tldWarning("corp.app")).toContain("ends in .app");
  });
  it("checks domains and options", () => {
    expect(tldProblem("test")).toBeNull();
    expect(tldProblem("")).toBe("Type a domain, such as test.");
    expect(tldProblem("Test")).toBe("Use lowercase letters.");
    expect(tldProblem("dev.example.com")).toBeNull();
    expect(tldProblem("a..b")).toContain("Two dots");
    expect(tldProblem("a b")).toContain("letters, digits and dashes");
    expect(optionsProblems(base)).toEqual({});
    expect(optionsProblems({ ...base, port: 70000 }).port).toBeDefined();
    expect(optionsProblems({ ...base, tlds: ["localhost", "bad tld"] }).tlds).toContain(".bad tld");
    expect(optionsProblems({ ...base, certPath: "/c.pem" }).keyPath).toBeDefined();
    expect(optionsProblems({ ...base, keyPath: "/k.pem" }).certPath).toBeDefined();
    expect(optionsProblems({ ...base, https: false, certPath: "/c", keyPath: "/k" }).certPath).toBe("A custom certificate needs HTTPS.");
    expect(optionsProblems({ ...base, lan: true, lanIp: "192.168.1.300" }).lanIp).toBeDefined();
    expect(optionsProblems({ ...base, lan: true, lanIp: "192.168.1.30" })).toEqual({});
    expect(optionsProblems({ ...base, lan: true, tlds: ["bad tld"] })).toEqual({});
  });
  it("normalises and compares options", () => {
    expect(cleanTlds([".Test", "test", " localhost "])).toEqual(["test", "localhost"]);
    expect(cleanTlds([])).toEqual(["localhost"]);
    expect(normalizeOptions({ ...base, lan: true, lanIp: " 10.0.0.2 ", tlds: ["test"], certPath: " " })).toEqual({ port: 443, https: true, tlds: ["local"], wildcard: false, lan: true, lanIp: "10.0.0.2", unprivileged: false });
    expect(normalizeOptions({ ...base, lanIp: "10.0.0.2" }).lanIp).toBeUndefined();
    expect(sameOptions(base, { ...base, tlds: [".localhost"] })).toBe(true);
    expect(sameOptions(base, { ...base, wildcard: true })).toBe(false);
    expect(describeOptions({ ...base, tlds: ["localhost", "test"], wildcard: true })).toBe("port 443 with HTTPS, for .localhost, .test, with wildcard subdomains");
    expect(describeOptions({ ...base, lan: true })).toBe("port 443 with HTTPS, on your network as .local");
  });
});

describe("routes", () => {
  const now = Date.parse("2026-11-12T10:00:00Z");
  it("shows ages like portless list", () => {
    expect(routeAge(undefined, now)).toBeNull();
    expect(routeAge(now - 45_000, now)).toBe("45s");
    expect(routeAge(now - 12 * 60_000, now)).toBe("12m");
    expect(routeAge(now - 3 * 3600_000, now)).toBe("3h");
    expect(routeAge(now - 50 * 3600_000, now)).toBe("2d");
    expect(routeAge(now + 10_000, now)).toBe("0s");
    expect(routeAge(now + 120_000, now)).toBeNull();
  });
  it("sorts live routes first and tells user aliases apart", () => {
    const r = (hostname: string, alive: boolean, kind: RouteView["kind"] = "app", owner?: RouteView["owner"]): RouteView => ({ hostname, port: 1, pid: 1, alive, kind, shared: [], url: "", owner });
    expect(sortRoutes([r("b", false), r("c", true), r("a", true)]).map((x) => x.hostname)).toEqual(["a", "c", "b"]);
    expect(isUserAlias(r("db", true, "alias"))).toBe(true);
    expect(isUserAlias(r("portplane.localhost", true, "alias", { kind: "portplane", label: "Portplane" }))).toBe(false);
    expect(isUserAlias(r("shop.box.localhost", true, "remote"))).toBe(false);
  });
});

describe("alias names", () => {
  it("guesses a name from the process, not from a runtime", () => {
    expect(suggestName("postgres")).toBe("postgres");
    expect(suggestName("redis-server")).toBe("redis");
    expect(suggestName("node")).toBeUndefined();
    expect(suggestName("Python3")).toBeUndefined();
    expect(suggestName("my_app.exe")).toBe("my-app");
    expect(suggestName(undefined)).toBeUndefined();
  });
});

describe("doctor", () => {
  const f = (status: Finding["status"], check: string, fix?: Finding["fix"]): Finding => ({ status, check, fix, message: `${check} ${status}` });
  it("groups findings by check, worst first, each fix once", () => {
    const groups = groupFindings([f("ok", "node"), f("warn", "routes", "prune"), f("warn", "routes", "prune"), f("fail", "proxy"), f("info", "ca", "trust")]);
    expect(groups.map((g) => `${g.check}:${g.status}`)).toEqual(["proxy:fail", "routes:warn", "ca:info", "node:ok"]);
    expect(groups[1].fixes).toEqual(["prune"]);
    expect(groups[1].findings).toHaveLength(2);
    expect(groups[0].label).toBe("Proxy");
  });
  it("sums up", () => {
    expect(doctorSummary({ failures: 0, warnings: 0 })).toBe("Everything checks out.");
    expect(doctorSummary({ failures: 1, warnings: 2 })).toBe("1 problem, 2 warnings.");
    expect(doctorSummary({ failures: 0, warnings: 1 })).toBe("1 warning.");
  });
  it("shows the hosts file only when it matters", () => {
    expect(hostsSectionVisible(null, null)).toBe(false);
    expect(hostsSectionVisible({ hostsNeeded: true }, null)).toBe(true);
    expect(hostsSectionVisible({ hostsNeeded: false }, { findings: [f("ok", "dns")] })).toBe(false);
    expect(hostsSectionVisible({ hostsNeeded: false }, { findings: [f("warn", "dns", "hosts-sync")] })).toBe(true);
  });
});

describe("certificates", () => {
  const now = Date.parse("2026-11-12T10:00:00Z");
  it("tells how close the expiry is", () => {
    expect(expiry(undefined, now)).toBe("unknown");
    expect(expiry("0001-01-01T00:00:00Z", now)).toBe("unknown");
    expect(expiry("2026-11-01T00:00:00Z", now)).toBe("expired");
    expect(expiry("2026-11-20T00:00:00Z", now)).toBe("soon");
    expect(expiry("2036-11-20T00:00:00Z", now)).toBe("ok");
  });
});

describe("portless.json", () => {
  it("checks a config like portless", () => {
    const ok = checkConfigText('{"name":"web","script":"dev","appPort":5173,"proxy":true,"turbo":false,"apps":{"apps/api":{"name":"api","extra":1}},"other":1}');
    expect(ok.problems).toEqual([]);
    expect(ok.config).toEqual({ name: "web", script: "dev", appPort: 5173, proxy: true, turbo: false, apps: { "apps/api": { name: "api" } } });
    expect(ok.warnings).toHaveLength(2);
    expect(checkConfigText('{"name":"","appPort":70000,"proxy":"yes","apps":[]}').problems).toHaveLength(4);
    expect(checkConfigText('"web"').config).toEqual({ name: "web" });
    expect(checkConfigText('{"name":').problems[0]).toMatch(/^This isn't valid JSON/);
    expect(checkConfigText("[1]").problems).toHaveLength(1);
    expect(checkConfigText('{"name":"Web"}').problems).toEqual(['"name": Use lowercase letters.']);
  });
  it("writes the form in portless's key order and keeps keys it doesn't edit", () => {
    const text = configText({ apps: { "apps/web": { name: "web", appPort: 3000 }, " ": { name: "x" } }, turbo: true, proxy: false, script: " dev ", name: "shop" }, { $schema: "x", name: "ignored" });
    expect(text).toBe('{\n  "name": "shop",\n  "script": "dev",\n  "proxy": false,\n  "turbo": true,\n  "apps": {\n    "apps/web": {\n      "name": "web",\n      "appPort": 3000\n    }\n  },\n  "$schema": "x"\n}\n');
    expect(configText({})).toBe("{}\n");
    expect(extraKeys('{"name":"x","$schema":"s"}')).toEqual({ $schema: "s" });
    expect(extraKeys("not json")).toEqual({});
  });
});
