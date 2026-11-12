import type { MachineSnapshot } from "../../api/types";
import { navigate } from "../../lib/router";
import { registerCommandSource, type Command } from "../../shell/commands";
import { openProjectDialog } from "./dialogs";

// Palette commands of the dekit center (plan §6.3): run a command, add an
// app, reload dekit.yaml, open runners. Imported by the Projects and
// Runners views, so they register when the app loads.

function localRunners(ms: MachineSnapshot | undefined): string[] {
  return ms?.tools.dekit ? ms.runners.map((r) => r.root) : [];
}

function go(runner: string | undefined) {
  navigate(runner ? { view: "projects", runner: { machine: "local", root: runner } } : { view: "projects" });
}

registerCommandSource("dekit", (ctx) => {
  const ms = ctx.snapshot?.machines.find((m) => m.machine.local);
  const runners = localRunners(ms);
  const only = runners.length === 1 ? runners[0] : undefined;
  const out: Command[] = [
    {
      id: "dekit.runners",
      title: "Open runners",
      group: "Actions",
      icon: "layers",
      keywords: ["dekit", "runner", "supervisor"],
      run: () => navigate({ view: "runners" }),
    },
  ];
  if (!ms?.tools.dekit) return out;
  out.push(
    {
      id: "dekit.run-command",
      title: "Run a command…",
      group: "Actions",
      icon: "terminal",
      keywords: ["spawn", "one-off", "migration", "script", "dekit"],
      run: () => {
        go(only);
        openProjectDialog({ kind: "run-command", runner: only });
      },
    },
    {
      id: "dekit.add-app",
      title: "Add an app",
      group: "Actions",
      icon: "plus",
      keywords: ["new", "task", "server", "dekit"],
      run: () => {
        go(only);
        openProjectDialog({ kind: "add-app", runner: only });
      },
    },
  );
  for (const r of ms.runners.filter((x) => x.up)) {
    out.push({
      id: `dekit.reload.${r.root}`,
      title: "Reload dekit.yaml",
      group: "Actions",
      icon: "restart",
      hint: r.name,
      keywords: ["config", "apply", "changes", "dekit", r.root],
      run: () => {
        go(r.root);
        openProjectDialog({ kind: "reload", runner: r.root });
      },
    });
  }
  return out;
});
