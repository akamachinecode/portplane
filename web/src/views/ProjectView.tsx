import { useMemo, useState } from "react";
import type { App, MachineSnapshot, Project } from "../api/types";
import { ProjectIcon } from "../components/AppIcons";
import { IconDialog } from "../components/IconDialog";
import { MachineScope } from "../components/MachineScope";
import { projectIconKey, projectIconPlace } from "../lib/icons";
import { ProjectEditor } from "./projects/ProjectEditor";
import { DekitHelpHost } from "./runners/DekitHelp";
import "./ProjectsView.css";
import { copyWithToast } from "../components/appActions";
import { useApp } from "../components/AppContext";
import { Icon } from "../components/Icon";
import { Menu, type MenuItem } from "../components/Menu";
import { GroupActions, ProjectCard } from "../components/ProjectCard";
import { StateDot } from "../components/StateDot";
import { EmptyState } from "../components/States";
import { useFolds } from "../hooks/useFolds";
import { ViewHeader } from "../components/ViewHeader";
import { indexApps, isVisible, projectApps, serviceCounts, worktreeApps } from "../lib/apps";
import { inferHome, shortenPath } from "../lib/format";
import { appsFingerprint } from "../lib/pending";
import { checkoutsText, findProject, groupState } from "../lib/projects";
import { href, navigate } from "../lib/router";
import { projectTargets } from "../lib/targets";
import { SnapshotGate } from "../shell/SnapshotGate";
import { useShell } from "../shell/ShellContext";
import { entryKey, type ProjectGroup } from "./apps/model";
import "./ProjectView.css";

/**
 * One project (ADR-0027): a git repository with every checkout that has
 * apps, the main one first and then each linked worktree, wherever their
 * tasks are declared; with the project's actions and where its dekit
 * configuration lives.
 */
export function ProjectView() {
  const { route } = useShell();
  return (
    <SnapshotGate>
      {(snapshot) => {
        const found = route.view === "project" ? findProject(snapshot, route) : null;
        if (!found) {
          return (
            <>
              <ViewHeader title={route.view === "project" ? route.name : "Project"} />
              <EmptyState
                icon="box"
                title="This project isn't here any more"
                action={
                  <a className="btn" href={href({ view: "apps" })}>
                    Back to the apps
                  </a>
                }
              >
                Its apps may have been removed from the config, or its folder is no longer watched.
              </EmptyState>
            </>
          );
        }
        return <ProjectBody key={`${found.ms.machine.id}|${found.project.runner}|${found.project.name}`} ms={found.ms} project={found.project} />;
      }}
    </SnapshotGate>
  );
}

