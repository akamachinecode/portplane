import type { MachineSnapshot } from "../../api/types";
import { StateDot } from "../../components/StateDot";
import { SnapshotGate } from "../../shell/SnapshotGate";
import { SettingRow, SettingsGroup } from "../settings/SettingsGroup";

function MachineProxy({ ms }: { ms: MachineSnapshot }) {
  const { tools, machine } = ms;
  const known = machine.local || machine.status === "online";
  let state: { dot: "on" | "off" | "failed"; text: string };
  if (!known) state = { dot: "off", text: "Unknown while the machine isn't connected" };
  else if (!tools.portless) state = { dot: "off", text: "portless isn't installed" };
  else if (!tools.proxyRunning) state = { dot: "failed", text: "Not running: the URLs won't load" };
  else state = { dot: "on", text: "Running" };
  const port = tools.proxyPort ?? (tools.proxyHttps ? 443 : 80);
  return (
    <SettingsGroup title={machine.name}>
      <SettingRow label="Proxy">
        <span className="inline-state">
          <StateDot state={state.dot} />
          {state.text}
        </span>
      </SettingRow>
      {known && tools.portless && tools.proxyRunning && (
        <>
          <SettingRow label="Protocol">{tools.proxyHttps ? "HTTPS, with portless's local certificate" : "HTTP"}</SettingRow>
          <SettingRow label="Port">
            <span className="mono">{port}</span>
          </SettingRow>
        </>
      )}
      {known && tools.portless && (
        <SettingRow label="portless">
          <span className="mono">{tools.portless}</span>
        </SettingRow>
      )}
    </SettingsGroup>
  );
}

/** The portless proxy on each machine (start, stop and its options come with M5.2). */
export function ProxySection() {
  return <SnapshotGate>{(snapshot) => snapshot.machines.map((ms) => <MachineProxy key={ms.machine.id} ms={ms} />)}</SnapshotGate>;
}
