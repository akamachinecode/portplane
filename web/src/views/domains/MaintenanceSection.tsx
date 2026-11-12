import { useState } from "react";
import type { PortlessAction, PortlessStatus } from "../../api/portless";
import { CommandLine } from "../../components/Controls";
import { Icon } from "../../components/Icon";
import { ORIGIN_LABELS } from "../../lib/portless";
import { SettingRow, SettingsGroup } from "../settings/SettingsGroup";
import { PlanDialog } from "./PlanDialog";
import { StatusGate } from "./ProxySection";

function quote(a: string): string {
  return /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`;
}

function Maintenance({ status }: { status: PortlessStatus }) {
  const [plan, setPlan] = useState<PortlessAction | null>(null);
  const install = status.install;
  return (
    <>
      <SettingsGroup title="portless" description="The program behind your .localhost addresses. Portplane updates and removes it with the tool that installed it.">
        <SettingRow label="Version">
          <span className="mono">{status.version ?? "unknown"}</span>
        </SettingRow>
        <SettingRow label="Installed with">{ORIGIN_LABELS[install.origin]}</SettingRow>
        <SettingRow label="Program">
          <span className="mono path-value">{install.script ?? install.bin}</span>
        </SettingRow>
        {!install.update && (
          <div className="muted">
            <p>Portplane can't tell how this portless was installed, so update or remove it the way you installed it. With npm:</p>
            <CommandLine command="npm install --global portless@latest" />
          </div>
        )}
        <div className="sgroup-foot">
          {install.update && (
            <button type="button" className="btn" onClick={() => setPlan("update")}>
              {install.update.admin && <Icon name="shield" size={13} />}
              <Icon name="restart" size={13} />
              Update portless
            </button>
          )}
        </div>
        {install.update && (
          <p className="field-hint">
            Runs <span className="mono">{install.update.argv.map(quote).join(" ")}</span>. If the startup service still points at the old version afterwards, Portplane reinstalls it, which asks for your password.
          </p>
        )}
      </SettingsGroup>
      <SettingsGroup title="Uninstall portless" description="Removes portless and everything it set up on this computer: the service, the trusted certificate, its files and its hosts entries. Your apps, dekit.yaml and portless.json stay; apps lose their .localhost addresses.">
        <div className="sgroup-foot">
          <button type="button" className="btn btn-danger" onClick={() => setPlan("uninstall")}>
            <Icon name="trash" size={13} />
            Uninstall portless…
          </button>
        </div>
      </SettingsGroup>
      {plan && <PlanDialog action={plan} onClose={() => setPlan(null)} />}
    </>
  );
}

/** Updating and removing portless (plan §5.8). */
export function MaintenanceSection() {
  return <StatusGate>{(status) => <Maintenance status={status} />}</StatusGate>;
}
