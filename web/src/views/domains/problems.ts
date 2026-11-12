import { PROXY_COMMAND } from "../onboarding/problems";
import type { Snapshot } from "../../api/types";
import { FIX_LABELS, groupFindings } from "../../lib/portless";
import { navigate, type DomainSection } from "../../lib/router";
import { registerProblemSource, type Problem, type ProblemFix } from "../../shell/health";
import type { PortlessAction } from "../../api/portless";
import { doctorResource, requestIntent, statusResource, valueOf } from "./store";

// The portless center's problems for the Health view (plan §6.4): the
// service pointing at a Node.js that is gone, and doctor's warnings and
// failures, each with the fix the Domains view offers. They show once the
// status or a doctor report has been loaded (the Domains view, the app
// detail's URL tab, or "Run diagnostics" in the palette).

const SECTION: Partial<Record<PortlessAction, DomainSection>> = {
  trust: "certificates",
  prune: "routes",
  "hosts-sync": "hosts",
};

/** A fix that opens the action's plan in the Domains view. */
export function planFix(action: PortlessAction, label = FIX_LABELS[action as keyof typeof FIX_LABELS] ?? "Fix"): ProblemFix {
  return {
    label,
    run: () => {
      requestIntent({ kind: "action", action });
      navigate({ view: "domains", section: SECTION[action] ?? "proxy" });
    },
  };
}

export function portlessProblems(snapshot: Snapshot): Problem[] {
  const local = snapshot.machines.find((m) => m.machine.local);
  if (!local?.tools.portless) return [];
  const where = { id: local.machine.id, name: local.machine.name };
  const out: Problem[] = [];

  const status = valueOf(statusResource.get());

  // Replaces the snapshot's own proxy-down problem (same id). With the
  // service installed, the fix starts the proxy here; without it, the guided
  // setup's proxy step installs it (F2: the same advice everywhere).
  if (!local.tools.proxyRunning) {
    const installed = status?.service?.installed === true;
    out.push({
      id: `proxy-down|${local.machine.id}`,
      severity: "warning",
      title: "The portless proxy isn't running",
      detail: installed
        ? "Apps keep their .localhost names, but the URLs won't load until the proxy runs."
        : "Apps keep their .localhost names, but the URLs won't load until the proxy runs. Installing it as a service asks for your password once and starts it with your computer.",
      code: installed ? undefined : PROXY_COMMAND,
      machine: where,
      fix: installed ? planFix("proxy-start", "Start the proxy") : { label: "Set up the proxy", run: () => navigate({ view: "onboarding", step: "proxy" }) },
      link: { label: "Proxy", route: { view: "domains", section: "proxy" } },
    });
  }

  const prog = status?.program;
  if (status?.service?.installed && prog && (prog.nodeMissing || prog.scriptMissing)) {
    out.push({
      id: `portless-service-program|${local.machine.id}`,
      severity: "error",
      title: "The proxy service starts a program that no longer exists",
      detail: "This happens after a Node.js or portless upgrade. The proxy won't start with the computer until the service is installed again.",
      code: prog.nodeMissing ? prog.node : prog.script,
      machine: where,
      fix: planFix("service-install", "Reinstall the service"),
    });
  }

  const doctor = valueOf(doctorResource.get());
  for (const g of groupFindings(doctor?.findings ?? [])) {
    if (g.status !== "fail" && g.status !== "warn") continue;
    if (g.check === "service" || (g.check === "proxy" && !local.tools.proxyRunning)) continue; // reported above
    const first = g.findings.find((f) => f.status === g.status) ?? g.findings[0];
    out.push({
      id: `portless-doctor|${local.machine.id}|${g.check}`,
      severity: g.status === "fail" ? "error" : "warning",
      title: first.message,
      detail: g.findings.length > 1 ? `${g.label}: ${g.findings.length} findings from portless doctor.` : first.hint,
      machine: where,
      fix: g.fixes[0] ? planFix(g.fixes[0]) : undefined,
      link: { label: "Doctor", route: { view: "domains", section: "doctor" } },
    });
  }
  return out;
}

registerProblemSource("portless", portlessProblems);
