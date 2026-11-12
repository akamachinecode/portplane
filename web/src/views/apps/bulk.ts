import type { Target, Verb } from "../../api/types";
import { appKey } from "../../components/appActions";
import type { AppCtx } from "../../components/AppContext";
import type { IconName } from "../../components/Icon";
import { appsFingerprint } from "../../lib/pending";
import { isAlive } from "../../lib/apps";
import { bulkTargets, canAct, type AppEntry } from "./model";

// The selection toolbar's actions. Each takes the selected apps, keeps the
// ones it applies to, and runs once per project (a dekit runner) with the
// exact list of tasks, while every row it touches spins until its app
// changes.

export interface BulkAction {
  id: string;
  /** A verb: "Start". The toolbar adds the count: "Start 3". */
  label: string;
  icon: IconName;
  tone?: "go" | "halt";
  /** The selected apps this action changes. */
  applies(selected: AppEntry[]): AppEntry[];
  run(ctx: Pick<AppCtx, "api" | "pending" | "toast">, entries: AppEntry[]): Promise<void>;
  /** Asks first: what the dialog says for these apps. */
  confirm?(entries: AppEntry[]): { title: string; body: string; confirmLabel: string };
}

/** One request per machine and runner. */
export function bulkRequests(entries: AppEntry[]): Array<{ target: Target; entries: AppEntry[] }> {
  const groups = new Map<string, { target: Target; entries: AppEntry[] }>();
  for (const e of entries) {
    const machine = e.ms.machine.id;
    const k = `${machine}\u0000${e.app.runner}`;
    let g = groups.get(k);
    if (!g) {
      g = { target: { machine, runner: e.app.runner, tasks: [] }, entries: [] };
      groups.set(k, g);
    }
    g.target.tasks!.push(e.app.task);
    g.entries.push(e);
  }
  return [...groups.values()];
}

/** Runs verb on every entry; the button of each one spins as if clicked. */
export function actOnEntries(ctx: Pick<AppCtx, "api" | "pending">, entries: AppEntry[], verb: Verb): Promise<void> {
  const runs: Array<Promise<void>> = [];
  for (const { target, entries: group } of bulkRequests(entries)) {
    let request: Promise<void> | null = null;
    const send = () => (request ??= ctx.api.act(target, verb));
    for (const e of group) {
      runs.push(ctx.pending.run(appKey(target.machine, e.app) + verb, appsFingerprint(target.machine, [e.app.id]), send));
    }
  }
  return Promise.all(runs).then(() => undefined);
}

const count = (n: number) => (n === 1 ? "1 app" : `${n} apps`);

export const BULK_ACTIONS: BulkAction[] = [
  {
    id: "start",
    label: "Start",
    icon: "play",
    tone: "go",
    applies: (s) => bulkTargets(s, "start"),
    run: (ctx, entries) => actOnEntries(ctx, entries, "start"),
  },
  {
    id: "stop",
    label: "Stop",
    icon: "stop",
    tone: "halt",
    applies: (s) => bulkTargets(s, "stop"),
    async run(ctx, entries) {
      await actOnEntries(ctx, entries, "stop");
      // Stopping is the one bulk action that loses something (running
      // servers): it can be undone for a while.
      ctx.toast.info(`Stopping ${count(entries.length)}`, {
        action: { label: "Undo", run: () => void actOnEntries(ctx, entries, "start") },
      });
    },
  },
  {
    id: "restart",
    label: "Restart",
    icon: "restart",
    applies: (s) => bulkTargets(s, "restart"),
    run: (ctx, entries) => actOnEntries(ctx, entries, "restart"),
  },
  // The dekit center's actions (components/appActions.ts), for many apps.
  {
    id: "veto",
    label: "Keep stopped",
    icon: "pause",
    applies: (s) => s.filter((e) => canAct(e) && e.app.detail !== "kept stopped"),
    async run(ctx, entries) {
      await actOnEntries(ctx, entries, "veto");
      ctx.toast.info(`${count(entries.length)} kept stopped`, {
        action: { label: "Undo", run: () => void actOnEntries(ctx, entries, "start") },
      });
    },
  },
  {
    id: "kill",
    label: "Kill",
    icon: "xCircle",
    tone: "halt",
    applies: (s) => s.filter((e) => canAct(e) && isAlive(e.app.state)),
    run: (ctx, entries) => actOnEntries(ctx, entries, "kill"),
    confirm: (entries) => ({
      title: `Kill ${count(entries.length)}?`,
      body: `Stops ${entries.map((e) => e.app.label).join(", ")} at once with a hard kill, without letting them clean up. Use it when Stop doesn't respond. If another app needs one of them, dekit may start it again.`,
      confirmLabel: "Kill",
    }),
  },
];
