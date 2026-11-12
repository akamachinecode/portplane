import type { MachineSnapshot } from "../api/types";
import { useApp } from "../components/AppContext";
import { Icon } from "../components/Icon";
import { EmptyState } from "../components/States";
import { StateDot } from "../components/StateDot";
import { ViewHeader } from "../components/ViewHeader";
import { serviceCounts } from "../lib/apps";
import { osLabel } from "../lib/machines";
import { href } from "../lib/router";
import { SnapshotGate } from "../shell/SnapshotGate";
import "./MachinesView.css";

const STATUS_LABEL = { online: "Online", connecting: "Connecting", offline: "Offline" } as const;

function MachineCard({ ms }: { ms: MachineSnapshot }) {
  const { openEditMachine, openRemoveMachine } = useApp();
  const m = ms.machine;
  const { running, total } = serviceCounts(ms.apps);
  const meta = [m.hostname && m.hostname !== m.name ? m.hostname : undefined, [osLabel(m.os), m.arch].filter(Boolean).join(" "), m.agent && !m.local ? `agent ${m.agent}` : undefined]
    .filter(Boolean)
    .join(" · ");
  return (
    <li className="mcard">
      <div className="mcard-head">
        <Icon name="machine" size={16} className="mcard-icon" />
        <h2 className="mcard-name">{m.name}</h2>
        <span className={`pill pill-${m.status}`}>
          <StateDot state={m.status} />
          {STATUS_LABEL[m.status] ?? m.status}
        </span>
        <span className="spacer" />
        {m.local ? (
          <a className="btn btn-sm" href={href({ view: "settings", section: "folders" })}>
            <Icon name="folder" size={13} />
            Folders
          </a>
        ) : (
          <>
            <button type="button" className="btn btn-sm" onClick={() => openEditMachine(m.id)}>
              <Icon name="pencil" size={13} />
              Edit
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => openRemoveMachine(m)} aria-label={`Remove ${m.name}`}>
              <Icon name="trash" size={13} />
              Remove
            </button>
          </>
        )}
      </div>
      {meta && <p className="mcard-meta">{meta}</p>}
      {m.error && <p className={`mcard-error${m.status === "offline" ? "" : " is-warn"}`}>{m.error}</p>}
      <dl className="mcard-facts">
        <div>
          <dt>Apps</dt>
          <dd>{m.local || m.status === "online" ? `${running} of ${total} running` : "—"}</dd>
        </div>
        <div>
          <dt>{ms.folders.length === 1 ? "Folder" : "Folders"}</dt>
          <dd>
            {ms.folders.length ? (
              <ul className="mcard-folders">
                {ms.folders.map((f) => (
                  <li key={f} className="mono">
                    {f}
                  </li>
                ))}
              </ul>
            ) : (
              <span className="muted">None yet: only open ports show</span>
            )}
          </dd>
        </div>
      </dl>
    </li>
  );
}

/** This computer and the machines reached over SSH (ADR-0015). */
export function MachinesView() {
  const { openAddMachine } = useApp();
  return (
    <>
      <ViewHeader
        title="Machines"
        description="This computer and others you reach over SSH, Tailscale included. Their dev servers show next to yours."
        actions={
          <button type="button" className="btn btn-primary" onClick={openAddMachine}>
            <Icon name="plus" size={14} />
            Add machine
          </button>
        }
      />
      <SnapshotGate>
        {(snapshot) =>
          snapshot.machines.length === 0 ? (
            <EmptyState icon="machine" title="No machines to show" />
          ) : (
            <ul className="mcards">
              {snapshot.machines.map((ms) => (
                <MachineCard key={ms.machine.id} ms={ms} />
              ))}
            </ul>
          )
        }
      </SnapshotGate>
    </>
  );
}