function ProjectBody({ ms, project }: { ms: MachineSnapshot; project: Project }) {
  const ctx = useApp();
  const { preferences, route } = useShell();
  const [iconOpen, setIconOpen] = useState(false);
  const folds = useFolds();
  const machine = ms.machine.id;
  const byId = useMemo(() => indexApps(ms.apps), [ms.apps]);
  const apps = projectApps(project, byId);
  const { running, total } = serviceCounts(apps);
  const state = groupState(apps);
  const home = inferHome([...ms.folders, ...ms.runners.map((r) => r.root)]);
  const favorites = useMemo(() => new Set(preferences.status === "ok" ? preferences.value.favorites : []), [preferences]);
  const runners = project.runners?.length ? project.runners : [project.runner];
  const repo = project.repo ?? (project.repos?.length ? undefined : project.worktrees[0]?.path);
  const canAct = !!ms.tools.dekit && (ms.machine.local || ms.machine.status === "online");

  const group: ProjectGroup = {
    key: `${machine}|${project.runner}|${project.name}`,
    project,
    multi: project.worktrees.filter((wt) => worktreeApps(wt, byId).some(isVisible)).length > 1,
    worktrees: project.worktrees
      .map((wt) => ({
        name: wt.name,
        worktree: wt,
        entries: worktreeApps(wt, byId)
          .filter(isVisible)
          .map((app) => {
            const key = entryKey(machine, app.id);
            return { key, ms, app, favorite: favorites.has(key), order: app.order };
          }),
      }))
      .filter((w) => w.entries.length > 0), // a finished install job alone shows nothing
  };

  const restartKey = `project|${machine}|${project.runner}|${project.name}|restart`;
  const menu: MenuItem[] = [];
  if (canAct && running > 0) {
    menu.push({
      label: "Restart everything running",
      icon: "restart",
      onSelect: () =>
        void ctx.pending.run(
          restartKey,
          appsFingerprint(
            machine,
            apps.map((a) => a.id),
          ),
          () => Promise.all(projectTargets(machine, project, byId).map((t) => ctx.api.act(t, "restart"))).then(() => undefined),
        ),
    });
  }
  for (const root of runners) {
    menu.push({ label: runners.length > 1 ? `Edit ${shortenPath(root, home)}/dekit.yaml` : "Edit its dekit configuration", icon: "file", onSelect: () => navigate({ view: "projects", runner: { machine, root } }) });
  }
  if (repo) {
    if (ms.machine.local) menu.push({ label: "Reveal folder", icon: "folder", onSelect: () => void ctx.pending.run(`reveal|${repo}`, null, () => ctx.api.reveal(machine, repo)) });
    menu.push({ label: "Copy folder path", icon: "copy", onSelect: () => void copyWithToast(ctx, repo, "the path") });
  }

  const stateWord = state === "failed" ? "Something failed" : state === "starting" ? "Starting" : running > 0 ? `${running} of ${total} running` : "Nothing running";
  const linked = checkoutsText(project);
  const tab = route.view === "project" ? (route.tab ?? "apps") : "apps";
  const tabRoute = (t: "apps" | "config") => ({ view: "project" as const, machine, name: project.name, ...(route.view === "project" && route.runner ? { runner: route.runner } : {}), ...(t === "config" ? { tab: t } : {}) });
  const meta = [
    repo ? shortenPath(repo, home) : null,
    linked ? (project.repos && project.repos.length > 1 ? linked : `main and ${linked}`) : "main checkout",
    `${total} ${total === 1 ? "app" : "apps"}`,
    !ms.machine.local ? `on ${ms.machine.name}` : null,
  ].filter(Boolean);

  return (
    <>
      <ViewHeader
        title={project.name}
        summary={
          state !== "off" && (
            <span className={`project-state project-state-${state}`}>
              <StateDot state={state} />
              {stateWord}
            </span>
          )
        }
        actions={
          <>
            <GroupActions ms={ms} name={project.name} keyBase={`project|${machine}|${project.runner}|${project.name}|`} apps={apps} targets={projectTargets(machine, project, byId)} withOpen />
            {menu.length > 0 && <Menu label={`More actions for ${project.name}`} items={menu} />}
          </>
        }
      />
      <header className="project-hero">
        <button type="button" className="icon-button" onClick={() => setIconOpen(true)} title="Change the icon" aria-label={`Change the icon of ${project.name}`}>
          <ProjectIcon ms={ms} project={project} size={32} />
        </button>
        {/* the name is the page's title, in the toolbar: here only what it is */}
        <div className="project-hero-text">
          <p className="project-hero-meta">
            {meta.map((m, i) => (
              <span key={i} className={i === 0 && repo ? "mono" : undefined}>
                {m}
              </span>
            ))}
          </p>
        </div>
      </header>
      <nav className="subnav subnav-tabs project-tabs" aria-label={`${project.name} sections`}>
        <ul>
          <li>
            <a className="subnav-item" href={href(tabRoute("apps"))} aria-current={tab === "apps" ? "page" : undefined}>
              <Icon name="apps" size={15} />
              Apps
            </a>
          </li>
          <li>
            <a className="subnav-item" href={href(tabRoute("config"))} aria-current={tab === "config" ? "page" : undefined}>
              <Icon name="file" size={15} />
              Configuration
            </a>
          </li>
        </ul>
      </nav>
      {tab === "apps" ? (
        <>
          <ProjectCard ms={ms} group={group} folds={folds} headless />
        </>
      ) : (
        <ProjectConfig ms={ms} project={project} runners={runners} home={home} apps={apps} />
      )}
      {iconOpen && <IconDialog name={project.name} prefKey={projectIconKey(machine, project)} place={projectIconPlace(ms, project)} root={repo ?? undefined} onClose={() => setIconOpen(false)} />}
    </>
  );
}

/**
 * The project's own tasks in its dekit.yaml files (ADR-0028): the same
 * editor as Settings › dekit › Runners, showing only this project's tasks,
 * with Add an app and Run a command.
 */
function ProjectConfig({ ms, project, runners, home, apps }: { ms: MachineSnapshot; project: Project; runners: string[]; home: string | undefined; apps: App[] }) {
  const reachable = ms.machine.local || ms.machine.status === "online";
  if (!ms.tools.dekit || !reachable) {
    return (
      <EmptyState icon="file" title={reachable ? "dekit isn't installed" : `${ms.machine.name} is offline`}>
        {reachable ? "Install it from Setup to edit this project's tasks here." : "Its configuration shows here again once Portplane reaches it."}
      </EmptyState>
    );
  }
  return (
    <MachineScope machine={ms.machine.id}>
      {runners.map((root) => {
        const runner = ms.runners.find((r) => r.root === root);
        const only = new Set(apps.filter((a) => a.runner === root).map((a) => a.task));
        return (
          <section key={root} className="project-config" aria-label={`${shortenPath(root, home)}/dekit.yaml`}>
            {runners.length > 1 && <h3 className="project-config-title mono">{shortenPath(root, home)}/dekit.yaml</h3>}
            <ProjectEditor runner={root} up={!!runner?.up} os={ms.machine.os} only={only} />
          </section>
        );
      })}
      <p className="project-config-foot">
        <Icon name="info" size={13} />
        Only this project's tasks show here. The whole file, its settings and its runner are in{" "}
        <a href={href({ view: "projects", runner: { machine: ms.machine.id, root: project.runner } })}>Runners</a>.
      </p>
      <DekitHelpHost />
    </MachineScope>
  );
}
