import { useEffect, useId, useMemo, type DependencyList } from "react";
import type { AppCtx } from "../components/AppContext";
import type { IconName } from "../components/Icon";
import { fuzzyMatch } from "../lib/fuzzy";
import { createRegistry } from "../lib/registry";
import type { ShellData } from "./ShellContext";

// The command palette's registry (plan §6.3). Commands come from:
//   - global sources: registerCommandSource("portless", (ctx) => [...]) at
//     module level, evaluated each time the palette renders;
//   - views, while mounted: useCommands(() => [...], [deps]).
// builtinCommands.ts registers the built-in ones the same way.

/** Everything a command can read or use when it is listed and when it runs. */
export type CommandContext = AppCtx & ShellData;

export interface Command {
  /** Unique; a later registration with the same id replaces the earlier one. */
  id: string;
  title: string;
  /** The section it lists under, e.g. "Go to", "Apps", "Machines". */
  group: string;
  icon?: IconName;
  /** Dimmed text after the title (an app's project and machine); also matched. */
  hint?: string;
  /** More words that match without showing (e.g. "preferences" for Settings). */
  keywords?: string[];
  /** Listed only once the user types: keeps the empty palette short. */
  searchOnly?: boolean;
  /** May return a promise; a rejection shows as a toast. */
  run(ctx: CommandContext): unknown;
}

export type CommandSource = (ctx: CommandContext) => Command[];

const registry = createRegistry<CommandSource>();

/**
 * Adds a global source of commands. Call it at module level from the file
 * that owns the commands; returns a function that removes the source.
 */
export function registerCommandSource(id: string, source: CommandSource): () => void {
  return registry.register(`source:${id}`, source);
}

/**
 * Adds commands while the calling component is mounted, e.g. a view's own
 * actions. Like useMemo, the commands are rebuilt when deps change.
 */
export function useCommands(commands: Command[] | (() => Command[]), deps: DependencyList): void {
  const key = useId();
  const list = useMemo(typeof commands === "function" ? commands : () => commands, deps);
  useEffect(() => registry.register(`view:${key}`, () => list), [key, list]);
}

/** Re-renders when a source or a view's commands come or go. */
export const useCommandsVersion = registry.useVersion;

/** Every command available now, de-duplicated by id. A source that throws is skipped. */
export function collectCommands(ctx: CommandContext): Command[] {
  const byId = new Map<string, Command>();
  for (const source of registry.values()) {
    let list: Command[];
    try {
      list = source(ctx);
    } catch (err) {
      console.error("command source failed", err);
      continue;
    }
    for (const c of list) byId.set(c.id, c);
  }
  return [...byId.values()];
}

// ---- matching ----

export interface RankedCommand {
  command: Command;
  score: number;
  /** Matched letters in the title and in the hint, for highlighting. */
  titleIndices: number[];
  hintIndices: number[];
}

export interface CommandGroup {
  name: string;
  items: RankedCommand[];
}

/** Where known groups go when nothing is typed; others follow in the order they come. */
export const GROUP_ORDER = ["Go to", "Apps", "Actions", "Machines", "Settings", "Developer"];

const TITLE_BONUS = 2;
const ELSEWHERE_PENALTY = 3;
/** Matches scoring under this share of the best one are dropped. */
const RELATIVE_FLOOR = 0.35;

/** How well one command matches the query, or null. An empty query matches everything. */
export function rankCommand(command: Command, query: string): RankedCommand | null {
  const title = fuzzyMatch(query, command.title);
  if (title) return { command, score: title.score + TITLE_BONUS, titleIndices: title.indices, hintIndices: [] };
  // Not in the title alone: try the title with its hint and keywords.
  const hint = command.hint ?? "";
  const full = [command.title, hint, ...(command.keywords ?? [])].join(" ");
  const m = fuzzyMatch(query, full);
  if (!m) return null;
  const hintStart = command.title.length + 1;
  return {
    command,
    score: m.score - ELSEWHERE_PENALTY,
    titleIndices: m.indices.filter((i) => i < command.title.length),
    hintIndices: m.indices.filter((i) => i >= hintStart && i < hintStart + hint.length).map((i) => i - hintStart),
  };
}

/**
 * The palette's list: with no query, every command not marked searchOnly, by
 * group in GROUP_ORDER; with a query, the matches, best first, each group
 * placed where its best match ranks. At most `limit` commands.
 */
export function filterCommands(commands: Command[], query: string, limit = 120): CommandGroup[] {
  const q = query.trim();
  let ranked: RankedCommand[];
  if (q === "") {
    ranked = commands.filter((c) => !c.searchOnly).map((command) => ({ command, score: 0, titleIndices: [], hintIndices: [] }));
    const order = (g: string) => {
      const i = GROUP_ORDER.indexOf(g);
      return i < 0 ? GROUP_ORDER.length : i;
    };
    ranked = ranked
      .map((r, i) => ({ r, i }))
      .sort((a, b) => order(a.r.command.group) - order(b.r.command.group) || a.i - b.i)
      .map((x) => x.r);
  } else {
    ranked = commands
      .map((c, i) => ({ r: rankCommand(c, q), i }))
      .filter((x): x is { r: RankedCommand; i: number } => x.r !== null)
      .sort((a, b) => b.r.score - a.r.score || a.i - b.i)
      .map((x) => x.r);
    // Letters scattered through a long hint technically match; next to good
    // matches they are noise.
    const floor = Math.max(0, (ranked[0]?.score ?? 0) * RELATIVE_FLOOR);
    ranked = ranked.filter((r) => r.score > floor);
  }
  const groups: CommandGroup[] = [];
  const byName = new Map<string, CommandGroup>();
  for (const r of ranked.slice(0, limit)) {
    let g = byName.get(r.command.group);
    if (!g) {
      g = { name: r.command.group, items: [] };
      byName.set(g.name, g);
      groups.push(g);
    }
    g.items.push(r);
  }
  return groups;
}
