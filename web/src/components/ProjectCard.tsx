import type { App, MachineSnapshot, Project, Target, Verb } from "../api/types";
import { projectFoldKey, worktreeFoldKey, type Folds } from "../hooks/useFolds";
import { indexApps, isAlive, projectApps, runningUrls, serviceCounts, worktreeApps } from "../lib/apps";
import { inferHome, shortenPath } from "../lib/format";
import { appsFingerprint } from "../lib/pending";
import { checkoutKey, checkoutName, checkoutsText, foldedByDefault, groupState, projectRoute } from "../lib/projects";
import { href } from "../lib/router";
import { projectTargets, worktreeTargets } from "../lib/targets";
import type { AppEntry, ProjectGroup, WorktreeGroup } from "../views/apps/model";
import { AppRow, type RowExtras } from "./AppRow";
import { useApp } from "./AppContext";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";
import { StateDot } from "./StateDot";
import "./ProjectList.css";

interface GroupActionsProps {
  ms: MachineSnapshot;
  name: string;
  keyBase: string;
  apps: App[];
  targets: Target[];
  withOpen: boolean;
}

/** Open all running, start all, stop all, for a project or a worktree. */
export function GroupActions({ ms, name, keyBase, apps, targets, withOpen }: GroupActionsProps) {
  const { api, pending } = useApp();
  const machine = ms.machine.id;
  const { running, total } = serviceCounts(apps);
  const anyAlive = apps.some((a) => isAlive(a.state));
  const urls = runningUrls(apps, ms.machine);
  const inFlight = pending.has(keyBase + "start") || pending.has(keyBase + "stop");
  const canAct = !!ms.tools.dekit && (ms.machine.local || ms.machine.status === "online");
  const fingerprint = appsFingerprint(
    machine,
    apps.map((a) => a.id),
  );
  const act = (verb: Verb) => pending.run(keyBase + verb, fingerprint, () => Promise.all(targets.map((t) => api.act(t, verb))).then(() => undefined));

  return (
    <div className="group-actions">
      {withOpen && urls.length > 0 && (
        <IconButton
          icon="open"
          label={`Open all running in ${name}`}
          pending={pending.has(keyBase + "open")}
          onClick={() => pending.run(keyBase + "open", null, () => api.open(machine, urls))}
        />
      )}
      <IconButton
        icon="play"
        tone="go"
        label={`Start all in ${name}`}
        disabled={!canAct || (total > 0 && running === total)}
        pending={pending.has(keyBase + "start")}
        busy={inFlight}
        onClick={() => act("start")}
      />
      <IconButton
        icon="stop"
        tone="halt"
        label={`Stop all in ${name}`}
        disabled={!canAct || !anyAlive}
        pending={pending.has(keyBase + "stop")}
        busy={inFlight}
        onClick={() => act("stop")}
      />
    </div>
  );
}

export function Count({ apps }: { apps: App[] }) {
  const { running, total } = serviceCounts(apps);
  return (
    <span className={running > 0 ? "count count-live" : "count"} title={`${running} of ${total} running`}>
      <span className="sr-only">{`${running} of ${total} running`}</span>
      <span aria-hidden="true">
        {running}/{total}
      </span>
    </span>
  );
}

/** The rows of a list of entries. */
export function EntryRows({ entries, extras, showProject, showMachine }: { entries: AppEntry[]; extras?: (e: AppEntry) => RowExtras; showProject?: boolean; showMachine?: boolean }) {
  return (
    <ul className="rows">
      {entries.map((e) => (
        <AppRow key={e.key} app={e.app} ms={e.ms} extras={extras?.(e)} showProject={showProject} showMachine={showMachine} />
      ))}
    </ul>
  );
}

function FoldButton({ folded, label, controls, onToggle }: { folded: boolean; label: string; controls: string; onToggle(): void }) {
  return (
    <button type="button" className="fold" aria-expanded={!folded} aria-controls={controls} aria-label={`${folded ? "Show" : "Hide"} ${label}`} onClick={onToggle}>
      <Icon name="chevronRight" size={13} className="fold-icon" />
    </button>
  );
}

/** A checkout's folder, as short as the machine's home allows. */
function usePath(ms: MachineSnapshot, path: string | undefined): string | undefined {
  if (!path) return undefined;
  const home = inferHome([...ms.folders, ...ms.runners.map((r) => r.root)]);
  return shortenPath(path, home);
}

