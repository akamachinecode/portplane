import type { App, MachineSnapshot, Project, Snapshot, State, Worktree } from "../../api/types";
import { indexApps, isAlive, isVisible, worktreeApps } from "../../lib/apps";
import { fuzzyMatch } from "../../lib/fuzzy";

// The Apps view's data (plan §6.2): every visible app as an entry, filtered
// by state, machine, project and tag, fuzzy-searched by name, URL or path,
// sorted, with the pinned apps first, and grouped by machine → project →
// worktree. Pure functions, so the view stays thin and this stays tested.

/** One app on one machine. key is "<machine>|<appId>", like preferences.favorites. */
export interface AppEntry {
  key: string;
  ms: MachineSnapshot;
  app: App;
  favorite: boolean;
  /** Position in the machine's config order, for stable sorting. */
  order: number;
}

export type StateFilter = "running" | "busy" | "failed" | "stopped";
export type SortKey = "activity" | "name" | "state";

export interface AppFilters {
  query: string;
  states: StateFilter[];
  machines: string[];
  projects: string[]; // "<machine>|<project>"
  tags: string[];
}

export const NO_FILTERS: AppFilters = { query: "", states: [], machines: [], projects: [], tags: [] };

export const STATE_FILTERS: Array<{ value: StateFilter; label: string }> = [
  { value: "running", label: "Running" },
  { value: "busy", label: "Starting or stopping" },
  { value: "failed", label: "Failed" },
  { value: "stopped", label: "Stopped" },
];

export const SORTS: Array<{ value: SortKey; label: string; description: string }> = [
  { value: "activity", label: "Activity", description: "Running first, then failed, then stopped" },
  { value: "state", label: "State", description: "Failed first, so problems stand out" },
  { value: "name", label: "Name", description: "Alphabetical" },
];

export function entryKey(machine: string, appId: string): string {
  return `${machine}|${appId}`;
}

export function projectKey(machine: string, project: string): string {
  return `${machine}|${project}`;
}

export function stateFilter(state: State): StateFilter {
  switch (state) {
    case "on":
      return "running";
    case "starting":
    case "stopping":
      return "busy";
    case "failed":
      return "failed";
    default:
      return "stopped";
  }
}

/** Machines whose apps are known: this one, and remote ones while online. */
export function liveMachines(snapshot: Snapshot): MachineSnapshot[] {
  return snapshot.machines.filter((ms) => ms.machine.local || ms.machine.status === "online");
}

/** Every visible app (services, and jobs while they run or after they fail). */
export function collectEntries(snapshot: Snapshot, favorites: ReadonlySet<string>): AppEntry[] {
  const out: AppEntry[] = [];
  for (const ms of liveMachines(snapshot)) {
    ms.apps.forEach((app, i) => {
      if (!isVisible(app)) return;
      const key = entryKey(ms.machine.id, app.id);
      out.push({ key, ms, app, favorite: favorites.has(key), order: app.order ?? i });
    });
  }
  return out;
}

/** The texts search looks at, best first: name, then address, then where it lives. */
function searchFields(e: AppEntry): string[] {
  const a = e.app;
  return [a.label, a.hostname ?? "", a.url ?? "", a.remoteUrl ?? "", a.project, a.worktree ?? "", a.task, a.dir ?? ""].filter(Boolean);
}

/** How well an entry matches the query (higher is better), or null. Name matches win. */
export function matchScore(e: AppEntry, query: string): number | null {
  const q = query.trim();
  if (!q) return 0;
  let best: number | null = null;
  searchFields(e).forEach((text, i) => {
    const m = fuzzyMatch(q, text);
    if (!m) return;
    // Later fields count a little less, so "web" ranks the app named web
    // above an app whose path has a "web" folder in it.
    const score = m.score - i * 1.5;
    if (best === null || score > best) best = score;
  });
  return best;
}

/** Entries that pass every filter, each with its search score. */
export function filterEntries(entries: AppEntry[], f: AppFilters): Array<{ entry: AppEntry; score: number }> {
  const states = new Set(f.states);
  const machines = new Set(f.machines);
  const projects = new Set(f.projects);
  const tags = new Set(f.tags);
  const out: Array<{ entry: AppEntry; score: number }> = [];
  for (const entry of entries) {
    const { app, ms } = entry;
    if (states.size && !states.has(stateFilter(app.state))) continue;
    if (machines.size && !machines.has(ms.machine.id)) continue;
    if (projects.size && !projects.has(projectKey(ms.machine.id, app.project))) continue;
    if (tags.size && !(app.tags ?? []).some((t) => tags.has(t))) continue;
    const score = matchScore(entry, f.query);
    if (score === null) continue;
    out.push({ entry, score });
  }
  return out;
}

