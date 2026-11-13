import type { MachineSnapshot, Requirement, RequirementId } from "../../api/types";
import { serviceCounts } from "../../lib/apps";
import { shortenPath } from "../../lib/format";
import { problems, statusOf, type Flow, type StepId } from "./steps";

// Setup as a timeline (ADR-0028): each step says what it found or did, in
// one line, read from the live check and snapshot, so a step done from a
// terminal shows as done too. Kept apart from the components to be tested.

export type StepStatus = "done" | "current" | "todo";

export interface TimelineFacts {
  checks: Partial<Record<RequirementId, Requirement>>;
  flow: Flow;
  folders: string[];
  /** The machine being set up. */
  ms: MachineSnapshot | null | undefined;
  /** Steps the saved progress counts as done. */
  done: ReadonlySet<string>;
  home?: string;
}

const version = (r: Requirement | undefined, name: string) => (r?.version ? `${name} ${r.version}` : null);

/** Whether a step's work is there, from the live facts (not only the saved progress). */
export function stepDone(step: StepId, f: TimelineFacts): boolean {
  const services = (f.ms?.apps ?? []).filter((a) => a.kind !== "job");
  switch (step) {
    case "welcome":
      // Read, or gone past: tools or folders that are already there count too.
      return f.done.size > 0 || f.flow.toolsReady || f.folders.length > 0;
    case "check":
      return Object.keys(f.checks).length > 0 && (f.done.has("check") || problems(Object.values(f.checks) as Requirement[]).length === 0);
    case "install":
      return f.flow.toolsReady && !f.flow.pathNeeded;
    case "proxy":
      return f.flow.proxyReady;
    case "browsers":
      return f.flow.browsersNeeded === false || (f.done.has("browsers") && f.flow.browsersNeeded !== true);
    case "folders":
      return f.folders.length > 0;
    case "apps":
    case "review":
      return services.length > 0;
    case "start":
      return services.some((a) => a.state === "on" || a.state === "starting");
    case "done":
      return f.done.has("done");
  }
}

/** One line about a step: what was found, or what is left. */
export function stepRecord(step: StepId, f: TimelineFacts): string {
  const c = f.checks;
  const reqs = Object.values(c) as Requirement[];
  const services = (f.ms?.apps ?? []).filter((a) => a.kind !== "job");
  const projects = new Set(services.map((a) => a.project)).size;
  switch (step) {
    case "welcome":
      return "dekit runs your apps, portless gives them addresses";
    case "check": {
      if (!reqs.length) return "Looks at the tools, the proxy, the certificate and your system.";
      const left = problems(reqs).length;
      const fine = reqs.filter((r) => statusOf(r) === "ok").length;
      return left ? `${left} ${left === 1 ? "thing" : "things"} to fix · ${fine} fine` : `All ${fine} checks pass`;
    }
    case "install": {
      const found = [version(c.dekit, "dekit"), version(c.node, "Node.js"), version(c.portless, "portless")].filter(Boolean);
      if (found.length === 3 && !f.flow.pathNeeded) return found.join(" · ");
      const missing = (["dekit", "node", "portless"] as const).filter((id) => !c[id] || statusOf(c[id]!) !== "ok").map((id) => (id === "node" ? "Node.js" : id));
      return missing.length ? `Missing: ${missing.join(", ")}` : f.flow.pathNeeded ? "Your terminal doesn't find the tools yet" : found.join(" · ");
    }
    case "proxy": {
      const t = f.ms?.tools;
      if (t?.proxyRunning) {
        const ca = c.ca && statusOf(c.ca) === "ok" ? " · certificate trusted" : c.ca ? " · certificate not trusted yet" : "";
        return `${t.proxyHttps ? "HTTPS" : "HTTP"} on port ${t.proxyPort ?? (t.proxyHttps ? 443 : 80)}${ca}`;
      }
      return "Not running yet: one password prompt, from your system";
    }
    case "browsers": {
      const b = c.ca?.browsers;
      if (!b) return f.flow.browsersNeeded === false ? "Your browsers trust the certificate" : "Firefox and some Linux browsers keep their own list";
      const names = [...new Set(b.browsers.map((x) => x.name))];
      if (!names.length) return "No browser with its own list of certificates";
      return f.flow.browsersNeeded ? `Not trusted yet in ${names.join(", ")}` : `Trusted in ${names.join(", ")}`;
    }
    case "folders":
      return f.folders.length ? f.folders.map((p) => shortenPath(p, f.home)).join(", ") : "Where your code lives";
    case "apps":
      return services.length ? `${services.length} ${services.length === 1 ? "app" : "apps"} in ${projects} ${projects === 1 ? "project" : "projects"}` : "Finds the dev servers in your folders";
    case "review":
      return services.length ? "dekit config written" : "Shows the config before it's written";
    case "start": {
      if (!f.ms) return "Start an app and open its address";
      const { running } = serviceCounts(f.ms.apps);
      const first = services.find((a) => a.state === "on");
      return running ? (running === 1 && first ? `${first.label} is running` : `${running} apps running`) : "Start an app and open its address";
    }
    case "done":
      return "Everything is ready";
  }
}

/** done, current or todo for each step, in order. */
export function stepStatuses(steps: readonly StepId[], current: StepId, f: TimelineFacts): Record<string, StepStatus> {
  const out: Record<string, StepStatus> = {};
  for (const s of steps) out[s] = s === current ? "current" : stepDone(s, f) || f.done.has(s) ? "done" : "todo";
  return out;
}
