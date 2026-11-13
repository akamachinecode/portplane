import { useState, type ReactNode } from "react";
import { errorText } from "../api/errors";
import { useApp } from "../components/AppContext";
import { MachinePicker, MachineScope, RemoteStatusBanner, useMachineChoice, useMachineScope } from "../components/MachineScope";
import { ConfirmDialog } from "../components/Dialog";
import { Icon } from "../components/Icon";
import { EmptyState, ErrorState, LoadingState } from "../components/States";
import { ViewHeader } from "../components/ViewHeader";
import { inferHome } from "../lib/format";
import { href, navigate } from "../lib/router";
import { Menu, type MenuItem } from "../components/Menu";
import { DekitHelpHost } from "./runners/DekitHelp";
import { RunnerJob, RunnerRow } from "./runners/RunnerList";
import { setRunnerJob, useRunners } from "./runners/useRunners";
import "./RunnersView.css";
import "./projects/commands";

/**
 * Every dekit runner on a machine (plan §4.1): the projects', the host
 * runner as the machine itself, with their state and every runner action,
 * and dekit itself (§4.8). This computer by default; any machine over SSH
 * from the picker (ADR-0026).
 */
export function RunnersView() {
  const { machine, options, choose } = useMachineChoice("runners");
  return (
    <MachineScope machine={machine}>
      <RunnersBody key={machine} picker={<MachinePicker machine={machine} options={options} onChange={choose} />} />
    </MachineScope>
  );
}

function RunnersBody({ picker }: { picker: ReactNode }) {
  const ctx = useApp();
  const scope = useMachineScope();
  const { load, reload } = useRunners();
  const [asking, setAsking] = useState<"clean" | "upgrade" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const local = scope.ms;
  const name = scope.remote ? (local?.machine.name ?? scope.id) : null;
  const home = inferHome([...(local?.folders ?? []), ...(load.status === "ok" ? load.value.runners.map((r) => r.root) : [])]);

  const run = async (what: "clean" | "upgrade") => {
    setBusy(true);
    setError(null);
    try {
      if (what === "clean") {
        await ctx.api.dekitCleanRunners();
        ctx.toast.info("Cleaned the stale runner records");
      } else {
        const job = await ctx.api.dekitUpgradeAll();
        setRunnerJob(scope.id, "*", job.id);
      }
      setAsking(null);
      reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const value = load.status === "ok" ? load.value : null;
  const more: MenuItem[] = [];
  if (value?.available) {
    if (value.stale) more.push({ label: `Clean ${value.stale === 1 ? "one stale record" : `${value.stale} stale records`}…`, icon: "trash", onSelect: () => setAsking("clean") });
    if (value.live) more.push({ label: "Upgrade every runner…", icon: "arrowUp", onSelect: () => setAsking("upgrade") });
    more.push({ label: "About dekit", icon: "info", onSelect: () => navigate({ view: "dekit", machine: scope.remote ? scope.id : undefined }) });
  }
  const actions = (
    <>
      {picker}
      {more.length > 0 && <Menu label="More runner actions" items={more} />}
    </>
  );

  let body;
  if (load.status === "loading") body = <LoadingState label="Reading dekit's runners…" />;
  else if (load.status === "error") body = <ErrorState title="Couldn't list the runners" message={load.message} onRetry={reload} />;
  else if (!load.value.available)
    body = (
      <EmptyState icon="layers" title={name ? `dekit isn't installed on ${name}` : "dekit isn't installed"}>
        Runners are dekit's supervisors, one per project.{" "}
        {name ? (
          <>
            Install it on {name} in its <a href={href({ view: "onboarding", machine: scope.id })}>Setup</a>.
          </>
        ) : (
          <>
            Install it from <a href={href({ view: "onboarding", step: "install" })}>Setup</a>.
          </>
        )}
      </EmptyState>
    );
  else {
    const v = load.value;
    body = (
      <>
        {!v.live && (
          <p className="dk-note">
            <Icon name="info" size={14} /> On Windows dekit can't restart or upgrade a runner in place: stop it and start it again to switch versions.
          </p>
        )}
        <section className="dk-section" aria-labelledby="dk-host-title">
          <h2 className="section-title" id="dk-host-title">
            <Icon name={name ? "machine" : "monitor"} size={14} />
            Machine-wide tasks
          </h2>
          <ul className="dk-runners">
            <RunnerRow runner={v.host} home={home} live={v.live} onChanged={reload} />
          </ul>
        </section>
        <section className="dk-section" aria-labelledby="dk-projects-title">
          <h2 className="section-title" id="dk-projects-title">
            <Icon name="folder" size={14} />
            Folders with a dekit.yaml
          </h2>
          {v.runners.length ? (
            <ul className="dk-runners">
              {v.runners.map((r) => (
                <RunnerRow key={r.root} runner={r} home={home} live={v.live} onChanged={reload} />
              ))}
            </ul>
          ) : (
            <EmptyState icon="layers" title="No runners yet">
              A runner appears for each folder with a <code>dekit.yaml</code>.{" "}
              {name ? (
                <>
                  Set up a folder on {name} in its <a href={href({ view: "onboarding", machine: scope.id })}>Setup</a>.
                </>
              ) : (
                <>
                  Set up a folder in <a href={href({ view: "settings", section: "folders" })}>Settings</a>.
                </>
              )}
            </EmptyState>
          )}
        </section>
      </>
    );
  }

  return (
    <>
      <ViewHeader
        section="dekit"
        title="Runners"
        description={`A runner starts and watches the apps of one folder with a dekit.yaml. Machine-wide tasks, such as a database you always want up, have their own, with its config in your home folder${name ? ` on ${name}` : ""}. Open one to edit its tasks.`}
        actions={actions}
      />
      <RemoteStatusBanner />
      {body}
      {asking === "clean" && (
        <ConfirmDialog open tone="primary" title="Clean stale records?" confirmLabel="Clean records" busy={busy} error={error} onClose={() => setAsking(null)} onConfirm={() => void run("clean")}>
          <p className="dialog-text">
            Removes dekit's records of runners whose process is gone ({value?.stale ?? 0}). Running runners and config files stay as they are.
          </p>
        </ConfirmDialog>
      )}
      {asking === "upgrade" && (
        <ConfirmDialog open tone="primary" title="Upgrade every runner?" confirmLabel="Upgrade all" busy={busy} error={error} onClose={() => setAsking(null)} onConfirm={() => void run("upgrade")}>
          <p className="dialog-text">
            Switches every running runner to the current dekit, in place: tasks keep running. Runners pinned to another binary (a project's <code>kernel:</code>) stay as they are.
          </p>
        </ConfirmDialog>
      )}
      <RunnerJob root="*" />
      <DekitHelpHost />
    </>
  );
}
