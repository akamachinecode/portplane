import { describe, expect, it } from "vitest";
import type { App, Port } from "../api/types";
import { appAddress, dekitCommand, displayHost, formatDuration, inferHome, portLabel, shellQuote, shortenPath, sortOtherPorts, stateLabel } from "./format";

describe("displayHost", () => {
  it("drops the scheme and a trailing slash", () => {
    expect(displayHost("https://web.my-monorepo.localhost")).toBe("web.my-monorepo.localhost");
    expect(displayHost("http://localhost:3000/")).toBe("localhost:3000");
    expect(displayHost("https://web.localhost/admin/")).toBe("web.localhost/admin");
  });
});

describe("appAddress", () => {
  const base = { id: "a", runner: "r", task: "t", label: "t", kind: "service", project: "p", order: 0 } as const;
  it("prefers the live URL, then the hostname", () => {
    expect(appAddress({ ...base, state: "on", url: "https://web.localhost", hostname: "x.localhost" } as App)).toBe("web.localhost");
    expect(appAddress({ ...base, state: "off", hostname: "web.localhost" } as App)).toBe("web.localhost");
    expect(appAddress({ ...base, state: "off" } as App)).toBeUndefined();
  });
});

describe("labels", () => {
  it("names every state", () => {
    expect(stateLabel("on")).toBe("Running");
    expect(stateLabel("failed")).toBe("Failed");
    expect(stateLabel("done")).toBe("Done");
  });
  it("formats ports", () => {
    expect(portLabel(4514)).toBe(":4514");
  });
});

describe("dekitCommand", () => {
  it("builds the command, quoting only when needed", () => {
    expect(dekitCommand({ runner: "/home/dev/code", task: "my-monorepo/web" })).toBe("dekit -C /home/dev/code start my-monorepo/web");
    expect(dekitCommand({ runner: "/Users/dev/My Projects", task: "web" })).toBe("dekit -C '/Users/dev/My Projects' start web");
  });
  it("escapes single quotes", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote("")).toBe("''");
  });
});

describe("inferHome and shortenPath", () => {
  it("finds the home folder on each OS", () => {
    expect(inferHome(["/home/dev/code"])).toBe("/home/dev");
    expect(inferHome(["/var/home/dev/code"])).toBe("/var/home/dev");
    expect(inferHome(["/Users/dev/Projects"])).toBe("/Users/dev");
    expect(inferHome(["C:\\Users\\dev\\code"])).toBe("C:\\Users\\dev");
    expect(inferHome([undefined, "/srv/apps", "/home/dev"])).toBe("/home/dev");
  });
  it("gives up when nothing looks like a home folder", () => {
    expect(inferHome(["/srv/apps", "/opt/x", undefined])).toBeUndefined();
  });
  it("shortens only paths inside home", () => {
    expect(shortenPath("/home/dev/code/web", "/home/dev")).toBe("~/code/web");
    expect(shortenPath("/home/dev", "/home/dev")).toBe("~");
    expect(shortenPath("/home/developer/x", "/home/dev")).toBe("/home/developer/x");
    expect(shortenPath("/srv/x", undefined)).toBe("/srv/x");
    expect(shortenPath("C:\\Users\\dev\\code", "C:\\Users\\dev")).toBe("~\\code");
  });
});

describe("sortOtherPorts", () => {
  it("puts ports inside the watched folders first, then sorts by number", () => {
    const p = (port: number, inFolder: boolean): Port => ({ port, address: "127.0.0.1", inFolder });
    const sorted = sortOtherPorts([p(8080, false), p(5173, true), p(22, false), p(3000, true)]);
    expect(sorted.map((x) => x.port)).toEqual([3000, 5173, 22, 8080]);
  });
});

describe("formatDuration", () => {
  it("reads like a stopwatch", () => {
    expect(formatDuration(-5)).toBe("0s");
    expect(formatDuration(42_400)).toBe("42s");
    expect(formatDuration(185_000)).toBe("3m 05s");
    expect(formatDuration(3_720_000)).toBe("1h 02m");
  });
});
