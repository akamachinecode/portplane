import { useState } from "react";
import { errorText } from "../../api/errors";
import type { RouteView } from "../../api/portless";
import { copyWithToast } from "../../components/appActions";
import { useApp } from "../../components/AppContext";
import { ConfirmDialog } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { EmptyState, ErrorState, LoadingState } from "../../components/States";
import { useNow } from "../../hooks/useNow";
import { isUserAlias, routeAge } from "../../lib/portless";
import { AliasDialog, type AliasDraft } from "./AliasDialog";
import { StatusGate } from "./ProxySection";
import { useIntent, useMachineResources, useRoutes, valueOf } from "./store";
import { useMachineScope } from "../../components/MachineScope";

function List({ routes }: { routes: RouteView[] }) {
  const ctx = useApp();
  const { remote } = useMachineScope();
  const { put } = useMachineResources().routes;
  const now = useNow(true, 30_000);
  const [draft, setDraft] = useState<AliasDraft | null>(null);
  const [removing, setRemoving] = useState<RouteView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useIntent("new-alias", (i) => setDraft({ port: i.port, name: i.name }));
  const aliases = routes.filter(isUserAlias).sort((a, b) => a.hostname.localeCompare(b.hostname));
  const own = routes.find((r) => r.owner?.kind === "portplane");

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    setError(null);
    try {
      put(await ctx.api.portlessRemoveAlias(removing.hostname));
      ctx.toast.info(`Removed ${removing.hostname}`);
      setRemoving(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="section-bar">
        <p className="section-bar-text">For servers portless can't start: a database UI, a container, a PHP server. Each alias points a name at a port.</p>
        <span className="spacer" />
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setDraft({})}>
          <Icon name="plus" size={13} />
          New alias
        </button>
      </div>
      {aliases.length === 0 ? (
        <EmptyState icon="plug" title="No aliases yet">
          Give a stable URL to a server portless doesn't start. Pick one from <strong>Other ports</strong> on the Apps view, or add one here.
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Address</th>
                <th scope="col">Points to</th>
                <th scope="col">Listening there</th>
                <th scope="col" className="num">
                  Age
                </th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {aliases.map((r) => (
                <tr key={r.hostname}>
                  <td>
                    {remote ? (
                      // It points at that machine's own loopback (ADR-0016).
                      <span className="addr">{r.hostname}</span>
                    ) : (
                      <a className="addr" href={r.url} target="_blank" rel="noopener">
                        {r.hostname}
                      </a>
                    )}
                  </td>
                  <td className="mono">127.0.0.1:{r.port}</td>
                  <td>{r.owner ? r.owner.label : <span className="warn-text">Nothing: start the server, or remove the alias</span>}</td>
                  <td className="num mono">{routeAge(r.registeredAt, now) ?? "—"}</td>
                  <td className="row-actions-cell">
                    <span className="table-actions">
                      <IconButton icon="copy" label={`Copy ${r.url}`} onClick={() => void copyWithToast(ctx, r.url, "the URL")} />
                      <IconButton icon="pencil" label={`Edit ${r.hostname}`} onClick={() => setDraft({ from: r.hostname, name: r.hostname.replace(/\.[^.]+$/, ""), port: r.port })} />
                      <IconButton icon="trash" label={`Remove ${r.hostname}`} onClick={() => setRemoving(r)} />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {own && (
        <p className="section-foot muted">
          <span className="mono">{own.hostname}</span> is Portplane's own alias, to port {own.port}. It goes away when Portplane quits.
        </p>
      )}
      {draft && <AliasDialog draft={draft} routes={routes} onClose={() => setDraft(null)} />}
      <ConfirmDialog
        open={!!removing}
        title={`Remove ${removing?.hostname ?? ""}?`}
        confirmLabel="Remove alias"
        busy={busy}
        error={error}
        onConfirm={() => void remove()}
        onClose={() => {
          setRemoving(null);
          setError(null);
        }}
      >
        <p className="dialog-text">
          {removing?.hostname} stops opening port {removing?.port}. The server itself keeps running. A dekit job that registers this alias adds it again the next time it runs.
        </p>
      </ConfirmDialog>
    </>
  );
}

/** Static routes to servers portless can't wrap (plan §5.3). */
export function AliasesSection() {
  const { state, reload } = useRoutes();
  const routes = valueOf(state);
  return (
    <StatusGate>
      {() =>
        routes ? <List routes={routes} /> : state.status === "error" ? <ErrorState title="Couldn't read the routes" message={state.error} onRetry={() => void reload()} /> : <LoadingState label="Reading aliases…" />
      }
    </StatusGate>
  );
}
