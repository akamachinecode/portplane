import type { Api } from "../../api/client";
import type { RunnersResponse } from "../../api/dekit";
import type { MachineSnapshot, Snapshot } from "../../api/types";
import { errorText } from "../../api/errors";
import { LOCAL_MACHINE } from "../../api/machine";
import { invalidateProblems, registerProblemSource, type Problem } from "../../shell/health";

// The dekit center's problems for the Health view: stale runner records for
// folders Portplane doesn't watch (a watched one already shows as "dekit
// isn't running for …"), and runners that need a restart to switch to the
// dekit binary their project now selects. Loaded once in the background,
// and again after the user acts on runners, for this computer and each
// machine over SSH (ADR-0026).

const runners = new Map<string, RunnersResponse>();
const loading = new Map<string, Promise<void>>();

/**
 * Loads a machine's runners once; later calls reuse the answer. `api` is
 * that machine's (api.forMachine), this computer's by default.
 */
export function primeRunners(api: Api, force = false, machine = LOCAL_MACHINE): Promise<void> {
  const inflight = loading.get(machine);
  if (inflight) return inflight;
  if (runners.has(machine) && !force) return Promise.resolve();
  const p = api
    .dekitRunners()
    .then(
      (r) => {
        runners.set(machine, r);
      },
      (err: unknown) => {
        console.warn(`runners on ${machine} for Health:`, errorText(err));
      },
    )
    .finally(() => {
      loading.delete(machine);
      invalidateProblems();
    });
  loading.set(machine, p);
  return p;
}

/** Forgets a machine's runners (it went offline: they come back with it). */
export function forgetRunners(machine: string): void {
  if (runners.delete(machine)) invalidateProblems();
}

export function runnerProblems(snapshot: Snapshot, only?: { machine: string; runners: RunnersResponse }): Problem[] {
  return snapshot.machines.flatMap((ms) => {
    const r = only ? (only.machine === ms.machine.id ? only.runners : undefined) : runners.get(ms.machine.id);
    return r ? machineRunnerProblems(ms, r) : [];
  });
}

function machineRunnerProblems(ms: MachineSnapshot, r: RunnersResponse): Problem[] {
  const local = ms;
  if (!local.tools.dekit || !r.available) return [];
  if (!local.machine.local && local.machine.status !== "online") return [];
  const id = local.machine.id;
  const where = { id, name: local.machine.name };
  const on = (c: { api: Api }) => c.api.forMachine(id);
  const route = { view: "runners" as const, machine: id };
  const out: Problem[] = [];
  const stale = r.runners.filter((x) => x.state === "stale" && !x.watched);
  if (stale.length > 0) {
    out.push({
      id: `dekit-stale|${id}`,
      severity: "info",
      title: stale.length === 1 ? `dekit has a stale record for ${stale[0].name}` : `dekit has ${stale.length} stale runner records`,
      detail: "Nothing runs: they're left from a crash or a restart. Cleaning never touches running runners.",
      path: stale.map((x) => x.root).join("\n"),
      machine: where,
      fix: {
        label: "Clean stale records",
        pendingKey: `dekit-clean-stale|${id}`,
        run: (ctx) =>
          ctx.pending.run(`dekit-clean-stale|${id}`, null, async () => {
            await on(ctx).dekitCleanRunners();
            await primeRunners(on(ctx), true, id);
          }),
      },
      link: { label: "Runners", route },
    });
  }
  for (const x of [...r.runners, r.host]) {
    if (!x?.restartRequired || x.state !== "running") continue;
    out.push({
      id: `dekit-restart-required|${id}|${x.root}`,
      severity: "info",
      title: `${x.name}'s runner uses another dekit than its project selects`,
      detail: r.live
        ? "Restarting the runner switches it without stopping its tasks."
        : "Stop the runner and start it again to switch (dekit can't switch in place on Windows).",
      path: x.selectedBinary,
      machine: where,
      fix: r.live
        ? {
            label: "Restart runner",
            pendingKey: `dekit-restart|${id}|${x.root}`,
            run: (ctx) =>
              ctx.pending.run(`dekit-restart|${id}|${x.root}`, null, async () => {
                await on(ctx).dekitRunnerAction(x.root, "restart");
                await primeRunners(on(ctx), true, id);
              }),
          }
        : undefined,
      link: { label: "Runners", route },
    });
  }
  return out;
}

registerProblemSource("dekit-runners", (s) => runnerProblems(s));
