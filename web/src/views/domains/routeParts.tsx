import { useEffect, useState } from "react";
import { errorText } from "../../api/errors";
import type { RouteView, StaleRoute } from "../../api/portless";
import type { App } from "../../api/types";
import { useApp } from "../../components/AppContext";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { useMachineScope } from "../../components/MachineScope";
import { LoadingState } from "../../components/States";
import { openResolved } from "../../lib/popup";
import { isPublic, SHARE_NAMES } from "../../lib/sharing";

// Pieces of an address row that Addresses and Health share: what a
// clean-up would remove, the share tags, and opening a remote address.

/** What prune will remove and stop, read just before it runs. */
export function StaleList({ force }: { force: boolean }) {
  const { api } = useApp();
  const [stale, setStale] = useState<StaleRoute[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.portlessPrunePreview().then(setStale, (err: unknown) => setError(errorText(err)));
  }, [api]);
  if (error) return <p className="field-error">{error}</p>;
  if (!stale) return <LoadingState label="Looking for stale routes…" />;
  if (!stale.length) return <p className="muted">No stale routes right now: running this changes nothing.</p>;
  const procs = stale.flatMap((s) => s.processes.map((p) => ({ ...p, hostname: s.hostname })));
  return (
    <div className="stale">
      <h3 className="plan-title">Routes it removes</h3>
      <ul className="stale-list">
        {stale.map((s) => (
          <li key={s.hostname}>
            <span className="mono">{s.hostname}</span> <span className="muted">→ :{s.port} · its portless process ({s.pid}) is gone</span>
          </li>
        ))}
      </ul>
      <h3 className="plan-title">{procs.length ? `Processes it ${force ? "kills (SIGKILL)" : "asks to stop (SIGTERM)"}` : "Processes it stops"}</h3>
      {procs.length ? (
        <ul className="stale-list">
          {procs.map((p) => (
            <li key={`${p.hostname}-${p.pid}`}>
              <span className="mono">{p.process ?? "unknown"}</span> <span className="muted">PID {p.pid}, still holding :{p.port} for {p.hostname}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">None: nothing still holds those ports.</p>
      )}
    </div>
  );
}

export function SharedLinks({ r }: { r: RouteView }) {
  if (!r.shared.length) return null;
  return (
    <span className="shared">
      {r.shared.map((s) => (
        <a key={s.url} className={`tag${isPublic(s.kind) ? " tag-warn" : ""}`} href={s.url} target="_blank" rel="noopener" title={`Shared with ${SHARE_NAMES[s.kind]}${isPublic(s.kind) ? ", publicly" : ""}: ${s.url}`}>
          {SHARE_NAMES[s.kind]}
        </a>
      ))}
    </span>
  );
}

/**
 * Opens a route of a machine over SSH from this computer (ADR-0016): an
 * app's own tunnelled address when it has one, else a tunnel to the port.
 */
export function RemoteRouteOpen({ r, app }: { r: RouteView; app: App | undefined }) {
  const { api, toast } = useApp();
  const { id, ms } = useMachineScope();
  const name = ms?.machine.name ?? id;
  const [busy, setBusy] = useState(false);
  if (app?.remoteUrl) {
    return (
      <a className="icon-btn" href={app.remoteUrl} target="_blank" rel="noopener" aria-label={`Open ${r.hostname} through Portplane`} title={`Open ${app.remoteUrl}`}>
        <Icon name="open" />
      </a>
    );
  }
  const open = () => {
    if (busy) return;
    setBusy(true);
    openResolved(() => api.openPort(id, r.port), { open: () => window.open("", "_blank"), openElsewhere: (url) => api.open("local", [url]) }, `Opening port ${r.port} on ${name}…`)
      .catch((err: unknown) => toast.error(`Couldn't open port ${r.port} on ${name}: ${errorText(err)}`))
      .finally(() => setBusy(false));
  };
  return <IconButton icon="open" label={`Open port ${r.port} on ${name} through SSH`} onClick={open} />;
}