function CheckoutSection({
  ms,
  project,
  group,
  byId,
  multi,
  extras,
  folds,
  forceOpen,
  only,
}: {
  ms: MachineSnapshot;
  project: Project;
  group: WorktreeGroup;
  /** The only checkout shown: open unless the user folded it. */
  only?: boolean;
  byId: Map<string, App>;
  multi: boolean;
  extras?: (e: AppEntry) => RowExtras;
  folds?: Folds;
  forceOpen?: boolean;
}) {
  const wt = group.worktree;
  const apps = worktreeApps(wt, byId);
  const linked = !!wt.name;
  const name = checkoutName(project, wt);
  const foldKey = worktreeFoldKey(ms.machine.id, project.runner, project.name, checkoutKey(wt));
  // A linked worktree always says which it is; the main checkout only next
  // to others. Only a checkout with a header can fold: there'd be no way back.
  const head = multi || linked;
  const folded = head && !forceOpen && !!folds?.isFolded(foldKey, !only && foldedByDefault(wt, byId));
  const path = usePath(ms, wt.path);
  const listId = `rows-${foldKey}`.replace(/[^\w-]/g, "_");
  const showBranch = wt.branch && wt.branch !== wt.name;
  return (
    <div className={`checkout${folded ? " is-folded" : ""}${linked || (project.repos?.length ?? 0) > 1 ? " is-linked" : ""}`}>
      {head && (
        <div className="checkout-head">
          {folds && <FoldButton folded={folded} label={`the apps of ${name}`} controls={listId} onToggle={() => folds.setFolded(foldKey, !folded)} />}
          <Icon name="branch" size={13} className="checkout-icon" />
          <span className="checkout-name" title={wt.prefix || undefined}>
            {name}
          </span>
          {showBranch && (
            <span className="branch-chip" title="The branch it has out">
              {wt.branch}
            </span>
          )}
          {path && (
            <span className="checkout-path" title={wt.path}>
              {path}
            </span>
          )}
          <span className="spacer" />
          <Count apps={apps} />
          <GroupActions
            ms={ms}
            name={`${project.name} (${name})`}
            keyBase={`wt|${ms.machine.id}|${project.runner}|${project.name}|${checkoutKey(wt)}|`}
            apps={apps}
            targets={worktreeTargets(ms.machine.id, project, wt, byId)}
            withOpen={false}
          />
        </div>
      )}
      {!folded && (
        <div id={listId}>
          <EntryRows entries={group.entries} extras={extras} />
        </div>
      )}
    </div>
  );
}

/**
 * A project in a list: its name, state, counts and group actions over all
 * its apps, and the rows the view shows (filtered and sorted), by checkout:
 * the main one first, then each linked worktree, folded while idle.
 */
export function ProjectCard({
  ms,
  group,
  extras,
  folds,
  forceOpen,
  headless,
}: {
  ms: MachineSnapshot;
  group: ProjectGroup;
  extras?: (e: AppEntry) => RowExtras;
  /** Lets the user fold the project and its worktrees. */
  folds?: Folds;
  /** Filters are on: show every match. */
  forceOpen?: boolean;
  /** The project page: no project row, just the checkouts. */
  headless?: boolean;
}) {
  const { project } = group;
  const byId = indexApps(ms.apps);
  const apps = projectApps(project, byId);
  const state = groupState(apps);
  const foldKey = projectFoldKey(ms.machine.id, project.runner, project.name);
  const folded = !headless && !forceOpen && !!folds?.isFolded(foldKey, false);
  const headingId = `p-${ms.machine.id}-${project.runner}-${project.name}`.replace(/[^\w-]/g, "_");
  const listId = `${headingId}-list`;
  const meta = checkoutsText(project);
  const body = !folded && (
    <div className="project-body" id={listId}>
      {group.worktrees.map((wt) => (
        <CheckoutSection
          key={checkoutKey(wt.worktree)}
          ms={ms}
          project={project}
          group={wt}
          byId={byId}
          multi={group.multi}
          extras={extras}
          folds={folds}
          forceOpen={forceOpen}
          only={group.worktrees.length === 1}
        />
      ))}
    </div>
  );
  if (headless) return <div className="project project-headless">{body}</div>;
  return (
    <article className={`project project-${state}${folded ? " is-folded" : ""}`} aria-labelledby={headingId}>
      <header className="project-head">
        {folds && <FoldButton folded={folded} label={`the apps of ${project.name}`} controls={listId} onToggle={() => folds.setFolded(foldKey, !folded)} />}
        <StateDot state={state} />
        <h3 className="project-title" id={headingId}>
          <a href={href(projectRoute(ms, project))} title={`Open ${project.name}: its worktrees, apps and configuration`}>
            {project.name}
          </a>
        </h3>
        {meta && <span className="project-meta">{meta}</span>}
        <span className="spacer" />
        <Count apps={apps} />
        <GroupActions
          ms={ms}
          name={project.name}
          keyBase={`project|${ms.machine.id}|${project.runner}|${project.name}|`}
          apps={apps}
          targets={projectTargets(ms.machine.id, project, byId)}
          withOpen
        />
      </header>
      {body}
    </article>
  );
}
