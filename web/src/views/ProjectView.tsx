import { useMemo } from "react";
import type { MachineSnapshot, Project } from "../api/types";
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
  const { preferences } = useShell();
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

  return (
    <>
      <ViewHeader
        title={project.name}
        summary={
          <span className={`project-state project-state-${state}`}>
            <StateDot state={state} />
            {stateWord}
          </span>
        }
        actions={
          <>
            <GroupActions ms={ms} name={project.name} keyBase={`project|${machine}|${project.runner}|${project.name}|`} apps={apps} targets={projectTargets(machine, project, byId)} withOpen />
            {menu.length > 0 && <Menu label={`More actions for ${project.name}`} items={menu} />}
          </>
        }
      />
      <dl className="project-facts">
        {repo && (
          <div>
            <dt>Folder</dt>
            <dd className="mono" title={repo}>
              {shortenPath(repo, home)}
            </dd>
          </div>
        )}
        {project.repos && project.repos.length > 1 && (
          <div>
            <dt>Repositories</dt>
            <dd className="mono" title={project.repos.join("\n")}>
              {project.repos.map((r) => shortenPath(r, home)).join(", ")}
            </dd>
          </div>
        )}
        <div>
          <dt>Checkouts</dt>
          <dd>{linked ? (project.repos && project.repos.length > 1 ? linked : `main and ${linked}`) : "main only"}</dd>
        </div>
        <div>
          <dt>Apps</dt>
          <dd>
            {total} {total === 1 ? "app" : "apps"}
          </dd>
        </div>
        <div>
          <dt>Configured in</dt>
          <dd>
            {runners.map((root, i) => (
              <span key={root}>
                {i > 0 && ", "}
                <a href={href({ view: "projects", runner: { machine, root } })} className="mono">
                  {shortenPath(root, home)}/dekit.yaml
                </a>
              </span>
            ))}
          </dd>
        </div>
        {!ms.machine.local && (
          <div>
            <dt>Machine</dt>
            <dd>{ms.machine.name}</dd>
          </div>
        )}
      </dl>
      {project.worktrees.length > 1 && (
        <p className="project-hint">
          <Icon name="branch" size={13} />
          Each worktree is a checkout of the same repository on another branch, with its own apps and addresses.
        </p>
      )}
      <ProjectCard ms={ms} group={group} folds={folds} headless />
    </>
  );
}
