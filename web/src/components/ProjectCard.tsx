import type { App, MachineSnapshot, Project, Target, Verb, Worktree } from "../api/types";
import { isAlive, projectApps, runningUrls, serviceCounts, visibleApps, worktreeApps } from "../lib/apps";
import { appsFingerprint } from "../lib/pending";
import { projectTarget, worktreeTarget } from "../lib/targets";
import { AppRow } from "./AppRow";
import { useApp } from "./AppContext";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";

interface GroupActionsProps {
  ms: MachineSnapshot;
  name: string;
  keyBase: string;
  apps: App[];
  target: Target;
  withOpen: boolean;
}

/** Open all running, start all, stop all, for a project or a worktree. */
function GroupActions({ ms, name, keyBase, apps, target, withOpen }: GroupActionsProps) {
  const { api, pending } = useApp();
  const machine = ms.machine.id;
  const { running, total } = serviceCounts(apps);
  const anyAlive = apps.some((a) => isAlive(a.state));
  const urls = runningUrls(apps, ms.machine);
  const inFlight = pending.has(keyBase + "start") || pending.has(keyBase + "stop");
  const fingerprint = appsFingerprint(
    machine,
    apps.map((a) => a.id),
  );
  const act = (verb: Verb) => pending.run(keyBase + verb, fingerprint, () => api.act(target, verb));

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
        disabled={total > 0 && running === total}
        pending={pending.has(keyBase + "start")}
        busy={inFlight}
        onClick={() => act("start")}
      />
      <IconButton
        icon="stop"
        tone="halt"
        label={`Stop all in ${name}`}
        disabled={!anyAlive}
        pending={pending.has(keyBase + "stop")}
        busy={inFlight}
        onClick={() => act("stop")}
      />
    </div>
  );
}

function Count({ apps }: { apps: App[] }) {
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

function WorktreeGroup({ ms, project, wt, byId, multi }: { ms: MachineSnapshot; project: Project; wt: Worktree; byId: Map<string, App>; multi: boolean }) {
  const apps = worktreeApps(wt, byId);
  const visible = visibleApps(apps);
  const name = wt.name || "main";
  if (visible.length === 0 && multi) return null;
  return (
    <div className="wt">
      {multi && (
        <div className="wt-head">
          <Icon name="branch" size={14} className="wt-icon" />
          <span className="wt-name" title={wt.prefix || undefined}>
            {name}
          </span>
          <Count apps={apps} />
          <GroupActions
            ms={ms}
            name={`${project.name} (${name})`}
            keyBase={`wt|${ms.machine.id}|${project.runner}|${project.name}|${wt.name}|`}
            apps={apps}
            target={worktreeTarget(ms.machine.id, project, wt, byId)}
            withOpen={false}
          />
        </div>
      )}
      {visible.length > 0 ? (
        <ul className="rows">
          {visible.map((app) => (
            <AppRow key={app.id} app={app} ms={ms} />
          ))}
        </ul>
      ) : (
        <p className="rows-empty">Only setup steps here, and none is running.</p>
      )}
    </div>
  );
}

export function ProjectCard({ ms, project, byId }: { ms: MachineSnapshot; project: Project; byId: Map<string, App> }) {
  const apps = projectApps(project, byId);
  const multi = project.worktrees.length > 1;
  const live = apps.some((a) => a.kind !== "job" && a.state === "on");
  const failed = apps.some((a) => a.state === "failed");
  const headingId = `p-${ms.machine.id}-${project.runner}-${project.name}`.replace(/[^\w-]/g, "_");
  return (
    <article className={`card${live ? " card-live" : ""}${failed ? " card-failed" : ""}`} aria-labelledby={headingId}>
      <header className="card-head">
        <h3 className="card-title" id={headingId}>
          {project.name}
        </h3>
        <Count apps={apps} />
        <GroupActions
          ms={ms}
          name={project.name}
          keyBase={`project|${ms.machine.id}|${project.runner}|${project.name}|`}
          apps={apps}
          target={projectTarget(ms.machine.id, project, byId)}
          withOpen
        />
      </header>
      {project.worktrees.map((wt) => (
        <WorktreeGroup key={wt.name} ms={ms} project={project} wt={wt} byId={byId} multi={multi} />
      ))}
    </article>
  );
}
