import { useEffect, useMemo } from "react";
import type { App, MachineSnapshot, Project, Runner, Snapshot } from "../api/types";
import { appKey, runnerKey, startRunner } from "../components/appActions";
import { useApp } from "../components/AppContext";
import { MachineScope } from "../components/MachineScope";
import { Icon, Spinner } from "../components/Icon";
import { EmptyState } from "../components/States";
import { StateDot } from "../components/StateDot";
import { ViewHeader } from "../components/ViewHeader";
import { indexApps, projectApps, serviceCounts, visibleApps, worktreeApps } from "../lib/apps";
import { inferHome, shortenPath, stateLabel } from "../lib/format";
import { appsFingerprint } from "../lib/pending";
import { checkoutKey, checkoutName } from "../lib/projects";
import { projectTargets } from "../lib/targets";
import { appRoute, href, navigate } from "../lib/router";
import { SnapshotGate } from "../shell/SnapshotGate";
import { useShell } from "../shell/ShellContext";
import "./ProjectsView.css";
import { useProjectDialog } from "./projects/dialogs";
import { ProjectEditor } from "./projects/ProjectEditor";
import "./projects/commands";

interface RunnerEntry {
  ms: MachineSnapshot;
  runner: Runner;
  projects: Project[];
  apps: App[];
  home: string | undefined;
}

/** Every dekit runner (one per dekit.yaml) on every machine that can tell. */
/** A project's own folder name ("shop"), the runner's name being its path. */
export function folderName(root: string): string {
  return root.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || root;
}

export function runnerEntries(snapshot: Snapshot): RunnerEntry[] {
  return snapshot.machines.flatMap((ms) => {
    if (!ms.machine.local && ms.machine.status !== "online") return [];
    const byId = indexApps(ms.apps);
    const home = inferHome([...ms.folders, ...ms.runners.map((r) => r.root)]);
    return ms.runners.map((runner) => {
      const projects = ms.projects.filter((p) => p.runner === runner.root);
      return { ms, runner, projects, apps: projects.flatMap((p) => projectApps(p, byId)), home };
    });
  });
}

function Counts({ apps }: { apps: App[] }) {
  const { running, total } = serviceCounts(apps);
  return (
    <span className={running > 0 ? "count count-live" : "count"}>
      {running}/{total}
      <span className="sr-only"> running</span>
    </span>
  );
}

function RunnerLink({ entry, current, multiMachine }: { entry: RunnerEntry; current: boolean; multiMachine: boolean }) {
  const { ms, runner, projects, apps } = entry;
  const failed = apps.some((a) => a.state === "failed");
  return (
    <li>
      <a className="runner-link" href={href({ view: "projects", runner: { machine: ms.machine.id, root: runner.root } })} aria-current={current ? "page" : undefined}>
        <StateDot state={!runner.up ? "off" : failed ? "failed" : apps.some((a) => a.state === "on") ? "on" : "off"} />
        <span className="runner-link-text">
          <span className="runner-link-name">{folderName(runner.root)}</span>
          <span className="runner-link-path mono">{shortenPath(runner.root, entry.home)}</span>
        </span>
        <span className="runner-link-meta">
          {multiMachine && <span className="runner-link-machine">{ms.machine.name}</span>}
          <span>
            {projects.length} {projects.length === 1 ? "project" : "projects"}
          </span>
          <Counts apps={apps} />
        </span>
      </a>
    </li>
  );
}

