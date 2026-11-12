import { useMemo } from "react";
import type { App, MachineSnapshot, Project, Runner, Snapshot } from "../api/types";
import { runnerKey, startRunner } from "../components/appActions";
import { useApp } from "../components/AppContext";
import { Icon, Spinner } from "../components/Icon";
import { EmptyState } from "../components/States";
import { StateDot } from "../components/StateDot";
import { ViewHeader } from "../components/ViewHeader";
import { indexApps, projectApps, serviceCounts, visibleApps, worktreeApps } from "../lib/apps";
import { inferHome, shortenPath, stateLabel } from "../lib/format";
import { appRoute, href, navigate } from "../lib/router";
import { SnapshotGate } from "../shell/SnapshotGate";
import { useShell } from "../shell/ShellContext";
import "./ProjectsView.css";

interface RunnerEntry {
  ms: MachineSnapshot;
  runner: Runner;
  projects: Project[];
  apps: App[];
  home: string | undefined;
}

/** Every dekit runner (one per dekit.yaml) on every machine that can tell. */
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
          <span className="runner-link-name">{runner.name}</span>
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
  const byId = useMemo(() => indexApps(ms.apps), [ms.apps]);
  const multi = project.worktrees.length > 1;
  return (
    <section className="proj" aria-label={project.name}>
      <header className="proj-head">
        <h3 className="proj-name">{project.name}</h3>
        <Counts apps={projectApps(project, byId)} />
      </header>
      {project.worktrees.map((wt) => {
        const apps = visibleApps(worktreeApps(wt, byId));
        return (
          <div key={wt.name} className="proj-wt">
            {multi && (
              <p className="proj-wt-name">
                <Icon name="branch" size={13} />
                {wt.name || "main"}
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

function RunnerDetail({ entry }: { entry: RunnerEntry }) {
  const ctx = useApp();
  const { ms, runner, projects } = entry;
  const local = ms.machine.local;
  const busy = ctx.pending.has(runnerKey(ms.machine.id, runner.root));
  return (
    <section className="runner-detail" aria-labelledby="runner-detail-title">
      <a className="back-link" href={href({ view: "projects" })}>
        <Icon name="chevronLeft" size={14} />
        All projects
      </a>
      <header className="runner-detail-head">
        <div>
          <h2 className="runner-detail-title" id="runner-detail-title">
            {runner.name}
          </h2>
          <p className="runner-detail-path mono">{shortenPath(runner.root, entry.home)}</p>
        </div>
        <div className="runner-detail-actions">
          {!runner.up && ms.tools.dekit && (
            <button type="button" className="btn btn-primary" aria-busy={busy || undefined} disabled={busy} onClick={() => void startRunner(ctx, ms.machine.id, runner.root)}>
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

      {projects.length ? projects.map((p) => <ProjectBlock key={p.name} ms={ms} project={p} />) : <p className="muted">No tasks in this dekit.yaml yet.</p>}

      <section className="config-soon" aria-labelledby="config-soon-title">
        <h3 id="config-soon-title" className="config-soon-title">
          <Icon name="pencil" size={14} />
          Configuration <span className="tag">soon</span>
        </h3>
        <p className="muted">
          A later version edits this project's <code>dekit.yaml</code> here: tasks, shared settings and what loads from where, always with
          a preview of the change. Until then, edit it in your editor.
        </p>
      </section>
    </section>
  );
}

function Body({ snapshot }: { snapshot: Snapshot }) {
  const { route } = useShell();
  const { openSetup } = useApp();
  const entries = useMemo(() => runnerEntries(snapshot), [snapshot]);
  const sel = route.view === "projects" ? route.runner : undefined;
  const selected = sel && entries.find((e) => e.ms.machine.id === sel.machine && e.runner.root === sel.root);
  const multiMachine = new Set(entries.map((e) => e.ms.machine.id)).size > 1;

  if (entries.length === 0) {
    const local = snapshot.machines.find((m) => m.machine.local);
    const folder = local?.folders[0];
    return (
      <EmptyState
        icon="box"
        title="No dekit projects yet"
        action={
          <button type="button" className="btn btn-primary" onClick={() => (folder ? openSetup(folder) : navigate({ view: "settings", section: "folders" }))}>
            <Icon name="wand" size={14} />
            {folder ? "Set up a folder" : "Add a folder"}
          </button>
        }
      >
        A project is a folder with a <code>dekit.yaml</code>. Setup finds your apps and writes one for you.
      </EmptyState>
    );
  }

  return (
    <div className={`projects-layout${sel ? " has-selection" : ""}`}>
      <ul className="runner-list" aria-label="dekit projects">
        {entries.map((e) => (
          <RunnerLink key={`${e.ms.machine.id}|${e.runner.root}`} entry={e} current={selected === e} multiMachine={multiMachine} />
        ))}
      </ul>
      <div className="projects-detail">
        {selected ? (
          <RunnerDetail entry={selected} />
        ) : sel ? (
          <EmptyState icon="box" title="This project isn't there any more">
            <a href={href({ view: "projects" })}>See all projects</a>
          </EmptyState>
        ) : (
          <EmptyState icon="arrowRight" title="Pick a project">
            Its apps, worktrees and dekit runner show here.
          </EmptyState>
        )}
      </div>
    </div>
  );
}

/** dekit projects and their runners (plan §6.2; the editor comes in M5.3). */
export function ProjectsView() {
  return (
    <>
      <ViewHeader title="Projects" description="Each dekit.yaml Portplane reads, and the apps it defines." />
      <SnapshotGate>{(snapshot) => <Body snapshot={snapshot} />}</SnapshotGate>
    </>
  );
}
