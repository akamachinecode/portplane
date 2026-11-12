import type { LanView, Requirement, SharingOverview } from "../../api/sharing";
import type { Snapshot } from "../../api/types";
import { SHARE_NAMES } from "../../lib/sharing";
import { registerProblemSource, type Problem, type ProblemFix } from "../../shell/health";
import { planFix } from "./problems";
import { lanResource, sharingResource, statusResource, valueOf } from "./store";

// Sharing and LAN mode in the Health view (M5.6): apps shared through a
// way that stopped working (Tailscale signed out, say), apps open to the
// internet, and LAN mode on while .local names can't be published. They
// show once the sharing overview or the LAN view has been read (in the
// background at start, see usePrimePortless, or in Domains).

/** The fix Portplane runs itself for a requirement, when there is one. */
function requirementFix(r: Requirement): ProblemFix | undefined {
  if (r.action === "tailscale-operator") return planFix("tailscale-operator", "Let your user share");
  return undefined;
}

export function sharingProblems(snapshot: Snapshot, sharing: SharingOverview | undefined, lan: LanView | undefined, lanOn: boolean): Problem[] {
  const local = snapshot.machines.find((m) => m.machine.local);
  if (!local?.tools.portless) return [];
  const where = { id: local.machine.id, name: local.machine.name };
  const out: Problem[] = [];
  const toSharing = { label: "Sharing", route: { view: "domains", section: "sharing" } } as const;

  if (sharing) {
    const live = sharing.shares.filter((s) => s.alive);
    for (const p of sharing.providers) {
      const shared = live.filter((s) => s.kind === p.kind);
      const broken = p.requirements.find((r) => !r.ok);
      if (!shared.length || !broken) continue;
      const n = shared.length;
      out.push({
        id: `share-broken|${local.machine.id}|${p.kind}`,
        severity: "warning",
        title: `${n === 1 ? "An app" : `${n} apps`} shared with ${SHARE_NAMES[p.kind]} may not be reachable`,
        detail: [broken.problem, broken.fix].filter(Boolean).join(" ") || broken.label,
        code: broken.command,
        machine: where,
        fix: requirementFix(broken),
        link: toSharing,
      });
    }
    const open = live.filter((s) => s.public);
    if (open.length) {
      const hosts = [...new Set(open.map((s) => s.hostname))];
      out.push({
        id: `share-public|${local.machine.id}`,
        severity: "info",
        title: hosts.length === 1 ? `${hosts[0]} is open to the internet` : `${hosts.length} apps are open to the internet`,
        detail: `Anyone with the address can open ${hosts.length === 1 ? "it" : "them"}: ${open.map((s) => `${s.hostname} (${SHARE_NAMES[s.kind]})`).join(", ")}. Stop sharing what you don't need any more.`,
        machine: where,
        link: toSharing,
      });
    }
  }

  if (lanOn && lan) {
    const broken = lan.requirements.find((r) => !r.ok);
    if (broken) {
      out.push({
        id: `lan-broken|${local.machine.id}`,
        severity: "warning",
        title: "LAN mode is on, but phones can't find your apps",
        detail: [broken.problem, broken.fix].filter(Boolean).join(" ") || broken.label,
        code: broken.command,
        machine: where,
        link: { label: "LAN mode", route: { view: "domains", section: "lan" } },
      });
    }
  }
  return out;
}

registerProblemSource("portless-sharing", (snapshot) =>
  sharingProblems(snapshot, valueOf(sharingResource.get()), valueOf(lanResource.get()), valueOf(statusResource.get())?.proxy.lan === true),
);
