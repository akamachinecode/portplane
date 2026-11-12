import { afterEach, describe, expect, it } from "vitest";
import { clearAgentOutdated, markAgentOutdated } from "../api/machine";
import { mockSnapshot } from "../api/mock";
import { agentProblems } from "./agentProblems";
import { remoteSessions } from "./BackgroundData";

afterEach(() => clearAgentOutdated("box"));

describe("agentProblems", () => {
  it("asks to update the agent of a machine that answered it is too old", () => {
    const snap = mockSnapshot("default");
    expect(agentProblems(snap)).toEqual([]);
    markAgentOutdated("box");
    const [p] = agentProblems(snap);
    expect(p.id).toBe("agent-outdated|box");
    expect(p.title).toBe("Update the agent on box");
    expect(p.fix?.label).toBe("Update the agent");
    expect(p.machine).toEqual({ id: "box", name: "box" });
  });

  it("says nothing while the machine is offline", () => {
    const snap = mockSnapshot("default");
    markAgentOutdated("box");
    snap.machines[1].machine.status = "offline";
    expect(agentProblems(snap)).toEqual([]);
  });
});

describe("remoteSessions", () => {
  it("names each online remote machine's connection, so it is loaded once per connection", () => {
    const snap = mockSnapshot("default");
    const first = remoteSessions(snap);
    expect([...first.keys()]).toEqual(["box"]);
    snap.machines[1].machine.agent = "0.0.1";
    expect(remoteSessions(snap).get("box")).not.toBe(first.get("box"));
    expect(remoteSessions(null).size).toBe(0);
  });
});
