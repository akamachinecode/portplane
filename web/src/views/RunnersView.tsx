import type { MachineSnapshot } from "../api/types";
import { runnerKey, startRunner } from "../components/appActions";
import { useApp } from "../components/AppContext";
import { Icon, Spinner } from "../components/Icon";
import { EmptyState } from "../components/States";
import { StateDot } from "../components/StateDot";
import { ViewHeader } from "../components/ViewHeader";
import { indexApps, projectApps, serviceCounts } from "../lib/apps";
import { inferHome, shortenPath } from "../lib/format";
import { href } from "../lib/router";
import { SnapshotGate } from "../shell/SnapshotGate";
import "./RunnersView.css";

function MachineRunners({ ms }: { ms: MachineSnapshot }) {
  const ctx = useApp();
  const machine = ms.machine;
  const home = inferHome([...ms.folders, ...ms.runners.map((r) => r.root)]);
  const byId = indexApps(ms.apps);
  const live = machine.local || machine.status === "online";
  return (
    <section className="runners-machine" aria-labelledby={`runners-${machine.id}`}>
      <h2 className="section-title" id={`runners-${machine.id}`}>
        <Icon name="machine" size={14} />
        {machine.name}
      </h2>
      {!live ? (
        <p className="muted runners-note">Not connected: its runners show once it's back online.</p>
      ) : !ms.tools.dekit ? (
        <p className="muted runners-note">
          dekit isn't installed on this machine. <a href={href({ view: "health" })}>See Health</a>
        </p>
      ) : ms.runners.length === 0 ? (
        <p className="muted runners-note">No dekit.yaml in its folders.</p>
      ) : (
        <ul className="runner-rows">
          {ms.runners.map((r) => {
            const apps = ms.projects.filter((p) => p.runner === r.root).flatMap((p) => projectApps(p, byId));
            const { running, total } = serviceCounts(apps);
            const busy = ctx.pending.has(runnerKey(machine.id, r.root));
            return (
              <li key={r.root} className={`runner-row${r.up ? "" : " is-down"}`}>
                <StateDot state={r.up ? (r.error ? "failed" : "on") : "off"} />
                <div className="runner-row-text">
                  <a className="runner-row-name" href={href({ view: "projects", runner: { machine: machine.id, root: r.root } })}>
                    {r.name}
                  </a>
                  <span className="runner-row-path mono">{shortenPath(r.root, home)}</span>
                  {r.error && <span className="runner-row-error">{r.error}</span>}
                </div>
                <span className="runner-row-state">{r.up ? "Up" : "Down"}</span>
                <span className="runner-row-apps" title={`${running} of ${total} apps running`}>
                  {running}/{total}
                  <span className="sr-only"> apps running</span>
                </span>
                <span className="runner-row-action">
                  {!r.up && (
                    <button type="button" className="btn btn-sm" aria-busy={busy || undefined} disabled={busy} onClick={() => void startRunner(ctx, machine.id, r.root)}>
                      {busy ? <Spinner size={12} /> : <Icon name="play" size={12} />}
                      Start
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** dekit's runners, one per project folder, with up or down (plan §4.1; the full controls come in M5.3). */
export function RunnersView() {
  return (
    <>
      <ViewHeader title="Runners" description="dekit runs one supervisor per project folder. An app can only start while its runner is up." />
      <SnapshotGate>
        {(snapshot) =>
          snapshot.machines.some((ms) => ms.runners.length > 0) ? (
            snapshot.machines.map((ms) => <MachineRunners key={ms.machine.id} ms={ms} />)
          ) : (
            <EmptyState icon="layers" title="No runners yet">
              A runner appears for each folder with a <code>dekit.yaml</code>. Set up a folder in <a href={href({ view: "settings", section: "folders" })}>Settings</a>.
            </EmptyState>
          )
        }
      </SnapshotGate>
    </>
  );
}
