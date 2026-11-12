import type { Api } from "../../api/client";
import type { RunnersResponse } from "../../api/dekit";
import type { Snapshot } from "../../api/types";
import { errorText } from "../../api/errors";
import { invalidateProblems, registerProblemSource, type Problem } from "../../shell/health";

// The dekit center's problems for the Health view: stale runner records for
// folders Portplane doesn't watch (a watched one already shows as "dekit
// isn't running for …"), and runners that need a restart to switch to the
// dekit binary their project now selects. Loaded once in the background,
// and again after the user acts on runners.

let runners: RunnersResponse | null = null;
let loading: Promise<void> | null = null;

/** Loads this computer's runners once; later calls reuse the answer. */
export function primeRunners(api: Api, force = false): Promise<void> {
  if (loading) return loading;
  if (runners && !force) return Promise.resolve();
  loading = api
    .dekitRunners()
    .then(
      (r) => {
        runners = r;
      },
      (err: unknown) => {
        console.warn("runners for Health:", errorText(err));
      },
    )
    .finally(() => {
      loading = null;
      invalidateProblems();
    });
  return loading;
}

export function runnerProblems(snapshot: Snapshot, r: RunnersResponse | null = runners): Problem[] {
  const local = snapshot.machines.find((m) => m.machine.local);
  if (!local?.tools.dekit || !r?.available) return [];
  const where = { id: local.machine.id, name: local.machine.name };
  const out: Problem[] = [];
  const stale = r.runners.filter((x) => x.state === "stale" && !x.watched);
  if (stale.length > 0) {
    out.push({
      id: `dekit-stale|${local.machine.id}`,
      severity: "info",
      title: stale.length === 1 ? `dekit has a stale record for ${stale[0].name}` : `dekit has ${stale.length} stale runner records`,
      detail: "Their runners stopped without cleaning up (a crash or a restart). Nothing runs; the records only clutter `dekit runner list`. Cleaning never touches running runners.",
      code: stale.map((x) => x.root).join("\n"),
      machine: where,
      fix: {
        label: "Clean stale records",
        pendingKey: "dekit-clean-stale",
        run: (ctx) =>
          ctx.pending.run("dekit-clean-stale", null, async () => {
            await ctx.api.dekitCleanRunners();
            await primeRunners(ctx.api, true);
          }),
      },
      link: { label: "Runners", route: { view: "runners" } },
    });
  }
  for (const x of [...r.runners, r.host]) {
    if (!x?.restartRequired || x.state !== "running") continue;
    out.push({
      id: `dekit-restart-required|${local.machine.id}|${x.root}`,
      severity: "info",
      title: `${x.name}'s runner uses another dekit than its project selects`,
      detail: r.live
        ? "Restarting the runner switches it without stopping its tasks."
        : "Stop the runner and start it again to switch (dekit can't switch in place on Windows).",
      code: x.selectedBinary,
      machine: where,
      fix: r.live
        ? {
            label: "Restart runner",
            pendingKey: `dekit-restart|${x.root}`,
            run: (ctx) =>
              ctx.pending.run(`dekit-restart|${x.root}`, null, async () => {
                await ctx.api.dekitRunnerAction(x.root, "restart");
                await primeRunners(ctx.api, true);
              }),
          }
        : undefined,
      link: { label: "Runners", route: { view: "runners" } },
    });
  }
  return out;
}

registerProblemSource("dekit-runners", (s) => runnerProblems(s));