function ProjectBlock({ ms, project }: { ms: MachineSnapshot; project: Project }) {
  const ctx = useApp();
  const byId = useMemo(() => indexApps(ms.apps), [ms.apps]);
  const multi = project.worktrees.length > 1;
  const apps = projectApps(project, byId);
  const key = `project|${ms.machine.id}|${project.runner}|${project.name}|restart`;
  const busy = ctx.pending.has(key) || apps.some((a) => ctx.pending.hasPrefix(appKey(ms.machine.id, a)));
  const canAct = !!ms.tools.dekit && (ms.machine.local || ms.machine.status === "online") && project.running > 0;
  return (
    <section className="proj" aria-label={project.name}>
      <header className="proj-head">
        <h3 className="proj-name">{project.name}</h3>
        <Counts apps={apps} />
        <span className="spacer" />
        {canAct && (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={busy}
            aria-busy={ctx.pending.has(key) || undefined}
            title="Restarts the apps of this project that are running"
            onClick={() => void ctx.pending.run(key, appsFingerprint(ms.machine.id, apps.map((a) => a.id)), () => Promise.all(projectTargets(ms.machine.id, project, byId).map((t) => ctx.api.act(t, "restart"))).then(() => undefined))}
          >
            {ctx.pending.has(key) ? <Spinner size={12} /> : <Icon name="restart" size={13} />}
            Restart all
          </button>
        )}
      </header>
      {project.worktrees.map((wt) => {
        const apps = visibleApps(worktreeApps(wt, byId));
        return (
          <div key={checkoutKey(wt)} className="proj-wt">
            {multi && (
              <p className="proj-wt-name">
                <Icon name="branch" size={13} />
                {checkoutName(project, wt)}
              </p>
            )}
            {apps.length ? (
              <ul className="proj-apps">
                {apps.map((a) => (
                  <li key={a.id}>
                    <a className="proj-app" href={href(appRoute(ms.machine.id, a.id))}>
                      <StateDot state={a.state} />
                      <span className="proj-app-name">{a.label}</span>
                      <span className="proj-app-state">{stateLabel(a.state)}</span>
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted proj-empty">Only setup steps, none running.</p>
            )}
          </div>
        );
      })}
    </section>
  );
}

function ProjectBlocks({ ms, projects }: { ms: MachineSnapshot; projects: Project[] }) {
  return projects.length ? (
    <div className="proj-blocks">
      {projects.map((p) => (
        <ProjectBlock key={p.name} ms={ms} project={p} />
      ))}
    </div>
  ) : (
    <p className="muted">No tasks in this dekit.yaml yet.</p>
  );
}

/** A machine's own runner (machine-wide tasks), at #/projects/<machine>/host. */
function HostDetail({ ms }: { ms: MachineSnapshot }) {
  const name = ms.machine.local ? "This computer" : ms.machine.name;
  return (
    <MachineScope machine={ms.machine.id}>
      <section className="runner-detail" aria-labelledby="runner-detail-title">
        <a className="back-link" href={href({ view: "runners", machine: ms.machine.local ? undefined : ms.machine.id })}>
          <Icon name="chevronLeft" size={14} />
          Runners
        </a>
        <header className="runner-detail-head">
          <div>
            <h2 className="runner-detail-title" id="runner-detail-title">
              {name}
            </h2>
            <p className="runner-detail-path mono">~/.config/dekit/host/dekit.yaml{ms.machine.local ? "" : ` on ${ms.machine.name}`}</p>
          </div>
        </header>
        <p className="runner-detail-status">Tasks that are yours rather than a project's, such as a database you always want up.</p>
        <ProjectEditor runner="host" up />
      </section>
    </MachineScope>
  );
}

function RunnerDetail({ entry }: { entry: RunnerEntry }) {
  const ctx = useApp();
  const { ms, runner, projects } = entry;
  const local = ms.machine.local;
  // Any machine Portplane reaches: a remote one's config travels over SSH (ADR-0026).
  const reachable = local || ms.machine.status === "online";
  const busy = ctx.pending.has(runnerKey(ms.machine.id, runner.root));
  return (
    <MachineScope machine={ms.machine.id}>
      <section className="runner-detail" aria-labelledby="runner-detail-title">
        <a className="back-link" href={href({ view: "runners", machine: local ? undefined : ms.machine.id })}>
          <Icon name="chevronLeft" size={14} />
          Runners
        </a>
        <header className="runner-detail-head">
          <div>
            <h2 className="runner-detail-title" id="runner-detail-title">
              {folderName(runner.root)}/dekit.yaml
            </h2>
            <p className="runner-detail-path mono">{shortenPath(runner.root, entry.home)}</p>
          </div>
          <div className="runner-detail-actions">
            {!runner.up && ms.tools.dekit && (
              <button type="button" className="btn" aria-busy={busy || undefined} disabled={busy} onClick={() => void startRunner(ctx, ms.machine.id, runner.root)}>
                {busy ? <Spinner /> : <Icon name="play" size={13} />}
                Start runner
              </button>
            )}
            {local && (
              <button type="button" className="btn" onClick={() => void ctx.pending.run(`reveal|${runner.root}`, null, () => ctx.api.reveal(ms.machine.id, runner.root))}>
                <Icon name="folder" size={14} />
                Reveal folder
              </button>
            )}
          </div>
        </header>
        <p className="runner-detail-status">
          <StateDot state={runner.up ? "on" : "off"} />
          {runner.up ? "dekit is running for this folder" : "dekit isn't running for this folder: its apps can't start until it is"}
          {runner.error && <span className="runner-error"> · {runner.error}</span>}
        </p>

        {reachable && ms.tools.dekit ? (
          <ProjectEditor runner={runner.root} up={runner.up} os={ms.machine.os} />
        ) : (
          <>
            <ProjectBlocks ms={ms} projects={projects} />
            {!reachable && <p className="muted config-note">{ms.machine.name} is offline: its configuration shows here again once Portplane reaches it.</p>}
          </>
        )}
      </section>
    </MachineScope>
  );
}

function Body({ snapshot }: { snapshot: Snapshot }) {
  const { route } = useShell();
  const { openSetup } = useApp();
  const entries = useMemo(() => runnerEntries(snapshot), [snapshot]);
  const sel = route.view === "projects" ? route.runner : undefined;
  const selected = sel && entries.find((e) => e.ms.machine.id === sel.machine && e.runner.root === sel.root);
  const multiMachine = new Set(entries.map((e) => e.ms.machine.id)).size > 1;
  const dialog = useProjectDialog();
  // Every machine with dekit has its own runner for machine-wide tasks.
  const hostMachines = snapshot.machines.filter((m) => !!m.tools.dekit && (m.machine.local || m.machine.status === "online"));
  const hostMs = sel?.root === "host" ? hostMachines.find((m) => m.machine.id === sel.machine) : undefined;
  const host = !!hostMs;

  // Nothing picked and no dialog asking which one: the list lives on Runners.
  useEffect(() => {
    if (sel || dialog) return;
    navigate({ view: "runners" }, { replace: true });
  }, [sel, dialog]);

  if (entries.length === 0 && !host) {
    const local = snapshot.machines.find((m) => m.machine.local);
    const folder = local?.folders[0];
    return (
      <EmptyState
        icon="box"
        title="No dekit.yaml yet"
        action={
          <button type="button" className="btn btn-primary" onClick={() => (folder ? openSetup(folder) : navigate({ view: "settings", section: "folders" }))}>
            <Icon name="wand" size={14} />
            {folder ? "Set up a folder" : "Add a folder"}
          </button>
        }
      >
        dekit reads its tasks from a <code>dekit.yaml</code>. Setup finds the apps in your folders and writes one for you.
      </EmptyState>
    );
  }

  if (hostMs) return <HostDetail ms={hostMs} />;
  if (selected) return <RunnerDetail entry={selected} />;
  if (sel) {
    return (
      <EmptyState icon="box" title="This dekit.yaml isn't there any more">
        <a href={href({ view: "runners" })}>See every runner</a>
      </EmptyState>
    );
  }
  // A palette command asks which dekit.yaml to use.
  return (
    <section aria-labelledby="pick-title">
      <h2 className="sgroup-title" id="pick-title">
        {dialog?.kind === "add-app" ? "Which project gets the new app?" : "Where should the command run?"}
      </h2>
      <ul className="runner-list runner-pick" aria-label="dekit.yaml files">
        {entries.map((e) => (
          <RunnerLink key={`${e.ms.machine.id}|${e.runner.root}`} entry={e} current={false} multiMachine={multiMachine} />
        ))}
        {hostMachines.map((m) => (
          <li key={`host|${m.machine.id}`}>
            <a className="runner-link" href={href({ view: "projects", runner: { machine: m.machine.id, root: "host" } })}>
              <Icon name={m.machine.local ? "monitor" : "machine"} size={14} />
              <span className="runner-link-text">
                <span className="runner-link-name">{m.machine.local ? "This computer" : m.machine.name}</span>
                <span className="runner-link-path mono">machine-wide tasks</span>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * One dekit.yaml and its runner (plan §4.5, ADR-0028): Settings › dekit ›
 * Runners › a folder. Its tasks as forms or YAML, its settings, and every
 * change as a diff before it is written. A project's own tasks are also on
 * the project's page.
 */
export function ProjectsView() {
  return (
    <>
      <ViewHeader section="dekit" title="Configuration" description="Edit a task with a form or as YAML; every change shows as a diff before it is written, and dekit picks it up when you reload." />
      <SnapshotGate>{(snapshot) => <Body snapshot={snapshot} />}</SnapshotGate>
    </>
  );
}