export function hasFilters(f: AppFilters): boolean {
  return f.query.trim() !== "" || f.states.length > 0 || f.machines.length > 0 || f.projects.length > 0 || f.tags.length > 0;
}

// Rank of a state under each sort; lower comes first.
const ACTIVITY: Record<StateFilter, number> = { running: 0, busy: 1, failed: 2, stopped: 3 };
const PROBLEMS: Record<StateFilter, number> = { failed: 0, busy: 1, running: 2, stopped: 3 };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function compareEntries(a: AppEntry, b: AppEntry, sort: SortKey): number {
  switch (sort) {
    case "name":
      return collator.compare(a.app.label, b.app.label) || collator.compare(a.app.project, b.app.project) || a.order - b.order;
    case "state":
      return PROBLEMS[stateFilter(a.app.state)] - PROBLEMS[stateFilter(b.app.state)] || a.order - b.order;
    default:
      return ACTIVITY[stateFilter(a.app.state)] - ACTIVITY[stateFilter(b.app.state)] || a.order - b.order;
  }
}

// ---- grouping ----

export interface WorktreeGroup {
  /** "" for the main checkout. */
  name: string;
  worktree: Worktree;
  entries: AppEntry[];
}

export interface ProjectGroup {
  key: string; // "<machine>|<runner>|<project>"
  project: Project;
  worktrees: WorktreeGroup[];
  /** More than one worktree in the project: show their names. */
  multi: boolean;
}

export interface MachineGroup {
  ms: MachineSnapshot;
  projects: ProjectGroup[];
}

export interface AppsLayout {
  /** Pinned apps, on top; each shows only here, not in its project too. */
  pinned: AppEntry[];
  machines: MachineGroup[];
  /** Every shown app in display order: what j/k walk and Shift+click spans. */
  order: AppEntry[];
  /** Entries before filtering, for the filter menus' counts. */
  total: number;
}

/** A project's rank under a sort: its best app's rank. */
function groupRank(entries: AppEntry[], sort: SortKey): number {
  if (sort === "name") return 0;
  const ranks = entries.map((e) => (sort === "state" ? PROBLEMS : ACTIVITY)[stateFilter(e.app.state)]);
  return Math.min(...ranks);
}

/**
 * Lays out the Apps view. With a query, every group lists its best matches
 * first; without one, the sort applies. Groups keep the machine order, and
 * projects follow their best app (or their name when sorting by name).
 */
export function layoutApps(snapshot: Snapshot, favorites: ReadonlySet<string>, filters: AppFilters, sort: SortKey): AppsLayout {
  const entries = collectEntries(snapshot, favorites);
  const kept = filterEntries(entries, filters);
  const searching = filters.query.trim() !== "";
  const scoreOf = new Map(kept.map((k) => [k.entry.key, k.score]));
  const cmp = (a: AppEntry, b: AppEntry) => (searching ? (scoreOf.get(b.key) ?? 0) - (scoreOf.get(a.key) ?? 0) : 0) || compareEntries(a, b, sort);
  const shown = new Set(kept.map((k) => k.entry.key));
  const byKey = new Map(kept.map((k) => [k.entry.key, k.entry]));

  const pinned = kept
    .map((k) => k.entry)
    .filter((e) => e.favorite)
    .sort(cmp);

  const machines: MachineGroup[] = [];
  for (const ms of liveMachines(snapshot)) {
    const byId = indexApps(ms.apps);
    const projects: ProjectGroup[] = [];
    for (const project of ms.projects) {
      const worktrees: WorktreeGroup[] = [];
      for (const wt of project.worktrees) {
        const list = worktreeApps(wt, byId)
          .map((a) => byKey.get(entryKey(ms.machine.id, a.id)))
          .filter((e): e is AppEntry => !!e && shown.has(e.key) && !e.favorite)
          .sort(cmp);
        if (list.length) worktrees.push({ name: wt.name, worktree: wt, entries: list });
      }
      if (worktrees.length) {
        projects.push({ key: `${ms.machine.id}|${project.runner}|${project.name}`, project, worktrees, multi: project.worktrees.length > 1 });
      }
    }
    const rankOf = (p: ProjectGroup) =>
      groupRank(
        p.worktrees.flatMap((w) => w.entries),
        sort,
      );
    projects.sort((a, b) => {
      if (searching) {
        const best = (p: ProjectGroup) => Math.max(...p.worktrees.flatMap((w) => w.entries.map((e) => scoreOf.get(e.key) ?? 0)));
        return best(b) - best(a);
      }
      return sort === "name" ? collator.compare(a.project.name, b.project.name) : rankOf(a) - rankOf(b);
    });
    machines.push({ ms, projects });
  }

  const order = [...pinned, ...machines.flatMap((m) => m.projects.flatMap((p) => p.worktrees.flatMap((w) => w.entries)))];
  return { pinned, machines, order, total: entries.length };
}

