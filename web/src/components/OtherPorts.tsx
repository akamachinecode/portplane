import { useState } from "react";
import type { MachineSnapshot, Port } from "../api/types";
import { shortenPath, sortOtherPorts } from "../lib/format";
import { Icon } from "./Icon";

const ALL_INTERFACES = new Set(["0.0.0.0", "::", "*", "[::]"]);

function storageKey(machine: string) {
  return `portplane.otherPorts.${machine}`;
}

function readOpen(machine: string): boolean | null {
  try {
    const v = localStorage.getItem(storageKey(machine));
    return v === null ? null : v === "1";
  } catch {
    return null;
  }
}

function writeOpen(machine: string, open: boolean) {
  try {
    localStorage.setItem(storageKey(machine), open ? "1" : "0");
  } catch {
    // storage blocked: the section just forgets
  }
}

function PortRow({ port, local, home }: { port: Port; local: boolean; home: string | undefined }) {
  const dir = port.dir ? shortenPath(port.dir, home) : undefined;
  // port.url names a portless alias when one points here; it is only
  // meaningful on the machine that reported it.
  const href = (local && port.url) || `http://localhost:${port.port}`;
  return (
    <li className="port-row">
      <span className="port-num">:{port.port}</span>
      <span className="port-proc" title={port.pid ? `pid ${port.pid}` : undefined}>
        {port.process || "unknown"}
      </span>
      <span className="port-where" title={port.dir}>
        {port.project && <span className="port-project">{port.project}</span>}
        {dir && <span className="port-dir mono">{dir}</span>}
        {!port.project && !dir && <span className="port-dir">—</span>}
      </span>
      <span className="port-link">
        {ALL_INTERFACES.has(port.address) && (
          <span className="tag" title={`Listening on ${port.address}: reachable from your network`}>
            network
          </span>
        )}
        {local ? (
          <a href={href} target="_blank" rel="noopener" className="addr">
            localhost:{port.port}
          </a>
        ) : (
          <span className="addr addr-idle">localhost:{port.port}</span>
        )}
      </span>
    </li>
  );
}

/** Listening ports no dekit task owns. Collapsed unless they're all there is. */
export function OtherPorts({ ms, home }: { ms: MachineSnapshot; home: string | undefined }) {
  const machine = ms.machine.id;
  const [open, setOpen] = useState<boolean>(() => readOpen(machine) ?? ms.apps.length === 0);
  if (ms.otherPorts.length === 0) return null;
  const sorted = sortOtherPorts(ms.otherPorts);
  const inside = sorted.filter((p) => p.inFolder);
  const outside = sorted.filter((p) => !p.inFolder);

  return (
    <details
      className="others"
      open={open}
      onToggle={(e) => {
        const next = e.currentTarget.open;
        setOpen(next);
        writeOpen(machine, next);
      }}
    >
      <summary className="others-summary">
        <Icon name="chevronRight" size={14} className="others-chevron" />
        <span className="others-title">Other ports</span>
        <span className="count">{ms.otherPorts.length}</span>
        <span className="others-hint">listening, not started by dekit</span>
      </summary>
      {inside.length > 0 && (
        <>
          <h4 className="others-group">In your folders</h4>
          <ul className="port-list">
            {inside.map((p) => (
              <PortRow key={`${p.address}:${p.port}`} port={p} local={ms.machine.local} home={home} />
            ))}
          </ul>
        </>
      )}
      {outside.length > 0 && (
        <>
          {inside.length > 0 && <h4 className="others-group">Elsewhere</h4>}
          <ul className="port-list">
            {outside.map((p) => (
              <PortRow key={`${p.address}:${p.port}`} port={p} local={ms.machine.local} home={home} />
            ))}
          </ul>
        </>
      )}
    </details>
  );
}
