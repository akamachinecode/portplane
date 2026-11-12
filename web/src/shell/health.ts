import type { MachineSnapshot, Snapshot } from "../api/types";
import { actOnApp, appKey, runnerKey, startRunner } from "../components/appActions";
import { isVisible } from "../lib/apps";
import { createRegistry } from "../lib/registry";
import { appRoute, navigate, type Route } from "../lib/router";
import type { CommandContext } from "./commands";

// The Health view's single list of problems (plan §6.4). The snapshot gives
// the ones it knows (tools, proxy, runners, failed apps, machines); other
// files add theirs with registerProblemSource.

export type Severity = "error" | "warning" | "info";

export interface ProblemFix {
  /** A verb: "Start runner", "Open setup". */
  label: string;
  run(ctx: CommandContext): unknown;
  /** The pending key of the action, so the button spins while it runs. */
  pendingKey?: string;
}

export interface Problem {
  /** Stable across snapshots, e.g. "runner-down|local|/home/dev/code". */
  id: string;
  severity: Severity;
  title: string;
  detail?: string;
  /** A path, a command or an error message, shown in monospace. */
  code?: string;
  machine?: { id: string; name: string };
  fix?: ProblemFix;
  /** Where to read more, e.g. a failed app's detail. */
  link?: { label: string; route: Route };
}

export type ProblemSource = (snapshot: Snapshot) => Problem[];

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/** Setup explains how to install each tool; without a folder to set up, Folders comes first. */
function setupFix(ms: MachineSnapshot, label: string): ProblemFix | undefined {
  if (!ms.machine.local) return undefined;
  const folder = ms.folders[0];
  return {
    label,
    run: (ctx) => (folder ? ctx.openSetup(folder) : navigate({ view: "settings", section: "folders" })),
  };
}

function machineProblems(ms: MachineSnapshot): Problem[] {
  const { machine, tools } = ms;
  const where = { id: machine.id, name: machine.name };
  const out: Problem[] = [];

  if (machine.local && machine.error) {
    out.push({ id: `machine-error|${machine.id}`, severity: "error", title: "Problem with this computer", code: machine.error, machine: where });
  }
  if (!machine.local && machine.status === "offline") {
    out.push({
      id: `machine-offline|${machine.id}`,
      severity: "error",
      title: `Can't reach ${machine.name}`,
      detail: "Portplane keeps trying in the background.",
      code: machine.error,
      machine: where,
      fix: { label: "Edit machine", run: (ctx) => ctx.openEditMachine(machine.id) },
    });
  } else if (!machine.local && machine.status === "connecting" && machine.error) {
    out.push({ id: `machine-reconnecting|${machine.id}`, severity: "warning", title: `Reconnecting to ${machine.name}`, code: machine.error, machine: where });
  }
  // A remote machine's tools, runners and apps are only known while it's online.
  if (!machine.local && machine.status !== "online") return out;

  if (!tools.dekit) {
    out.push({
      id: `no-dekit|${machine.id}`,
      severity: "warning",
      title: "dekit isn't installed",
      detail: "Portplane uses dekit to start, stop and supervise dev servers. Until it's installed, only the open ports show.",
      machine: where,
      fix: setupFix(ms, "See how to install"),
    });
  }
  if (!tools.portless) {
    out.push({
      id: `no-portless|${machine.id}`,
      severity: "info",
      title: "portless isn't installed",
      detail: "portless gives each dev server a stable https://name.localhost URL. Without it, apps show their port only.",
      machine: where,
      fix: setupFix(ms, "See how to install"),
    });
  } else if (!tools.proxyRunning) {
    out.push({
      id: `proxy-down|${machine.id}`,
      severity: "warning",
      title: "The portless proxy isn't running",
      detail: "Apps keep their .localhost names, but the URLs won't load until the proxy runs.",
      code: "portless proxy start",
      machine: where,
      fix: setupFix(ms, "Open setup"),
    });
  }

  if (tools.dekit) {
    for (const r of ms.runners) {
      if (!r.up) {
        out.push({
          id: `runner-down|${machine.id}|${r.root}`,
          severity: "warning",
          title: `dekit isn't running for ${r.name}`,
          detail: "Its apps can't start until the runner is up.",
          code: r.root,
          machine: where,
          fix: { label: "Start runner", run: (ctx) => startRunner(ctx, machine.id, r.root), pendingKey: runnerKey(machine.id, r.root) },
        });
      } else if (r.error) {
        out.push({ id: `runner-error|${machine.id}|${r.root}`, severity: "warning", title: `Problem reading ${r.name}`, code: r.error, machine: where });
      }
    }
  }

  for (const app of ms.apps) {
    if (app.state !== "failed" || !isVisible(app)) continue;
    const place = [app.project, app.worktree].filter(Boolean).join(" · ");
    out.push({
      id: `app-failed|${machine.id}|${app.id}`,
      severity: "error",
      title: `${app.label} failed`,
      detail: [place, app.detail].filter(Boolean).join(": "),
      machine: where,
      fix: { label: "Start again", run: (ctx) => actOnApp(ctx, machine.id, app, "start"), pendingKey: appKey(machine.id, app) + "start" },
      link: { label: "Details", route: appRoute(machine.id, app.id) },
    });
  }
  return out;
}

/** Problems the snapshot shows, most severe first, in machine order within a severity. */
export function snapshotProblems(snapshot: Snapshot): Problem[] {
  return sortProblems(snapshot.machines.flatMap(machineProblems));
}

export function sortProblems(problems: Problem[]): Problem[] {
  return problems
    .map((p, i) => ({ p, i }))
    .sort((a, b) => SEVERITY_ORDER[a.p.severity] - SEVERITY_ORDER[b.p.severity] || a.i - b.i)
    .map((x) => x.p);
}

const registry = createRegistry<ProblemSource>();
registry.register("snapshot", snapshotProblems);

/**
 * Adds a source of problems (e.g. portless doctor's findings). A source that
 * keeps state of its own calls invalidateProblems() when it changes.
 */
export function registerProblemSource(id: string, source: ProblemSource): () => void {
  return registry.register(id, source);
}

export const invalidateProblems = registry.invalidate;
export const useProblemSourcesVersion = registry.useVersion;

/** Every source's problems, de-duplicated by id, most severe first. */
export function collectProblems(snapshot: Snapshot): Problem[] {
  const byId = new Map<string, Problem>();
  for (const source of registry.values()) {
    try {
      for (const p of source(snapshot)) byId.set(p.id, p);
    } catch (err) {
      console.error("problem source failed", err);
    }
  }
  return sortProblems([...byId.values()]);
}

/** What the sidebar badge counts: errors and warnings. */
export function problemBadge(problems: Problem[]): { count: number; tone: "error" | "warning" | null } {
  let count = 0;
  let error = false;
  for (const p of problems) {
    if (p.severity === "info") continue;
    count++;
    if (p.severity === "error") error = true;
  }
  return { count, tone: count === 0 ? null : error ? "error" : "warning" };
}