// ---- filter options ----

export interface FilterOption {
  value: string;
  label: string;
  count: number;
}

/** What each filter menu offers, with how many apps each option has. */
export function filterOptions(snapshot: Snapshot): { machines: FilterOption[]; projects: FilterOption[]; tags: FilterOption[]; states: FilterOption[] } {
  const entries = collectEntries(snapshot, new Set());
  const count = <K extends string>(keyOf: (e: AppEntry) => K[], label: (k: K, e: AppEntry) => string) => {
    const m = new Map<K, FilterOption>();
    for (const e of entries) {
      for (const k of keyOf(e)) {
        const o = m.get(k) ?? { value: k, label: label(k, e), count: 0 };
        o.count++;
        m.set(k, o);
      }
    }
    return [...m.values()];
  };
  const multiMachine = liveMachines(snapshot).length > 1;
  const states = STATE_FILTERS.map((s) => ({ value: s.value, label: s.label, count: entries.filter((e) => stateFilter(e.app.state) === s.value).length }));
  return {
    states,
    machines: count(
      (e) => [e.ms.machine.id],
      (_k, e) => e.ms.machine.name,
    ),
    projects: count(
      (e) => [projectKey(e.ms.machine.id, e.app.project)],
      (_k, e) => (multiMachine ? `${e.app.project} · ${e.ms.machine.name}` : e.app.project),
    ).sort((a, b) => collator.compare(a.label, b.label)),
    tags: count(
      (e) => e.app.tags ?? [],
      (k) => k,
    ).sort((a, b) => collator.compare(a.label, b.label)),
  };
}

// ---- favourites ----

/** Pins or unpins an app; new pins go last, so the tray keeps its order. */
export function toggleFavorite(favorites: string[], key: string): string[] {
  return favorites.includes(key) ? favorites.filter((k) => k !== key) : [...favorites, key];
}

// ---- selection ----

/** Adds or removes one key. */
export function toggleSelection(selection: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(selection);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/**
 * Shift+click: selects every entry between the anchor and key, in display
 * order, keeping what was selected. Without an anchor in view it toggles
 * key alone.
 */
export function selectRange(selection: ReadonlySet<string>, order: AppEntry[], anchor: string | null, key: string): Set<string> {
  const keys = order.map((e) => e.key);
  const a = anchor ? keys.indexOf(anchor) : -1;
  const b = keys.indexOf(key);
  if (a < 0 || b < 0) return toggleSelection(selection, key);
  const next = new Set(selection);
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(keys[i]);
  return next;
}

export type SelectBy = { kind: "all" } | { kind: "state"; state: StateFilter } | { kind: "project"; project: string } | { kind: "tag"; tag: string };

/** "Select by…": the shown entries that match, added to the selection. */
export function selectBy(selection: ReadonlySet<string>, order: AppEntry[], by: SelectBy): Set<string> {
  const next = new Set(selection);
  for (const e of order) {
    const ok =
      by.kind === "all" ||
      (by.kind === "state" && stateFilter(e.app.state) === by.state) ||
      (by.kind === "project" && projectKey(e.ms.machine.id, e.app.project) === by.project) ||
      (by.kind === "tag" && (e.app.tags ?? []).includes(by.tag));
    if (ok) next.add(e.key);
  }
  return next;
}

/** Drops selected keys that are no longer shown (filtered out, or gone). */
export function pruneSelection(selection: ReadonlySet<string>, order: AppEntry[]): ReadonlySet<string> {
  if (selection.size === 0) return selection;
  const shown = new Set(order.map((e) => e.key));
  const kept = [...selection].filter((k) => shown.has(k));
  return kept.length === selection.size ? selection : new Set(kept);
}

/** Whether an entry can be started or stopped from here: dekit runs where it lives. */
export function canAct(e: AppEntry): boolean {
  return !!e.ms.tools.dekit && (e.ms.machine.local || e.ms.machine.status === "online");
}

/** The entries a bulk verb applies to: start what is not running, stop or restart what is. */
export function bulkTargets(entries: AppEntry[], verb: "start" | "stop" | "restart"): AppEntry[] {
  return entries.filter((e) => canAct(e) && (verb === "start" ? !isAlive(e.app.state) : isAlive(e.app.state)));
}
