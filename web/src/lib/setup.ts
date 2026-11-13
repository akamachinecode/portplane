import type { ApplyResult, AppProposal, FileChange, Proposal, Requirement, SetupCheck, SetupOverrides } from "../api/types";

// Setup (M2): the user's edits to a proposal, and what can be written.
// The server owns the proposal; edits go back as overrides and every edit
// means a re-scan, because apply only accepts the digest of what was shown.

const LABEL_RE = /[^a-z0-9-]+/g;

/** One DNS label, like setup.Label in Go: "@acme/Web App" -> "web-app". Never empty. */
export function label(s: string): string {
  let out = s.toLowerCase();
  const slash = out.lastIndexOf("/");
  if (slash >= 0) out = out.slice(slash + 1); // @scope/name
  out = out.replace(LABEL_RE, "-").replace(/^-+|-+$/g, "");
  if (out.length > 63) out = out.slice(0, 63).replace(/^-+|-+$/g, "");
  return out || "app";
}

/** The portless name the server keeps for a typed one, like cleanName in Go. "" when nothing is left. */
export function cleanName(raw: string): string {
  let n = raw.trim().toLowerCase();
  if (n.endsWith(".localhost")) n = n.slice(0, -".localhost".length);
  return n
    .split(".")
    .filter((p) => p !== "")
    .map(label)
    .join(".");
}

export function urlForName(name: string): string {
  return `https://${name}.localhost`;
}

/** Why a typed name can't be used, or null. */
export function nameProblem(raw: string): string | null {
  if (raw.trim() === "") return "Type a name.";
  if (cleanName(raw) === "") return "Use letters, digits, dashes and dots.";
  return null;
}

/** What the user changed in the review, keyed by task path. */
export interface SetupEdits {
  names: Record<string, string>; // as typed
  skip: Record<string, boolean>;
}

export const NO_EDITS: SetupEdits = { names: {}, skip: {} };

/**
 * The overrides to send for some edits, in a canonical form: cleaned names
 * (so "Web " and "web" scan the same), only valid names, only skipped tasks,
 * sorted keys and no empty maps.
 */
export function overridesFor(edits: SetupEdits): SetupOverrides {
  const names: Record<string, string> = {};
  for (const task of Object.keys(edits.names).sort()) {
    const name = cleanName(edits.names[task]);
    if (name) names[task] = name;
  }
  const skip: Record<string, boolean> = {};
  for (const task of Object.keys(edits.skip).sort()) {
    if (edits.skip[task]) skip[task] = true;
  }
  const ov: SetupOverrides = {};
  if (Object.keys(names).length) ov.names = names;
  if (Object.keys(skip).length) ov.skip = skip;
  return ov;
}

/** A stable key for comparing overrides: equal keys scan to the same proposal. */
export function overridesKey(ov: SetupOverrides): string {
  const sorted = (m: Record<string, unknown> | undefined) =>
    Object.keys(m ?? {})
      .sort()
      .map((k) => [k, m![k]]);
  return JSON.stringify([sorted(ov.names), sorted(ov.skip).filter(([, v]) => v === true)]);
}

/** Typing waits a moment before re-scanning; a checkbox re-scans right away. */
export const TYPING_DELAY = 450;

export function rescanDelay(previous: SetupOverrides, next: SetupOverrides): number {
  const names = (ov: SetupOverrides) => overridesKey({ names: ov.names });
  return names(previous) === names(next) ? 0 : TYPING_DELAY;
}

/** The name shown for an app: what the user typed when it's valid, else the proposal's. */
export function effectiveName(app: AppProposal, edits: SetupEdits): string {
  const typed = edits.names[app.task];
  if (typed !== undefined) {
    const clean = cleanName(typed);
    if (clean) return clean;
  }
  return app.name;
}

/** Will this app be written, given the latest edits (which may be ahead of the proposal)? */
export function isIncluded(app: AppProposal, edits: SetupEdits): boolean {
  if (app.status === "manual") return false;
  return edits.skip[app.task] !== undefined ? !edits.skip[app.task] : !app.skipped;
}

/** Tasks whose URL another included app also wants. */
export function nameClashes(apps: AppProposal[], edits: SetupEdits): Set<string> {
  const byName = new Map<string, string[]>();
  for (const a of apps) {
    if (!isIncluded(a, edits)) continue;
    const n = effectiveName(a, edits);
    byName.set(n, [...(byName.get(n) ?? []), a.task]);
  }
  const out = new Set<string>();
  for (const tasks of byName.values()) if (tasks.length > 1) for (const t of tasks) out.add(t);
  return out;
}

/** Tasks with a typed name that can't be used. */
export function invalidNames(edits: SetupEdits): string[] {
  return Object.keys(edits.names)
    .filter((t) => nameProblem(edits.names[t]) !== null)
    .sort();
}

export interface ProposalWorktree {
  worktree: string; // "" for the main checkout
  apps: AppProposal[];
}

export interface ProposalGroup {
  project: string;
  worktrees: ProposalWorktree[];
}

