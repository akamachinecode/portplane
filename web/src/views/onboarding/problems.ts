import type { MachineSnapshot, Snapshot } from "../../api/types";
import { navigate } from "../../lib/router";
import { registerCommandSource } from "../../shell/commands";
import { registerProblemSource, type Problem } from "../../shell/health";
import { resumeStep, type StepId } from "./steps";

// The guided setup's entries in the health list and the palette. On this
// computer, a missing tool or a stopped proxy is fixed from the step that
// does it (F3), and the proxy advice is the service install everywhere
// (F2). These replace the snapshot source's problems with the same ids.

/** The command the proxy advice names, the same everywhere (F2). */
export const PROXY_COMMAND = "sudo portless service install";

const toStep = (step: StepId) => () => navigate({ view: "onboarding", step });

export function setupProblems(ms: MachineSnapshot): Problem[] {
  const { machine, tools } = ms;
  if (!machine.local) return [];
  const where = { id: machine.id, name: machine.name };
  const out: Problem[] = [];
  if (!tools.dekit) {
    out.push({
      id: `no-dekit|${machine.id}`,
      severity: "warning",
      title: "dekit isn't installed",
      detail: "Portplane uses dekit to start, stop and supervise dev servers. Until it's installed, only the open ports show. Portplane can install it for you, without a password.",
      machine: where,
      fix: { label: "Install dekit", run: toStep("install") },
    });
  }
  if (!tools.portless) {
    out.push({
      id: `no-portless|${machine.id}`,
      severity: "info",
      title: "portless isn't installed",
      detail: "portless gives each dev server a stable https://name.localhost URL. Without it, apps show their port only. Portplane can install it for you, without a password.",
      machine: where,
      fix: { label: "Install portless", run: toStep("install") },
    });
  } else if (!tools.proxyRunning) {
    out.push({
      id: `proxy-down|${machine.id}`,
      severity: "warning",
      title: "The portless proxy isn't running",
      detail: "Apps keep their .localhost names, but the URLs won't load until the proxy runs. Installing it as a service asks for your password once and starts it with your computer.",
      code: PROXY_COMMAND,
      machine: where,
      fix: { label: "Set up the proxy", run: toStep("proxy") },
    });
  }
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
