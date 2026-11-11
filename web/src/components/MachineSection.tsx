import { useMemo } from "react";
import type { MachineSnapshot } from "../api/types";
import { indexApps } from "../lib/apps";
import { inferHome } from "../lib/format";
import { useApp } from "./AppContext";
import { Banner } from "./Banner";
import { RunnerBanners, ToolBanners } from "./Banners";
import { FirstRun, NoApps } from "./EmptyStates";
import { Icon, Spinner } from "./Icon";
import { Menu } from "./Menu";
import { OtherPorts } from "./OtherPorts";
import { ProjectCard } from "./ProjectCard";
import { StateDot } from "./StateDot";

const STATUS_LABEL = { online: "Online", connecting: "Connecting", offline: "Offline" } as const;

function Body({ ms }: { ms: MachineSnapshot }) {
  const { openEditMachine } = useApp();
  const byId = useMemo(() => indexApps(ms.apps), [ms.apps]);
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
  if (ms.apps.length === 0) {
    // Without dekit there is nothing to read: the banner already says so.
    if (!ms.tools.dekit || ms.runners.length > 0) return null;
    return <NoApps ms={ms} />;
  }
  return (
    <div className="grid">
      {ms.projects.map((p) => (
        <ProjectCard key={`${p.runner}\u0000${p.name}`} ms={ms} project={p} byId={byId} />
      ))}
    </div>
  );
}

/** Where a remote machine stands while it isn't online (ADR-0015: reconnects on its own). */
function RemoteStatus({ ms }: { ms: MachineSnapshot }) {
  const { machine } = ms;
  if (machine.status === "offline") {
    return (
      <Banner tone="error" title={`Can't reach ${machine.name}`}>
        {machine.error && <span className="banner-pre">{machine.error}</span>}
        <span className="banner-hint">Portplane keeps trying in the background.</span>
      </Banner>
    );
  }
  if (machine.error) {
    return (
      <Banner tone="warn" title={`Reconnecting to ${machine.name}…`}>
        <span className="banner-pre">Last error: {machine.error}</span>
      </Banner>
    );
  }
  return (
    <p className="machine-connecting">
      <Spinner /> Connecting over SSH…
    </p>
  );
}

export function MachineSection({ ms }: { ms: MachineSnapshot }) {
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

  return (
    <section className="machine" aria-labelledby={headingId}>
      <header className="machine-head">
        <Icon name="machine" size={15} className="machine-icon" />
        <h2 className="machine-name" id={headingId}>
          {machine.name}
        </h2>
        {meta && <span className="machine-meta">{meta}</span>}
        <span className={`pill pill-${machine.status}`}>
          <StateDot state={machine.status} />
          {STATUS_LABEL[machine.status] ?? machine.status}
        </span>
        {!machine.local && (
          <span className="machine-actions">
            <Menu
              label={`Actions for ${machine.name}`}
              items={[
                { label: "Edit machine…", icon: "pencil", onSelect: () => openEditMachine(machine.id) },
                { label: "Remove machine…", icon: "trash", onSelect: () => openRemoveMachine(machine) },
              ]}
            />
          </span>
        )}
      </header>
      {machine.local && machine.error && (
        <Banner tone="error" title="Problem with this machine">
          {machine.error}
        </Banner>
      )}
      {!machine.local && machine.status !== "online" && <RemoteStatus ms={ms} />}
      {live && (
        <>
          <ToolBanners ms={ms} />
          <RunnerBanners ms={ms} home={home} />
          <Body ms={ms} />
        </>
      )}
      <OtherPorts ms={ms} home={home} />
    </section>
  );
}
