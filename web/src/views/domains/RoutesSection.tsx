import { useEffect, useMemo, useState } from "react";
import { errorText } from "../../api/errors";
import type { RouteView, StaleRoute } from "../../api/portless";
import { copyWithToast } from "../../components/appActions";
import { useApp } from "../../components/AppContext";
import { ConfirmDialog } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { IconButton, IconSlot } from "../../components/IconButton";
import { EmptyState, ErrorState, LoadingState } from "../../components/States";
import { StateDot } from "../../components/StateDot";
import { useNow } from "../../hooks/useNow";
import { isUserAlias, KIND_LABELS, routeAge, sortRoutes } from "../../lib/portless";
import { appRoute, href } from "../../lib/router";
import { AliasDialog, type AliasDraft } from "./AliasDialog";
import { PlanDialog } from "./PlanDialog";
import { StatusGate } from "./ProxySection";
import { RenameDialog } from "./RenameDialog";
import { useMachineResources, useRoutes, valueOf } from "./store";
import { useMachineScope } from "../../components/MachineScope";
import { openResolved } from "../../lib/popup";
import type { App } from "../../api/types";

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

function Owner({ r }: { r: RouteView }) {
  const o = r.owner;
  if (!o) return <span className="muted">nothing listening</span>;
  if ((o.kind === "app" || o.kind === "remote") && o.machine && o.appId) {
    return <a href={href(appRoute(o.machine, o.appId))}>{o.label}</a>;
  }
  return (
    <span title={o.pid ? `PID ${o.pid}` : undefined}>
      {o.label}
      {o.kind === "process" && o.pid && o.label !== `PID ${o.pid}` && <span className="muted"> · {o.pid}</span>}
    </span>
  );
}

function SharedLinks({ r }: { r: RouteView }) {
  if (!r.shared.length) return null;
  return (
    <span className="shared">
      {r.shared.map((s) => (
        <a key={s.url} className="tag" href={s.url} target="_blank" rel="noopener" title={`Shared with ${s.kind}: ${s.url}`}>
          {s.kind}
        </a>
      ))}
    </span>
  );
}

/**
 * Opens a route of a machine over SSH from this computer (ADR-0016): an
 * app's own tunnelled address when it has one, else a tunnel to the port.
 */
