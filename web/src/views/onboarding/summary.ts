import type { App, MachineSnapshot, Proposal, Target } from "../../api/types";
import { diffStats, lineDiff } from "../../lib/diff";
import { shortenPath } from "../../lib/format";

// Plain-language summaries for the review and the first start (plan §3.2
// steps 7 and 8).

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/** The same text with a capital first letter. */
export function sentence(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "one task", "12 tasks". */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${n < WORDS.length ? WORDS[n] : n} ${n === 1 ? one : many}`;
}

function projectsOf(tasks: string[]): number {
  return new Set(tasks.map((t) => t.split("/")[0])).size;
}

/**
 * What writing a proposal does, in sentences: "6 tasks in 2 projects",
 * "one line added to ~/code/dekit.yaml".
 */
export function describeProposal(p: Proposal, home: string | undefined): string[] {
  const out: string[] = [];
  const { added, changed, removed } = p.change;
  if (added.length) out.push(sentence(`${count(added.length, "new task")} in ${count(projectsOf(added), "project")}`));
  if (changed.length) out.push(sentence(`${count(changed.length, "task")} updated`));
  if (removed.length) out.push(sentence(`${count(removed.length, "task")} removed`));
  for (const f of p.files) {
    if (!f.changed) continue;
    const path = shortenPath(f.path, home);
    if (f.created) {
      out.push(`${path} created`);
      continue;
    }
    const { added: plus, removed: minus } = diffStats(lineDiff(f.before, f.after));
    if (plus && !minus) out.push(sentence(`${count(plus, "line")} added to ${path}`));
    else out.push(`${path}: ${plus} lines added, ${minus} removed`);
  }
  return out;
}

/** Nothing to write in any folder. */
export function nothingToWrite(proposals: Proposal[]): boolean {
  return proposals.every((p) => p.files.every((f) => !f.changed));
}

// ---- first start ----

/** The services of the folders just set up, in config order. */
export function startCandidates(ms: MachineSnapshot | undefined, roots: string[]): App[] {
  if (!ms) return [];
  return ms.apps.filter((a) => a.kind === "service" && roots.includes(a.runner)).sort((a, b) => a.order - b.order);
}

/**
 * The apps to tick at first: one per project and checkout, its main app
 * (the one whose URL has the fewest labels, such as shop.localhost before
 * api.shop.localhost), or the first one.
 */
export function preselect(apps: App[]): Set<string> {
  const best = new Map<string, App>();
  const labels = (a: App) => (a.hostname ? a.hostname.split(".").length : 99);
  for (const a of apps) {
    const key = `${a.runner}\u0000${a.project}\u0000${a.worktree ?? ""}`;
    const cur = best.get(key);
    if (!cur || labels(a) < labels(cur)) best.set(key, a);
  }
  // Main checkouts only: a worktree's copy can wait.
  return new Set([...best.values()].filter((a) => !a.worktree || ![...best.values()].some((b) => b.project === a.project && !b.worktree)).map((a) => a.id));
}

/** One start per runner, naming its tasks. */
export function startTargets(machine: string, apps: App[], ids: Set<string>): Target[] {
  const byRunner = new Map<string, string[]>();
  for (const a of apps) {
    if (!ids.has(a.id)) continue;
    byRunner.set(a.runner, [...(byRunner.get(a.runner) ?? []), a.task]);
  }
  return [...byRunner.entries()].map(([runner, tasks]) => ({ machine, runner, tasks }));
}

export type StartPhase = "waiting" | "starting" | "on" | "failed";

/** Where an app stands after Start was pressed. */
export function startPhase(app: App | undefined): StartPhase {
  switch (app?.state) {
    case "on":
      return "on";
    case "failed":
      return "failed";
    case "starting":
    case "stopping":
      return "starting";
    default:
      return "waiting";
  }
}

/** The first started app with a working URL: the one to celebrate. */
export function firstWorking(apps: App[], ids: Set<string>): App | undefined {
  return apps.find((a) => ids.has(a.id) && a.state === "on" && !!a.url);
}
