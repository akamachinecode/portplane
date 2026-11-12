import { describe, expect, it } from "vitest";
import { mockSnapshot } from "../api/mock";
import { chosenMachine, pickableMachines, rememberedMachine, rememberMachine, sshCommand } from "./machineScope";

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

describe("pickableMachines", () => {
  it("lists this computer first and marks machines that can't be reached", () => {
    expect(pickableMachines(mockSnapshot("default"))).toEqual([
      { id: "local", label: "This computer", online: true },
      { id: "box", label: "box", online: true },
      { id: "mini", label: "mac-mini (offline)", online: false },
    ]);
  });
  it("offers this computer alone before the first snapshot", () => {
    expect(pickableMachines(null)).toEqual([{ id: "local", label: "This computer", online: true }]);
  });
});

describe("remembered machine", () => {
  it("keeps one choice per view, and forgets this computer", () => {
    const s = memoryStorage();
    expect(rememberedMachine(s, "domains")).toBe("local");
    rememberMachine(s, "domains", "box");
    expect(rememberedMachine(s, "domains")).toBe("box");
    expect(rememberedMachine(s, "runners")).toBe("local");
    rememberMachine(s, "domains", "local");
    expect(s.length).toBe(0);
  });
  it("works without storage", () => {
    expect(rememberedMachine(undefined, "domains")).toBe("local");
    expect(() => rememberMachine(undefined, "domains", "box")).not.toThrow();
  });
});

describe("sshCommand", () => {
  it("passes the command as one argument, so quotes survive", () => {
    expect(sshCommand("box", "sudo portless trust")).toBe("ssh -t box 'sudo portless trust'");
    expect(sshCommand("dev@mac-mini.local", "sudo env 'PORTLESS_STATE_DIR=/home/dev/my state' /usr/bin/portless trust")).toBe(
      `ssh -t dev@mac-mini.local 'sudo env '\\''PORTLESS_STATE_DIR=/home/dev/my state'\\'' /usr/bin/portless trust'`,
    );
  });
  it("leaves a placeholder when the host is unknown yet", () => {
    expect(sshCommand(undefined, "sudo true")).toBe("ssh -t '<machine>' 'sudo true'");
  });
});

describe("chosenMachine", () => {
  const options = pickableMachines(mockSnapshot("default"));
  it("takes the URL's machine first, then the one picked last, then this computer", () => {
    expect(chosenMachine("box", "local", options, true)).toEqual({ machine: "box", urlMachine: "box" });
    expect(chosenMachine(undefined, "box", options, true)).toEqual({ machine: "box", urlMachine: undefined });
    expect(chosenMachine(undefined, "gone", options, true)).toEqual({ machine: "local", urlMachine: undefined });
  });
  it("keeps an offline machine from the URL, and drops one the snapshot doesn't know", () => {
    expect(chosenMachine("mini", "local", options, true).machine).toBe("mini");
    expect(chosenMachine("gone", "box", options, true)).toEqual({ machine: "box", urlMachine: undefined });
  });
  it("trusts the URL before the first snapshot", () => {
    expect(chosenMachine("box", "local", pickableMachines(null), false)).toEqual({ machine: "box", urlMachine: "box" });
  });
});
