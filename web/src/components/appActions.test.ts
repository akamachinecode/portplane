import { describe, expect, it } from "vitest";
import type { App, MachineSnapshot } from "../api/types";
import { appActionList } from "./appActions";

const ms = { machine: { id: "local", name: "This computer", local: true, status: "online" }, tools: { dekit: "0.10.3", proxyRunning: true, proxyHttps: true } } as Pick<MachineSnapshot, "machine" | "tools">;
const app = (p: Partial<App>): App => ({ id: "/r#web", runner: "/r", task: "web", label: "web", kind: "service", project: "shop", state: "on", order: 0, ...p });
const applying = (a: App, m = ms) => appActionList(a, m).filter((x) => x.applies).map((x) => x.id);

describe("appActionList", () => {
  it("offers kill and force restart while it runs", () => {
    expect(applying(app({}))).toEqual(["force-restart", "kill", "veto"]);
    expect(applying(app({ state: "off" }))).toEqual(["veto"]);
  });
  it("removes only dynamic and Portplane tasks", () => {
    expect(applying(app({ dynamic: true }))).toContain("remove");
    expect(applying(app({ portplane: true, state: "off" }))).toEqual(["veto", "remove"]);
    const remove = appActionList(app({}), ms).find((a) => a.id === "remove")!;
    expect(remove.applies).toBe(false);
    expect(remove.reason).toMatch(/dekit.yaml/);
    expect(remove.undoable).toBe(true);
  });
  it("asks before the hard ones and says why the others don't apply", () => {
    const list = appActionList(app({ detail: "kept stopped", state: "off" }), ms);
    expect(list.find((a) => a.id === "kill")!.confirm?.danger).toBe(true);
    expect(list.find((a) => a.id === "veto")!.applies).toBe(false);
    expect(list.find((a) => a.id === "veto")!.reason).toMatch(/already kept stopped/);
  });
  it("offers nothing without dekit or a connection", () => {
    expect(applying(app({}), { ...ms, tools: { proxyRunning: false, proxyHttps: false } })).toEqual([]);
    const offline = { ...ms, machine: { ...ms.machine, local: false, status: "offline" as const } };
    expect(appActionList(app({}), offline)[0].reason).toMatch(/connected/);
  });
});
