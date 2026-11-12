import type { MachineSnapshot, Snapshot } from "../../api/types";
import { navigate } from "../../lib/router";
import { registerCommandSource } from "../../shell/commands";
import { registerProblemSource, type Problem } from "../../shell/health";
import { resumeStep, type StepId } from "./steps";

// The guided setup's entries in the health list and the palette. A missing
// tool is fixed from the step that installs it (F3), on this computer or,
// through its own setup, on a machine over SSH (ADR-0026). These replace
// the snapshot source's problems with the same ids.

/** The command the proxy advice names, the same everywhere (F2). */
export const PROXY_COMMAND = "sudo portless service install";

const toStep = (step: StepId, machine?: string) => () => navigate({ view: "onboarding", step, machine });

export function setupProblems(ms: MachineSnapshot): Problem[] {
  const { machine, tools } = ms;
  if (!machine.local && machine.status !== "online") return [];
  const where = { id: machine.id, name: machine.name };
  const remote = machine.local ? undefined : machine.id;
  const how = remote ? `Portplane can install it on ${machine.name}, into your home folder there, without a password.` : "Portplane can install it for you, without a password.";
  const out: Problem[] = [];
  if (!tools.dekit) {
    out.push({
      id: `no-dekit|${machine.id}`,
      severity: "warning",
      title: remote ? `dekit isn't installed on ${machine.name}` : "dekit isn't installed",
      detail: `Portplane uses dekit to start, stop and supervise dev servers. Until it's installed, only the open ports show. ${how}`,
      machine: where,
      fix: { label: "Install dekit", run: toStep("install", remote) },
    });
  }
  if (!tools.portless) {
    out.push({
      id: `no-portless|${machine.id}`,
      severity: "info",
      title: remote ? `portless isn't installed on ${machine.name}` : "portless isn't installed",
      detail: `portless gives each dev server a stable https://name.localhost URL. Without it, apps show their port only. ${how}`,
      machine: where,
      fix: { label: "Install portless", run: toStep("install", remote) },
    });
  }
  // A stopped proxy is reported by the portless center's source
  // (views/domains/problems.ts), which knows whether the service exists.
  return out;
}

registerProblemSource("onboarding", (s: Snapshot) => s.machines.flatMap(setupProblems));

registerCommandSource("onboarding", (ctx) => {
  const p = ctx.preferences.status === "ok" ? ctx.preferences.value.onboarding : null;
  return [
    {
      id: "onboarding.open",
      title: p && !p.completed ? "Continue the guided setup" : "Run the guided setup again",
      group: "Settings",
      icon: "wand",
      keywords: ["onboarding", "install", "setup", "dekit", "portless", "proxy"],
      run: () => navigate({ view: "onboarding", step: p ? resumeStep(p) : "welcome" }),
    },
  ];
});
