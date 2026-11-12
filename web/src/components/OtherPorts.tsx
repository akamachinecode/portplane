import { useState } from "react";
import { errorText } from "../api/errors";
import type { MachineSnapshot, Port } from "../api/types";
import { shortenPath, sortOtherPorts } from "../lib/format";
import { navigate } from "../lib/router";
import { suggestName } from "../lib/portless";
import { requestIntent, usePrimePortless } from "../views/domains/store";
import { openResolved } from "../lib/popup";
import { useApp } from "./AppContext";
import { Icon, Spinner } from "./Icon";

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

/**
 * A port on another machine opens through a tunnel the hub makes on demand
 * (ADR-0016). The window opens blank during the click, so popup blockers
 * allow it, and gets its address when the tunnel is up.
 */
function RemoteOpen({ machine, machineName, port }: { machine: string; machineName: string; port: number }) {
  const { api, toast } = useApp();
  const [busy, setBusy] = useState(false);
  const open = () => {
    if (busy) return;
    setBusy(true);
    openResolved(
      () => api.openPort(machine, port),
      {
        open: () => window.open("", "_blank"),
        openElsewhere: (url) => api.open("local", [url]),
      },
      `Opening port ${port} on ${machineName}…`,
    )
      .catch((err: unknown) => toast.error(`Couldn't open port ${port} on ${machineName}: ${errorText(err)}`))
      .finally(() => setBusy(false));
  };
  return (
    <button
      type="button"
      className="btn btn-sm"
      onClick={open}
      aria-busy={busy || undefined}
      aria-disabled={busy || undefined}
      title={`Open port ${port} on ${machineName} through SSH`}
    >
      {busy ? <Spinner /> : <Icon name="open" size={13} />}
      Open
    </button>
  );
}

function PortRow({ port, ms, home }: { port: Port; ms: MachineSnapshot; home: string | undefined }) {
  const local = ms.machine.local;
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
        {local && ms.tools.portless && !port.route && (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            title={`Give port ${port.port} a stable .localhost address with a portless alias`}
            onClick={() => {
              requestIntent({ kind: "new-alias", port: port.port, name: suggestName(port.process) });
              navigate({ view: "domains", section: "aliases", machine: ms.machine.id });
            }}
          >
            <Icon name="link" size={13} />
            Give it a URL
          </button>
        )}
        {local ? (
          <a href={href} target="_blank" rel="noopener" className="addr">
            {port.route ?? `localhost:${port.port}`}
          </a>
        ) : (
          ms.machine.status === "online" && <RemoteOpen machine={ms.machine.id} machineName={ms.machine.name} port={port.port} />
        )}
      </span>
    </li>
  );
}

/** Listening ports no dekit task owns. Collapsed unless they're all there is. */
export function OtherPorts({ ms, home }: { ms: MachineSnapshot; home: string | undefined }) {
  const machine = ms.machine.id;
  const [open, setOpen] = useState<boolean>(() => readOpen(machine) ?? ms.apps.length === 0);
  // Health lists portless's own problems (a service whose Node.js is gone)
  // without a visit to Domains first.
  usePrimePortless(ms.machine.local && !!ms.tools.portless);
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
          <h3 className="others-group">In your folders</h3>
          <ul className="port-list">
            {inside.map((p) => (
              <PortRow key={`${p.address}:${p.port}`} port={p} ms={ms} home={home} />
            ))}
          </ul>
        </>
      )}
      {outside.length > 0 && (
        <>
          {inside.length > 0 && <h3 className="others-group">Elsewhere</h3>}
          <ul className="port-list">
            {outside.map((p) => (
              <PortRow key={`${p.address}:${p.port}`} port={p} ms={ms} home={home} />
            ))}
          </ul>
        </>
      )}
    </details>
  );
}
