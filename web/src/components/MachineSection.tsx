import { useMemo } from "react";
import type { MachineSnapshot } from "../api/types";
import type { Folds } from "../hooks/useFolds";
import { inferHome } from "../lib/format";
import { navigate } from "../lib/router";
import type { AppEntry, ProjectGroup } from "../views/apps/model";
import { useApp } from "./AppContext";
import type { RowExtras } from "./AppRow";
import { FirstRun, NoApps } from "./EmptyStates";
import { Icon, Spinner } from "./Icon";
import { Menu } from "./Menu";
import { OtherPorts } from "./OtherPorts";
import { ProjectCard } from "./ProjectCard";
import { StateDot } from "./StateDot";

const STATUS_LABEL = { online: "Online", connecting: "Connecting", offline: "Offline" } as const;

export interface MachineBodyProps {
  ms: MachineSnapshot;
  /** The projects to show, filtered and sorted (views/apps/model.ts). */
  projects: ProjectGroup[];
  /** Filters are on: an empty machine says nothing, other ports stay out. */
  filtering: boolean;
  /** Renders the projects (cards, or the table's rows). */
  renderProjects(projects: ProjectGroup[]): React.ReactNode;
  /** More than one machine: name this one above its projects. */
  showHeader?: boolean;
}

/** What a machine with no app to show says instead (first run, no dekit.yaml). */
function EmptyBody({ ms }: { ms: MachineSnapshot }) {
  const { openEditMachine } = useApp();
  if (ms.folders.length === 0) {
    if (ms.machine.local) return <FirstRun />;
    return (
      <div className="remote-empty">
        <p className="muted">No folders are watched on this machine yet, so only its open ports show.</p>
        <button type="button" className="btn btn-sm" onClick={() => openEditMachine(ms.machine.id)}>
          <Icon name="folder" size={14} />
          Add folders
        </button>
      </div>
    );
  }
  // Without dekit, or with runners that are down, Health says why.
  if (ms.apps.length > 0 || !ms.tools.dekit || ms.runners.length > 0) return null;
  return <NoApps ms={ms} />;
}

/** One line on a remote machine that is not online; Health has the details (ADR-0015). */
function RemoteStatus({ ms }: { ms: MachineSnapshot }) {
  const { machine } = ms;
  if (machine.status === "offline") return <p className="machine-note">Portplane keeps trying to reach it in the background.</p>;
  return (
    <p className="machine-note">
      <Spinner /> {machine.error ? "Reconnecting over SSH…" : "Connecting over SSH…"}
    </p>
  );
}

/** A machine in the Apps view: its name and state, its projects, and its other ports. */
export function MachineSection({ ms, projects, filtering, renderProjects, showHeader = true }: MachineBodyProps) {
  const { openEditMachine, openRemoveMachine } = useApp();
  const { machine } = ms;
  const home = useMemo(
    () => inferHome([...ms.folders, ...ms.runners.map((r) => r.root), ...ms.otherPorts.map((p) => p.dir)]),
    [ms.folders, ms.runners, ms.otherPorts],
  );
  const meta = [machine.hostname !== machine.name ? machine.hostname : undefined, machine.os && machine.arch ? `${machine.os}/${machine.arch}` : machine.os]
    .filter(Boolean)
    .join(" · ");
  const headingId = `machine-${machine.id}`.replace(/[^\w-]/g, "_");
  // A remote machine's tools and runners are only known while it's online.
  const live = machine.local || machine.status === "online";
  if (filtering && projects.length === 0) return null;

  return (
    <section className="machine" aria-labelledby={headingId}>
      <header className={showHeader ? "machine-head" : "machine-head sr-only"}>
        <Icon name="machine" size={15} className="machine-icon" />
        <h2 className="machine-name" id={headingId} title={meta || undefined}>
          {machine.name}
        </h2>
        {/* online is the normal case: only a machine that isn't says so */}
        {machine.status !== "online" && (
          <span className={`pill pill-${machine.status}`}>
            <StateDot state={machine.status} />
            {STATUS_LABEL[machine.status] ?? machine.status}
          </span>
        )}
        {!machine.local && (
          <span className="machine-actions">
            <Menu
              label={`Actions for ${machine.name}`}
              items={[
                ...(machine.status === "online" ? [{ label: "Set up…", icon: "wand" as const, onSelect: () => navigate({ view: "onboarding", machine: machine.id }) }] : []),
                { label: "Edit machine…", icon: "pencil", onSelect: () => openEditMachine(machine.id) },
                { label: "Remove machine…", icon: "trash", onSelect: () => openRemoveMachine(machine) },
              ]}
            />
          </span>
        )}
      </header>
      {!live && <RemoteStatus ms={ms} />}
      {live && (projects.length > 0 ? renderProjects(projects) : !filtering && <EmptyBody ms={ms} />)}
      {!filtering && <OtherPorts ms={ms} home={home} />}
    </section>
  );
}

/** List mode: one foldable group per project, worktrees inside. */
export function ProjectGrid({ ms, projects, extras, folds, forceOpen }: { ms: MachineSnapshot; projects: ProjectGroup[]; extras(e: AppEntry): RowExtras; folds?: Folds; forceOpen?: boolean }) {
  return (
    <div className="projects">
      {projects.map((p) => (
        <ProjectCard key={p.key} ms={ms} group={p} extras={extras} folds={folds} forceOpen={forceOpen} />
      ))}
    </div>
  );
}
