import type { IconName } from "../../components/Icon";
import type { MachineSnapshot, OnboardingProgress, Preferences, Requirement, RequirementId, SetupCheck } from "../../api/types";
import { needsOnboarding } from "../../lib/preferences";

// The guided setup's steps (plan §3.2) and the rules between them, kept
// apart from the components so they can be tested.

export const STEPS = [
  { id: "welcome", label: "Welcome", icon: "wand" },
  { id: "check", label: "Check your computer", icon: "pulse" },
  { id: "install", label: "Install tools", icon: "box" },
  { id: "proxy", label: "HTTPS and the proxy", icon: "shield" },
  { id: "browsers", label: "Browser trust", icon: "globe" },
  { id: "folders", label: "Your folders", icon: "folder" },
  { id: "apps", label: "Your apps", icon: "apps" },
  { id: "review", label: "Review and write", icon: "file" },
  { id: "start", label: "First start", icon: "play" },
  { id: "done", label: "Done", icon: "checkCircle" },
] as const satisfies ReadonlyArray<{ id: string; label: string; icon: IconName }>;

export type StepId = (typeof STEPS)[number]["id"];

export const STEP_IDS: readonly StepId[] = STEPS.map((s) => s.id);

/** A step from the URL or the saved progress; anything else is the welcome. */
export function parseStep(s: string | undefined): StepId {
  return STEP_IDS.includes(s as StepId) ? (s as StepId) : "welcome";
}

export function stepIndex(step: StepId): number {
  return STEP_IDS.indexOf(step);
}

export function stepLabel(step: StepId): string {
  return STEPS[stepIndex(step)].label;
}

/** How far along the user is, 0 to 1, for the progress bar. */
export function progressOf(step: StepId): number {
  return stepIndex(step) / (STEP_IDS.length - 1);
}

/** What decides whether a step is worth showing on the way forward. */
export interface Flow {
  /** dekit, Node 24 and portless are all there. */
  toolsReady: boolean;
  /** The proxy runs and the system trusts its CA. */
  proxyReady: boolean;
  /** Some browser profile does not trust the CA yet (null: not known). */
  browsersNeeded: boolean | null;
  /** ~/.local/bin is not on the terminal's PATH (the install step offers the line). */
  pathNeeded?: boolean;
}

/** The step after this one, skipping steps with nothing left to do. */
export function nextStep(step: StepId, flow: Flow): StepId {
  let i = stepIndex(step) + 1;
  while (i < STEP_IDS.length - 1) {
    const id = STEP_IDS[i];
    if (id === "install" && flow.toolsReady && !flow.pathNeeded) i++;
    else if (id === "browsers" && flow.browsersNeeded === false) i++;
    else break;
  }
  return STEP_IDS[Math.min(i, STEP_IDS.length - 1)];
}

/** The step before; Back never skips, so every step stays reachable. */
export function prevStep(step: StepId): StepId {
  return STEP_IDS[Math.max(0, stepIndex(step) - 1)];
}

/** Where "Fix everything" goes: the first step with work left. */
export function firstFixStep(flow: Flow): StepId {
  if (!flow.toolsReady || flow.pathNeeded) return "install";
  if (!flow.proxyReady) return "proxy";
  if (flow.browsersNeeded) return "browsers";
  return "folders";
}

/** The saved progress after reaching a step: earlier steps count as done. */
export function reached(p: OnboardingProgress, step: StepId): OnboardingProgress {
  const done = new Set(p.done);
  for (const id of STEP_IDS.slice(0, stepIndex(step))) done.add(id);
  return { ...p, step, done: STEP_IDS.filter((id) => done.has(id)) };
}

/** Whether a check needs the user: its status, with older binaries' answers. */
export function statusOf(r: Requirement): NonNullable<Requirement["status"]> {
  if (r.status) return r.status;
  if (r.ok) return "ok";
  return r.optional ? "warning" : "missing";
}

export const CHECK_ORDER: readonly RequirementId[] = ["dekit", "node", "portless", "git", "packages", "port", "proxy", "ca", "hosts", "lan", "path", "tray"];

/** Checks that need the user, for "N things to fix". Skipped and informational ones never count. */
export function problems(reqs: Requirement[]): Requirement[] {
  return reqs.filter((r) => {
    const s = statusOf(r);
    return s === "missing" || s === "outdated" || s === "warning";
  });
}

/** The flow's facts from a check (the parts that were answered). */
export function flowOf(check: Partial<Record<RequirementId, Requirement>>, browsersNeeded: boolean | null = null): Flow {
  const ok = (id: RequirementId) => {
    const r = check[id];
    return r ? statusOf(r) === "ok" || statusOf(r) === "info" : false;
  };
  const ca = check.ca;
  const caTrusted = !ca || !ca.problem || ca.fix === "trust-browsers";
  return {
    pathNeeded: check.path ? statusOf(check.path) === "warning" : false,
    toolsReady: ok("dekit") && ok("node") && ok("portless"),
    proxyReady: ok("proxy") && caTrusted,
    browsersNeeded:
      browsersNeeded ??
      (ca?.fix === "trust-browsers"
        ? true
        : ca?.browsers
          ? ca.browsers.browsers.some((b) => b.profiles.some((p) => p.status === "missing" || p.status === "outdated" || p.status === "unknown"))
          : null),
  };
}

/** Requirements by id, from a whole check. */
export function byId(check: SetupCheck): Partial<Record<RequirementId, Requirement>> {
  const out: Partial<Record<RequirementId, Requirement>> = {};
  for (const r of check.requirements) out[r.id] = r;
  return out;
}

/**
 * What the shell does on start (plan §3.1): the guided setup takes the
 * window on a first run (no folders, or dekit or portless missing);
 * someone who already has folders and both tools is marked done without
 * seeing it. Nothing once it was completed or skipped.
 */
export function firstRunAction(p: Preferences, local: MachineSnapshot | undefined): "show" | "complete" | null {
  if (!needsOnboarding(p) || !local) return null;
  const set = local.folders.length > 0 && !!local.tools.dekit && !!local.tools.portless;
  return set ? "complete" : "show";
}

/** The onboarding a "Run setup again" or a resume starts on. */
export function resumeStep(p: OnboardingProgress): StepId {
  return p.completed ? "welcome" : parseStep(p.step);
}
