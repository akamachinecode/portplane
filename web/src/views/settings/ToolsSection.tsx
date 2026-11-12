import { useApp } from "../../components/AppContext";
import { Icon } from "../../components/Icon";
import { StateDot } from "../../components/StateDot";
import { SnapshotGate } from "../../shell/SnapshotGate";
import type { MachineSnapshot } from "../../api/types";
import { SettingsGroup } from "./SettingsGroup";

function ToolRow({ name, version, why }: { name: string; version: string | undefined; why: string }) {
  return (
    <div className="tool-row">
      <StateDot state={version ? "on" : "off"} />
      <span className="tool-name">{name}</span>
      <span className={version ? "tool-version mono" : "tool-version muted"}>{version ?? "Not installed"}</span>
      <span className="tool-why">{why}</span>
    </div>
  );
}

function MachineTools({ ms }: { ms: MachineSnapshot }) {
  const { openSetup } = useApp();
  const { tools, machine } = ms;
  const known = machine.local || machine.status === "online";
  const missing = !tools.dekit || !tools.portless;
  return (
    <SettingsGroup title={machine.name}>
      {!known ? (
        <p className="muted">Not connected: its tools show once it's back online.</p>
      ) : (
        <>
          <ToolRow name="dekit" version={tools.dekit} why="Starts, stops and supervises dev servers." />
          <ToolRow name="portless" version={tools.portless} why="Gives each one a stable .localhost URL." />
          {tools.portless && (
            <ToolRow
              name="Proxy"
              version={tools.proxyRunning ? `${tools.proxyHttps ? "HTTPS" : "HTTP"} on port ${tools.proxyPort ?? (tools.proxyHttps ? 443 : 80)}` : undefined}
              why={tools.proxyRunning ? "Serves the .localhost URLs." : "Not running: the URLs won't load."}
            />
          )}
          {machine.local && missing && ms.folders[0] && (
            <div className="sgroup-foot">
              <button type="button" className="btn" onClick={() => openSetup(ms.folders[0])}>
                <Icon name="wand" size={14} />
                See how to install
              </button>
            </div>
          )}
        </>
      )}
    </SettingsGroup>
  );
}

/** dekit and portless on each machine (installing and updating them comes in M5.1). */
export function ToolsSection() {
  return <SnapshotGate>{(snapshot) => snapshot.machines.map((ms) => <MachineTools key={ms.machine.id} ms={ms} />)}</SnapshotGate>;
}
