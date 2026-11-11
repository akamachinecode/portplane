import { useMemo } from "react";
import type { MachineSnapshot } from "../api/types";
import { indexApps } from "../lib/apps";
import { inferHome } from "../lib/format";
import { Banner } from "./Banner";
import { RunnerBanners, ToolBanners } from "./Banners";
import { FirstRun, NoApps } from "./EmptyStates";
import { Icon } from "./Icon";
import { OtherPorts } from "./OtherPorts";
import { ProjectCard } from "./ProjectCard";
import { StateDot } from "./StateDot";

const STATUS_LABEL = { online: "Online", connecting: "Connecting", offline: "Offline" } as const;

function Body({ ms }: { ms: MachineSnapshot }) {
  const byId = useMemo(() => indexApps(ms.apps), [ms.apps]);
  if (ms.folders.length === 0) {
    return ms.machine.local ? <FirstRun /> : <p className="muted">No folders are watched on this machine yet.</p>;
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

export function MachineSection({ ms }: { ms: MachineSnapshot }) {
  const { machine } = ms;
  const home = useMemo(
    () => inferHome([...ms.folders, ...ms.runners.map((r) => r.root), ...ms.otherPorts.map((p) => p.dir)]),
    [ms.folders, ms.runners, ms.otherPorts],
  );
  const meta = [machine.hostname, machine.os && machine.arch ? `${machine.os}/${machine.arch}` : machine.os]
    .filter(Boolean)
    .join(" · ");
  const headingId = `machine-${machine.id}`.replace(/[^\w-]/g, "_");

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
      </header>
      {machine.error && (
        <Banner tone="error" title={machine.status === "offline" ? "Can't reach this machine" : "Problem with this machine"}>
          {machine.error}
        </Banner>
      )}
      <ToolBanners ms={ms} />
      <RunnerBanners ms={ms} home={home} />
      <Body ms={ms} />
      <OtherPorts ms={ms} home={home} />
    </section>
  );
}
