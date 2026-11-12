import { agentIsOutdated, subscribeOutdated } from "../api/machine";
import type { Snapshot } from "../api/types";
import { invalidateProblems, registerProblemSource, type Problem } from "./health";

// Remote parity (ADR-0026): a machine whose agent answered that it is older
// than this Portplane can't run setup, dekit or portless from here until
// the agent is uploaded again. Health says so, with the button that does it.

export function agentProblems(snapshot: Snapshot): Problem[] {
  const out: Problem[] = [];
  for (const ms of snapshot.machines) {
    const m = ms.machine;
    if (m.local || m.status !== "online" || !agentIsOutdated(m.id)) continue;
    out.push({
      id: `agent-outdated|${m.id}`,
      severity: "warning",
      title: `Update the agent on ${m.name}`,
      detail: `${m.name} runs Portplane's agent${m.agent ? ` ${m.agent}` : ""}, older than this Portplane: its setup, dekit and portless can't be managed from here until it is updated. Updating uploads it again over SSH and reconnects.`,
      machine: { id: m.id, name: m.name },
      fix: {
        label: "Update the agent",
        pendingKey: `agent-update|${m.id}`,
        // Busy until the machine reconnects.
        run: (ctx) =>
          ctx.pending.run(
            `agent-update|${m.id}`,
            (s) => `${s.machines.find((x) => x.machine.id === m.id)?.machine.status}`,
            () => ctx.api.updateAgent(m.id),
          ),
      },
    });
  }
  return out;
}

registerProblemSource("agents", agentProblems);
subscribeOutdated(invalidateProblems);