function RemoteRouteOpen({ r, app }: { r: RouteView; app: App | undefined }) {
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

function Table({ routes }: { routes: RouteView[] }) {
  const ctx = useApp();
  const { put } = useMachineResources().routes;
  const now = useNow(true, 30_000);
  const [plan, setPlan] = useState<"prune" | "prune-force" | null>(null);
  const [rename, setRename] = useState<{ appId: string; machine: string; label: string; runner?: string } | null>(null);
  const [alias, setAlias] = useState<AliasDraft | null>(null);
  const sorted = useMemo(() => sortRoutes(routes), [routes]);
  const stale = routes.filter((r) => !r.alive);
  const scope = useMachineScope();
  const local = scope.ms;
  // A remote machine's names point at its own loopback: they open here
  // through Portplane's tunnel, never as they are (ADR-0016).
  const remote = scope.remote;

  const [removing, setRemoving] = useState<RouteView | null>(null);
  const [busy, setBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    setRemoveError(null);
    try {
      put(await ctx.api.portlessRemoveAlias(removing.hostname));
      ctx.toast.info(`Removed ${removing.hostname}`);
      setRemoving(null);
    } catch (err) {
      setRemoveError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="section-bar">
        <p className="section-bar-text">
          {routes.length} {routes.length === 1 ? "route" : "routes"}
          {stale.length > 0 && (
            <>
              {" · "}
              <span className="warn-text">{stale.length} stale</span>
            </>
          )}
        </p>
        <span className="spacer" />
        <button type="button" className="btn btn-sm" disabled={!stale.length} onClick={() => setPlan("prune")}>
          <Icon name="wand" size={13} />
          Clean stale routes
        </button>
        <button type="button" className="btn btn-sm btn-ghost" disabled={!stale.length} onClick={() => setPlan("prune-force")}>
          Force-stop orphaned servers
        </button>
      </div>
      <div className="table-wrap">
        <table className="table routes-table">
          <thead>
            <tr>
              <th scope="col">Address</th>
              <th scope="col" className="num">
                Port
              </th>
              <th scope="col">Owner</th>
              <th scope="col">Kind</th>
              <th scope="col" className="num">
                Age
              </th>
              <th scope="col">State</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const app = r.owner?.kind === "app" && r.owner.appId ? local?.apps.find((a) => a.id === r.owner!.appId) : undefined;
              const copyUrl = remote && app?.remoteUrl ? app.remoteUrl : r.url;
              return (
                <tr key={r.hostname} className={r.alive ? undefined : "is-stale"}>
                  <td>
                    {r.alive && !remote ? (
                      <a className="addr" href={r.url} target="_blank" rel="noopener">
                        {r.hostname}
                      </a>
                    ) : (
                      <span className={r.alive ? "addr" : "addr addr-idle"}>{r.hostname}</span>
                    )}
                    <SharedLinks r={r} />
                  </td>
                  <td className="num mono" title={`Points to 127.0.0.1:${r.port}`}>
                    :{r.port}
                  </td>
                  <td className="owner-cell">
                    <Owner r={r} />
                  </td>
                  <td>
                    <span className="tag" title={r.compose ? `docker compose project ${r.compose}` : undefined}>
                      {KIND_LABELS[r.kind]}
                    </span>
                  </td>
                  <td className="num mono">{routeAge(r.registeredAt, now) ?? <span className="muted">—</span>}</td>
                  <td>
                    <span className="inline-state">
                      <StateDot state={r.alive ? "on" : "failed"} />
                      {r.alive ? "Live" : "Stale"}
                    </span>
                  </td>
                  <td className="row-actions-cell">
                    <span className="table-actions">
                      {!r.alive ? (
                        <IconSlot />
                      ) : remote ? (
                        <RemoteRouteOpen r={r} app={app} />
                      ) : (
                        <a className="icon-btn" href={r.url} target="_blank" rel="noopener" aria-label={`Open ${r.hostname}`} title={`Open ${r.hostname}`}>
                          <Icon name="open" />
                        </a>
                      )}
                      <IconButton icon="copy" label={`Copy ${copyUrl}`} onClick={() => void copyWithToast(ctx, copyUrl, "the URL")} />
                      {app ? (
                        <IconButton icon="pencil" label={`Change the name of ${app.label}`} onClick={() => setRename({ appId: app.id, machine: local!.machine.id, label: app.label, runner: app.runner })} />
                      ) : isUserAlias(r) ? (
                        <IconButton icon="pencil" label={`Edit ${r.hostname}`} onClick={() => setAlias({ from: r.hostname, name: r.hostname.replace(/\.[^.]+$/, ""), port: r.port })} />
                      ) : (
                        <IconSlot />
                      )}
                      {isUserAlias(r) ? <IconButton icon="trash" label={`Remove ${r.hostname}`} onClick={() => setRemoving(r)} /> : <IconSlot />}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {plan && (
        <PlanDialog action={plan} onClose={() => setPlan(null)}>
          <StaleList force={plan === "prune-force"} />
        </PlanDialog>
      )}
      {rename && <RenameDialog {...rename} onClose={() => setRename(null)} />}
      {alias && <AliasDialog draft={alias} routes={routes} onClose={() => setAlias(null)} />}
      <ConfirmDialog
        open={!!removing}
        title={`Remove ${removing?.hostname ?? ""}?`}
        confirmLabel="Remove alias"
        busy={busy}
        error={removeError}
        onConfirm={() => void remove()}
        onClose={() => {
          setRemoving(null);
          setRemoveError(null);
        }}
      >
        <p className="dialog-text">
          {removing?.hostname} stops opening port {removing?.port}. The server itself keeps running.
        </p>
      </ConfirmDialog>
    </>
  );
}

/** Every route in portless's routes.json, stale ones included (plan §5.2). */
export function RoutesSection() {
  const { state, reload } = useRoutes();
  const routes = valueOf(state);
  return (
    <StatusGate>
      {() => {
        if (!routes) {
          return state.status === "error" ? <ErrorState title="Couldn't read the routes" message={state.error} onRetry={() => void reload()} /> : <LoadingState label="Reading routes…" />;
        }
        if (!routes.length) {
          return (
            <EmptyState icon="link" title="No routes yet">
              An app gets a route when its command runs through <code>portless</code>, and a server portless doesn't start gets one from an alias.
            </EmptyState>
          );
        }
        return <Table routes={routes} />;
      }}
    </StatusGate>
  );
}
