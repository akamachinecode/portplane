import { useId, useMemo, useState } from "react";
import { ApiError, errorText } from "../../api/errors";
import type { RouteView } from "../../api/portless";
import { useApp } from "../../components/AppContext";
import { Field, Switch } from "../../components/Controls";
import { Dialog } from "../../components/Dialog";
import { Spinner } from "../../components/Icon";
import { hostnameFor, nameProblem, proxyUrl } from "../../lib/portless";
import { useMachineResources, usePortlessStatus, valueOf } from "./store";
import { machineLabel, useScopedMachine } from "../../components/MachineScope";

export interface AliasDraft {
  name?: string;
  port?: number;
  /** The hostname being edited; absent for a new alias. */
  from?: string;
}

/**
 * Adds or edits an alias: a stable name for a server portless can't start
 * (a database UI, a container, `php -S`), pointing at its port (plan §5.3).
 */
export function AliasDialog({ draft, routes, onClose }: { draft: AliasDraft; routes: RouteView[]; onClose(): void }) {
  const { api, toast } = useApp();
  const machine = useScopedMachine();
  const routesRes = useMachineResources().routes;
  const status = valueOf(usePortlessStatus().state);
  const tld = status?.proxy.tlds[0] ?? "localhost";
  const [name, setName] = useState(draft.name ?? "");
  const [port, setPort] = useState<number>(draft.port ?? NaN);
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const ids = { name: useId(), port: useId() };

  const ports = useMemo(() => machine?.otherPorts ?? [], [machine]);
  const host = hostnameFor(name, tld);
  const problem = nameProblem(name, tld) ?? (host === "portplane.localhost" ? "portplane.localhost is Portplane's own address." : null);
  const portProblem = Number.isInteger(port) && port >= 1 && port <= 65535 ? null : "Pick a port between 1 and 65535.";
  const holder = routes.find((r) => r.hostname === host && r.hostname !== draft.from);
  const clash = holder && !force ? `${host} already points to ${holder.owner?.label ?? `port ${holder.port}`}. Turn on “Replace the existing route” to take it over.` : null;

  const save = async () => {
    setTouched(true);
    if (problem || portProblem || clash) return;
    setBusy(true);
    setError(null);
    try {
      const req = { name: name.trim().toLowerCase(), port, force, from: draft.from };
      const next = draft.from ? await api.portlessReplaceAlias(req) : await api.portlessAddAlias(req);
      routesRes.put(next);
      toast.info(`${host} now points to port ${port}`);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? errorText(err) : `Couldn't save the alias: ${errorText(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={() => !busy && onClose()}
      dismissable={!busy}
      title={draft.from ? `Edit ${draft.from}` : "New alias"}
      size="sm"
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy} aria-busy={busy || undefined}>
            {busy && <Spinner />}
            {draft.from ? "Save" : "Add alias"}
          </button>
        </>
      }
    >
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p className="dialog-text">An alias gives a stable address to a server portless doesn't start itself, such as a database UI, a container or <code>php -S</code>.</p>
        <Field label="Name" htmlFor={ids.name} error={touched || name ? (problem ?? clash) : null}>
          <div className={`name-field${(touched || name) && (problem || clash) ? " has-error" : ""}`}>
            <span className="name-affix">https://</span>
            <input
              id={ids.name}
              className="name-input mono"
              value={name}
              size={Math.max(4, name.length + 1)}
              placeholder="db"
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              data-autofocus
              onChange={(e) => setName(e.target.value)}
            />
            <span className="name-affix">.{tld}</span>
          </div>
        </Field>
        <Field label="Port" htmlFor={ids.port} error={touched ? portProblem : null} hint={ports.length ? "Or pick one of the ports listening now:" : `The port the server listens on, on ${machineLabel(machine)}.`}>
          <input id={ids.port} className="input mono port-input" type="number" min={1} max={65535} value={Number.isFinite(port) ? port : ""} placeholder="5432" onChange={(e) => setPort(e.target.valueAsNumber)} />
        </Field>
        {ports.length > 0 && (
          <div className="port-picks" role="group" aria-label="Ports listening now">
            {ports.map((p) => (
              <button key={`${p.address}:${p.port}`} type="button" className={`chip chip-btn${p.port === port ? " is-on" : ""}`} aria-pressed={p.port === port} onClick={() => setPort(p.port)}>
                <span className="mono">:{p.port}</span> {p.process ?? "unknown"}
                {p.route && <span className="muted"> · {p.route}</span>}
              </button>
            ))}
          </div>
        )}
        <Switch checked={force} onChange={setForce} label="Replace the existing route" description="When another route already has this name, take it over. If a running app holds it, portless stops that app's portless process." />
        {host && !problem && Number.isFinite(port) && (
          <p className="proxy-preview">
            <span className="mono">{status ? proxyUrl(host, status.proxy) : `https://${host}`}</span> → <span className="mono">127.0.0.1:{port}</span>
          </p>
        )}
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
