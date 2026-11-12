import { useApp } from "../components/AppContext";
import { Icon } from "../components/Icon";
import { MachineSection } from "../components/MachineSection";
import { EmptyState } from "../components/States";
import { ViewHeader } from "../components/ViewHeader";
import { summaryParts } from "../lib/summary";
import { SnapshotGate } from "../shell/SnapshotGate";
import { useShell } from "../shell/ShellContext";
import "./AppsView.css";

/** Every dev server, by machine and project: the main view. */
export function AppsView() {
  const { summary } = useShell();
  const { openAddMachine } = useApp();
  return (
    <>
      <ViewHeader
        title="Apps"
        description={
          summary && (
            <span className="summary">
              {summaryParts(summary).map((p) => (
                <span key={p.tone} className={`summary-part tone-${p.tone}`}>
                  {p.text}
                </span>
              ))}
            </span>
          )
        }
      />
      <SnapshotGate>
        {(snapshot) =>
          snapshot.machines.length === 0 ? (
            <EmptyState icon="machine" title="No machines to show" />
          ) : (
            <>
              {snapshot.machines.map((ms) => (
                <MachineSection key={ms.machine.id} ms={ms} />
              ))}
              <button type="button" className="add-machine" onClick={openAddMachine}>
                <span className="add-machine-icon">
                  <Icon name="plus" size={15} />
                </span>
                <span className="add-machine-text">
                  <span className="add-machine-title">Add a machine</span>
                  <span className="add-machine-hint">See the dev servers of another computer over SSH, Tailscale included.</span>
                </span>
              </button>
            </>
          )
        }
      </SnapshotGate>
    </>
  );
}
