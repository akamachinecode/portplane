import { PROXY_COMMAND } from "../onboarding/problems";
import type { MachineSnapshot, Snapshot } from "../../api/types";
import { FIX_LABELS, groupFindings } from "../../lib/portless";
import { navigate, type DomainSection, type Route } from "../../lib/router";
import { registerProblemSource, type Problem, type ProblemFix } from "../../shell/health";
import type { PortlessAction } from "../../api/portless";
import { requestIntent, resourcesOf, valueOf } from "./store";
// Sharing and LAN mode register theirs from their own file.
import "./sharingProblems";

// The portless center's problems for the Health view (plan §6.4): the
// service pointing at a Node.js that is gone, and doctor's warnings and
// failures, each with the fix the Domains view offers. They show once the
// status or a doctor report has been loaded (the Domains view, the app
// detail's URL tab, "Run diagnostics" in the palette, or Health's own
// background load), for this computer and each machine over SSH (ADR-0026).

const SECTION: Partial<Record<PortlessAction, DomainSection>> = {
  trust: "certificates",
  "ca-fix-ownership": "certificates",
  "ca-regenerate": "certificates",
  "hosts-sync": "hosts",
  "tailscale-operator": "sharing",
};

/** Where an action's plan opens: Addresses for cleaning up, else its portless settings page (ADR-0028). */
export function actionRoute(action: PortlessAction, machine: string): Route {
  if (action === "prune" || action === "prune-force") return { view: "addresses", filter: "all", machine };
  return { view: "domains", section: SECTION[action] ?? "proxy", machine };
}

/** A fix that opens the action's plan in the Domains view of a machine. */
export function planFix(action: PortlessAction, label = FIX_LABELS[action as keyof typeof FIX_LABELS] ?? "Fix", machine = "local"): ProblemFix {
  return {
    label,
    run: () => {
      requestIntent({ kind: "action", action, machine });
      navigate(actionRoute(action, machine));
    },
  };
}

export function portlessProblems(snapshot: Snapshot): Problem[] {
  return snapshot.machines.flatMap(machinePortlessProblems);
}

function machinePortlessProblems(ms: MachineSnapshot): Problem[] {
  const local = ms;
  if (!local.tools.portless) return [];
  const remote = !local.machine.local;
  if (remote && local.machine.status !== "online") return [];
  const id = local.machine.id;
  const name = local.machine.name;
  const where = { id, name };
  const fix = (action: PortlessAction, label?: string) => planFix(action, label, id);
  const domains = (section: DomainSection) => ({ view: "domains" as const, section, machine: id });
  const res = resourcesOf(id);
  const out: Problem[] = [];

  const status = valueOf(res.status.get());

  // Replaces the snapshot's own proxy-down problem (same id). With the
  // service installed, the fix starts the proxy here; without it, the guided
  // setup's proxy step installs it (F2: the same advice everywhere).
  if (!local.tools.proxyRunning) {
    const installed = status?.service?.installed === true;
    out.push({
      id: `proxy-down|${id}`,
      severity: "warning",
      title: remote ? `The portless proxy isn't running on ${name}` : "The portless proxy isn't running",
      detail: remote
        ? `Its apps still open here through Portplane, but on ${name} itself their .localhost URLs won't load until the proxy runs. ${installed ? "" : "Installing it as a service there needs your password once, as a command to run over SSH."}`.trim()
        : installed
          ? "Apps keep their .localhost names, but the URLs won't load until the proxy runs."
          : "Apps keep their .localhost names, but the URLs won't load until the proxy runs. Installing it as a service asks for your password once and starts it with your computer.",
      code: installed || remote ? undefined : PROXY_COMMAND,
      machine: where,
      fix: installed
        ? fix("proxy-start", "Start the proxy")
        : { label: "Set up the proxy", run: () => navigate({ view: "onboarding", step: "proxy", machine: remote ? id : undefined }) },
      link: { label: "Proxy", route: domains("proxy") },
    });
  }

  const prog = status?.program;
  if (status?.service?.installed && prog && (prog.nodeMissing || prog.scriptMissing)) {
    out.push({
      id: `portless-service-program|${id}`,
      severity: "error",
      title: "The proxy service starts a program that no longer exists",
      detail: "This happens after a Node.js or portless upgrade. The proxy won't start with the computer until the service is installed again.",
      code: prog.nodeMissing ? prog.node : prog.script,
      machine: where,
      fix: fix("service-install", "Reinstall the service"),
    });
  }

  const ca = valueOf(res.certificates.get())?.ca;
  if (ca?.exists && !ca.trusted) {
    // A remote app opens here with this computer's certificate (ADR-0016):
    // only programs on that machine meet its own.
    out.push({
      id: `portless-ca-untrusted|${id}`,
      severity: remote ? "info" : "warning",
      title: remote ? `${name} doesn't trust its own local certificate` : "Browsers will warn about your .localhost addresses",
      detail: remote
        ? `Its apps open fine here, but programs on ${name} that call https://….localhost addresses will refuse them. Trusting it there needs your password once, as a command to run over SSH.`
        : "Your system doesn't trust portless's local certificate authority yet. Trusting it asks for your password once.",
      machine: where,
      fix: fix("trust", "Trust the certificate"),
      link: { label: "Certificates", route: domains("certificates") },
    });
  }
  if (ca?.systemCopyNotRoot) {
    out.push({
      id: `portless-ca-owner|${id}`,
      severity: "warning",
      title: "The trusted copy of the local certificate belongs to your user",
      detail: "Any program you run could replace it with another certificate, and your system would trust that one the next time it updates its trust store. Fixing it asks for your password once.",
      code: ca.systemCopy,
      machine: where,
      fix: fix("ca-fix-ownership", "Fix ownership"),
      link: { label: "Certificates", route: domains("certificates") },
    });
  }
  if (ca?.exists && ca.notAfter) {
    const days = Math.floor((Date.parse(ca.notAfter) - Date.now()) / 86_400_000);
    if (days < 30) {
      out.push({
        id: `portless-ca-expiry|${id}`,
        severity: days < 0 ? "error" : "warning",
        title: `${days < 0 ? "The local certificate has expired" : `The local certificate expires in ${days} ${days === 1 ? "day" : "days"}`}${remote ? ` on ${name}` : ""}`,
        detail: "Regenerate it, then trust the new one, so browsers keep accepting your .localhost addresses.",
        machine: where,
        fix: fix("ca-regenerate", "Regenerate"),
        link: { label: "Certificates", route: domains("certificates") },
      });
    }
  }

  const doctor = valueOf(res.doctor.get());
  for (const g of groupFindings(doctor?.findings ?? [])) {
    if (g.status !== "fail" && g.status !== "warn") continue;
    if (g.check === "service" || (g.check === "proxy" && !local.tools.proxyRunning)) continue; // reported above
    const first = g.findings.find((f) => f.status === g.status) ?? g.findings[0];
    out.push({
      id: `portless-doctor|${id}|${g.check}`,
      severity: g.status === "fail" ? "error" : "warning",
      title: first.message,
      detail: g.findings.length > 1 ? `${g.label}: ${g.findings.length} findings from portless doctor.` : first.hint,
      machine: where,
      fix: g.fixes[0] ? fix(g.fixes[0]) : undefined,
    });
  }
  return out;
}

registerProblemSource("portless", portlessProblems);
