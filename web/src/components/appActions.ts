import { errorText } from "../api/errors";
import type { App, Verb } from "../api/types";
import { copyText } from "../lib/clipboard";
import { appsFingerprint, runnerFingerprint } from "../lib/pending";
import { appTarget } from "../lib/targets";
import type { AppCtx } from "./AppContext";

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