/** Apps by project, then checkout: projects in scan order, the main checkout first. */
export function groupProposalApps(apps: AppProposal[]): ProposalGroup[] {
  const projects = new Map<string, Map<string, AppProposal[]>>();
  for (const a of apps) {
    let wts = projects.get(a.project);
    if (!wts) {
      wts = new Map();
      projects.set(a.project, wts);
    }
    const wt = a.worktree ?? "";
    wts.set(wt, [...(wts.get(wt) ?? []), a]);
  }
  return [...projects.entries()].map(([project, wts]) => ({
    project,
    worktrees: [...wts.entries()]
      .map(([worktree, list]) => ({ worktree, apps: list }))
      .sort((x, y) => Number(x.worktree !== "") - Number(y.worktree !== "")),
  }));
}

/**
 * Where an app sits in the list (ADR-0032): the decisions first (new,
 * changed), then what needs nothing (unchanged, left out, set up by hand).
 */
export type SetupBucket = "new" | "changed" | "unchanged" | "skipped" | "manual";

export const BUCKET_ORDER: readonly SetupBucket[] = ["new", "changed", "unchanged", "skipped", "manual"];

export function bucketOf(app: AppProposal): SetupBucket {
  return app.status;
}

/**
 * Each app's bucket, keeping the one it had when first shown: ticking or
 * renaming re-scans and changes its status, but never moves its row.
 */
export function assignBuckets(apps: AppProposal[], known: ReadonlyMap<string, SetupBucket>): Map<string, SetupBucket> {
  const out = new Map(known);
  for (const a of apps) if (!out.has(a.task)) out.set(a.task, bucketOf(a));
  return out;
}

export interface BucketGroup {
  bucket: SetupBucket;
  /** The bucket's apps by project, then checkout. */
  groups: ProposalGroup[];
  apps: AppProposal[];
}

/** The non-empty buckets in order, each grouped by project and checkout. */
export function bucketGroups(apps: AppProposal[], buckets: ReadonlyMap<string, SetupBucket>): BucketGroup[] {
  return BUCKET_ORDER.map((bucket) => {
    const list = apps.filter((a) => (buckets.get(a.task) ?? bucketOf(a)) === bucket);
    return { bucket, apps: list, groups: groupProposalApps(list) };
  }).filter((b) => b.apps.length > 0);
}

/** A folder path cut to its last two parts ("…/apps/web"), for one line; the full one goes in a tooltip. */
export function shortDir(dir: string, keep = 2): string {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  if (parts.length === 0) return ".";
  return parts.length <= keep ? parts.join("/") : `…/${parts.slice(-keep).join("/")}`;
}

export interface ProposalCounts {
  new: number;
  changed: number;
  unchanged: number;
  manual: number;
  skipped: number;
  removed: number;
}

export function proposalCounts(p: Proposal): ProposalCounts {
  const c: ProposalCounts = { new: 0, changed: 0, unchanged: 0, manual: 0, skipped: 0, removed: p.change.removed.length };
  for (const a of p.apps) c[a.status]++;
  return c;
}

/** "3 new · 1 changed · 2 removed": what writing would do to the tasks. */
export function countsText(c: ProposalCounts): string {
  const parts: string[] = [];
  if (c.new) parts.push(`${c.new} new`);
  if (c.changed) parts.push(`${c.changed} changed`);
  if (c.removed) parts.push(`${c.removed} removed`);
  if (c.unchanged) parts.push(`${c.unchanged} unchanged`);
  return parts.length ? parts.join(" · ") : "no tasks";
}

export function changedFiles(p: Proposal): FileChange[] {
  return p.files.filter((f) => f.changed);
}

/** A file's path relative to the folder being set up, for display. */
export function relativePath(path: string, folder: string): string {
  const sep = folder.includes("\\") && !folder.includes("/") ? "\\" : "/";
  const base = folder.endsWith(sep) ? folder : folder + sep;
  return path.startsWith(base) ? path.slice(base.length) : path;
}

export function missingRequirements(check: SetupCheck): Requirement[] {
  return check.requirements.filter((r) => !r.ok);
}

export function privilegeLabel(os: string | undefined): string {
  return os === "windows" ? "needs admin" : "needs sudo";
}

export interface WriteState {
  proposal: Proposal | null;
  scannedKey: string | null; // overridesKey of the scan that produced the proposal
  edits: SetupEdits;
  scanning: boolean;
}

/** Whether "Write config" can run now, and if not, why (shown next to the button). */
export function writeBlocker(s: WriteState): string | null {
  if (!s.proposal) return "Scan the folder first.";
  const bad = invalidNames(s.edits);
  if (bad.length) return bad.length === 1 ? "One name needs fixing." : `${bad.length} names need fixing.`;
  if (nameClashes(s.proposal.apps, s.edits).size) return "Two apps would get the same URL.";
  if (s.scanning || s.scannedKey !== overridesKey(overridesFor(s.edits))) return "Updating the preview…";
  if (changedFiles(s.proposal).length === 0) return "Nothing to write: the config is up to date.";
  return null;
}

/** The toast after a write. */
export function applyMessage(res: ApplyResult): { kind: "info" | "error"; text: string } {
  const n = res.written.length;
  if (n === 0) return { kind: "info", text: "Nothing to write: the config was already up to date." };
  const wrote = `Wrote ${n} ${n === 1 ? "file" : "files"}.`;
  if (res.reloadError) return { kind: "error", text: `${wrote} dekit couldn't reload them: ${res.reloadError}` };
  return { kind: "info", text: res.reloaded ? `${wrote} dekit picked up the new tasks.` : `${wrote} Start the runner to run them.` };
}
