import { describe, expect, it } from "vitest";
import { mockSnapshot } from "../../api/mock";
import type { PortlessStatus } from "../../api/portless";
import { proxyAnswers } from "../../lib/portless";
import { portlessFingerprint } from "./store";

describe("portlessFingerprint", () => {
  const ms = mockSnapshot("default").machines[0];
  it("changes when the proxy or an app's address does, so the cached status and routes are read again", () => {
    const base = portlessFingerprint(ms);
    expect(portlessFingerprint(structuredClone(ms))).toBe(base);
    expect(portlessFingerprint({ ...ms, tools: { ...ms.tools, proxyRunning: !ms.tools.proxyRunning } })).not.toBe(base);
    const apps = ms.apps.map((a) => (a.task === "blog/site" ? { ...a, state: "on" as const, port: 4600 } : a));
    expect(portlessFingerprint({ ...ms, apps })).not.toBe(base);
  });
});

describe("proxyAnswers", () => {
  const status = (proxy: Partial<PortlessStatus["proxy"]>, service?: Partial<NonNullable<PortlessStatus["service"]>>) =>
    ({ proxy: { responding: false, port: 443, ...proxy }, service: service && { installed: true, responding: false, port: 443, ...service } }) as Pick<PortlessStatus, "proxy" | "service">;

  it("trusts the probe, then the startup service, before saying the proxy is stopped", () => {
    expect(proxyAnswers(status({ responding: true, port: 1355 }))).toEqual({ up: true, port: 1355 });
    expect(proxyAnswers(status({}, { responding: true, port: 443 }))).toEqual({ up: true, port: 443 });
    expect(proxyAnswers(status({}, { responding: false }))).toEqual({ up: false, port: 443 });
    expect(proxyAnswers(status({}))).toEqual({ up: false, port: 443 });
  });
});
