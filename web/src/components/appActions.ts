import { errorText } from "../api/errors";
import type { App, MachineSnapshot, Verb } from "../api/types";
import { isAlive } from "../lib/apps";
import { copyText } from "../lib/clipboard";
import { appsFingerprint, runnerFingerprint } from "../lib/pending";
import { appTarget } from "../lib/targets";
import type { AppCtx } from "./AppContext";
import type { IconName } from "./Icon";

// Actions shared by the app rows, the detail panel, the palette and the
// health list, so a button in one place spins while the same action runs
// from another.

/** The pending-key prefix of every action on one app. */
export function appKey(machine: string, app: Pick<App, "id">): string {
  return `app|${machine}|${app.id}|`;
}

export function runnerKey(machine: string, root: string): string {
  return `runner|${machine}|${root}`;
}

/** Start, stop or restart an app; the button spins until the snapshot shows the change. */
export function actOnApp(ctx: Pick<AppCtx, "api" | "pending">, machine: string, app: App, verb: Verb): Promise<void> {
  return ctx.pending.run(appKey(machine, app) + verb, appsFingerprint(machine, [app.id]), () => ctx.api.act(appTarget(machine, app), verb));
}

/** Brings a project's dekit runner up. */
export function startRunner(ctx: Pick<AppCtx, "api" | "pending">, machine: string, root: string): Promise<void> {
  return ctx.pending.run(runnerKey(machine, root), runnerFingerprint(machine, root), () => ctx.api.runnerUp(machine, root));
}

/** Copies text and says so in a toast: "Copied the URL". */
export function copyWithToast(ctx: Pick<AppCtx, "toast">, text: string, what: string): Promise<void> {
  return copyText(text).then(
    () => ctx.toast.info(`Copied ${what}`),
    (err: unknown) => ctx.toast.error(errorText(err)),
  );
}

// ---- more actions on one app (plan §4.2) ----

export type AppActionId = "force-restart" | "kill" | "veto" | "remove";

export interface AppAction {
  id: AppActionId;
  label: string;
  icon: IconName;
  verb: Verb;
  /** Says what will happen before it does; absent: runs at once. */
  confirm?: { title: string; body: string; confirmLabel: string; danger: boolean };
  /** Removing waits a few seconds with "Undo" instead of asking. */
  undoable?: boolean;
  /** It applies to this app now. */
  applies: boolean;
  /** When it doesn't apply, why (for a disabled control or a bulk action). */
  reason?: string;
}

/**
 * The actions beyond start, stop and restart, in menu order, each saying
 * whether it applies to the app now. The row's "…" menu and the detail
 * drawer show the ones that apply; bulk actions can reuse the list.
 */
export function appActionList(app: App, ms: Pick<MachineSnapshot, "machine" | "tools">): AppAction[] {
  const reachable = !!ms.tools.dekit && (ms.machine.local || ms.machine.status === "online");
  const why = !ms.tools.dekit ? "dekit isn't installed on this machine." : !reachable ? "The machine isn't connected." : undefined;
  const alive = isAlive(app.state);
  const removable = app.dynamic || app.portplane;
  const vetoed = app.detail === "kept stopped";
  return [
    {
      id: "force-restart",
      label: alive ? "Force restart" : "Start",
      icon: "bolt",
      verb: "force-restart",
      applies: reachable && alive,
      reason: why ?? (alive ? undefined : "It isn't running: use Start."),
      confirm: {
        title: `Force restart ${app.label}?`,
        body: "Kills it at once, without letting it clean up, and starts it again. Use it when Restart doesn't respond.",
        confirmLabel: "Force restart",
        danger: true,
      },
    },
    {
      id: "kill",
      label: "Kill",
      icon: "xCircle",
      verb: "kill",
      applies: reachable && alive,
      reason: why ?? (alive ? undefined : "It isn't running."),
      confirm: {
        title: `Kill ${app.label}?`,
        body: "Stops it at once with a hard kill, without letting it clean up. Use it when Stop doesn't respond. If another app needs it, dekit may start it again.",
        confirmLabel: "Kill",
        danger: true,
      },
    },
    {
      id: "veto",
      label: "Keep stopped",
      icon: "pause",
      verb: "veto",
      applies: reachable && !vetoed,
      reason: why ?? (vetoed ? "It's already kept stopped: start it to lift that." : undefined),
      confirm: {
        title: `Keep ${app.label} stopped?`,
        body: "Stops it and keeps it stopped, even when another app needs it, until you start it again yourself. Apps that need it wait.",
        confirmLabel: "Keep stopped",
        danger: false,
      },
    },
    {
      id: "remove",
      label: "Remove",
      icon: "trash",
      verb: "rm",
      undoable: true,
      applies: reachable && !!removable,
      reason: why ?? (removable ? undefined : "It's in your dekit.yaml: remove it there."),
    },
  ];
}
