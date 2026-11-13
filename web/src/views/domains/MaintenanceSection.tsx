import { useState } from "react";
import type { PortlessAction, PortlessStatus } from "../../api/portless";
import { CommandLine } from "../../components/Controls";
import { Icon } from "../../components/Icon";
import { machineLabel, useScopedMachine } from "../../components/MachineScope";
import { ORIGIN_LABELS } from "../../lib/portless";
import { Fact, Fold, Group, ShortPath, StatusLine } from "./Fold";
import { PlanDialog } from "./PlanDialog";
import { StatusGate } from "./ProxySection";

function quote(a: string): string {
  return /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`;
}

function Maintenance({ status }: { status: PortlessStatus }) {
  const ms = useScopedMachine();
  const [plan, setPlan] = useState<PortlessAction | null>(null);
  const install = status.install;
  return (
    <>
      <Group title="portless">
        <StatusLine
          sub={install.origin === "unknown" ? undefined : install.origin === "portplane" ? ORIGIN_LABELS.portplane : `Installed with ${ORIGIN_LABELS[install.origin]}`}
          actions={
            install.update && (
              <button type="button" className="btn" onClick={() => setPlan("update")}>
                <Icon name={install.update.admin ? "shield" : "restart"} size={13} />
                Update portless
              </button>
            )
          }
        >
          Version <span className="mono">{status.version ?? "unknown"}</span>
        </StatusLine>
        {!install.update && (
          <div className="sgroup-text">
            <p>Portplane can't tell how this portless was installed, so update or remove it the way you installed it. With npm:</p>
            <CommandLine command="npm install --global portless@latest" />
          </div>
        )}
        <Fold summary="Details">
          <dl className="dfacts">
            <Fact label="Program">
              <ShortPath path={install.script ?? install.bin} />
            </Fact>
            {install.update && (
              <Fact label="Update runs">
                <span className="mono">{install.update.argv.map(quote).join(" ")}</span>
              </Fact>
            )}
          </dl>
          {install.update && <p className="sgroup-text">If the startup service still points at the old version afterwards, Portplane reinstalls it, which asks for your password.</p>}
        </Fold>
      </Group>
      <div className="dfolds">
        <Fold className="dfold-section" summary="Uninstall portless">
          <div className="sgroup">
            <div className="sgroup-body">
              <p className="sgroup-text">
                Removes portless and everything it set up on {machineLabel(ms)}: the service, the trusted certificate, its files and its hosts entries. Your apps, dekit.yaml and portless.json stay; apps lose their .localhost addresses.
              </p>
              <div className="sgroup-foot">
                {/* red only in the confirmation, where it is the decision */}
                <button type="button" className="btn btn-ghost btn-danger-text" onClick={() => setPlan("uninstall")}>
                  <Icon name="trash" size={13} />
                  Uninstall portless…
                </button>
              </div>
            </div>
          </div>
        </Fold>
      </div>
      {plan && <PlanDialog action={plan} onClose={() => setPlan(null)} />}
    </>
  );
}

/** Updating and removing portless (plan §5.8). */
export function MaintenanceSection() {
  return <StatusGate>{(status) => <Maintenance status={status} />}</StatusGate>;
}
