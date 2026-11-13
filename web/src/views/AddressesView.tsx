import { useMemo, useState, type ReactNode } from "react";
import { errorText } from "../api/errors";
import type { App } from "../api/types";
import { AppIcon } from "../components/AppIcons";
import { copyWithToast } from "../components/appActions";
import { useApp } from "../components/AppContext";
import { ConfirmDialog } from "../components/Dialog";
import { Icon } from "../components/Icon";
import { IconSlot } from "../components/IconButton";
import { MachinePicker, MachineScope, RemoteStatusBanner, useMachineChoice, useMachineScope } from "../components/MachineScope";
import { Menu, type MenuItem } from "../components/Menu";
import { EmptyState, ErrorState, LoadingState } from "../components/States";
import { StateDot } from "../components/StateDot";
import { ViewHeader } from "../components/ViewHeader";
import { useNow } from "../hooks/useNow";
import { addressRows, addressSummary, filterCounts, KIND_NAMES, matchesFilter, type AddressRow } from "../lib/addresses";
import { routeAge } from "../lib/portless";
import { ADDRESS_FILTERS, appRoute, href, navigate, type AddressFilter } from "../lib/router";
import { useShell } from "../shell/ShellContext";
import { AliasDialog, type AliasDraft } from "./domains/AliasDialog";
import { ComposeSection } from "./domains/ComposeSection";
import { PlanDialog } from "./domains/PlanDialog";
import { StatusGate } from "./domains/ProxySection";
import { RenameDialog } from "./domains/RenameDialog";
import { RemoteRouteOpen, SharedLinks, StaleList } from "./domains/routeParts";
import { ShareAppDialog } from "./domains/ShareControls";
import { requestIntent, useIntent, useMachineResources, useRefreshOnJobs, useRoutes, valueOf } from "./domains/store";
import "./domains/commands";
import "./DomainsView.css";
import "./AddressesView.css";

const FILTER_LABELS: Record<AddressFilter, string> = {
  all: "All",
  apps: "Apps",
  aliases: "Aliases",
  compose: "Compose",
  shared: "Shared",
};

const FILTER_EMPTY: Record<AddressFilter, ReactNode> = {
  all: <>An app gets its address the first time it runs through portless; an alias gives one to a port Portplane doesn't start.</>,
  apps: <>No app has an address yet. An app whose command runs through portless gets one when it starts.</>,
  aliases: (
    <>
      An alias gives a stable address to a server portless doesn't start: a database UI, a container, a PHP server. Add one here, or pick a port from <strong>Other ports</strong> on Apps.
    </>
  ),
  compose: <>Docker Compose projects started with portless show here, each service at its own address.</>,
  shared: <>Nothing is shared. Open an app's Address tab to share it on your tailnet or with a public link.</>,
};

/**
 * Addresses (ADR-0028): every https://….localhost name on a machine and
 * where it sends requests, whoever made it: an app (running or not), an
 * alias, a Compose service, Portplane itself. It joins what used to be
 * Routes, Aliases and Compose.
 */
export function AddressesView() {
  const { machine, options, choose } = useMachineChoice("addresses");
  return (
    <MachineScope machine={machine}>
      <AddressesBody key={machine} picker={<MachinePicker machine={machine} options={options} onChange={choose} />} />
    </MachineScope>
  );
}

function AddressesBody({ picker }: { picker: ReactNode }) {
  const { route } = useShell();
  const scope = useMachineScope();
  const filter: AddressFilter = route.view === "addresses" ? route.filter : "all";
  const inUrl = route.view === "addresses" ? route.machine : undefined;
  const { state, reload } = useRoutes();
  const routes = valueOf(state);
  const rows = useMemo(() => addressRows(scope.ms, routes ?? []), [scope.ms, routes]);
  const counts = useMemo(() => filterCounts(rows), [rows]);
  const stale = rows.filter((r) => r.state === "stale").length;
  const [draft, setDraft] = useState<AliasDraft | null>(null);
  const [plan, setPlan] = useState<"prune" | "prune-force" | null>(null);
  useRefreshOnJobs();
  useIntent("new-alias", (i) => setDraft({ port: i.port, name: i.name }));
  // A clean-up fix from Health opens its plan here.
  useIntent("action", (i) => {
    if (i.action === "prune" || i.action === "prune-force") setPlan(i.action);
  });
  const go = (f: AddressFilter) => navigate({ view: "addresses", filter: f, machine: inUrl }, { replace: true });

  const more: MenuItem[] = [
    { label: "Read the addresses again", icon: "restart", onSelect: () => void reload() },
    { label: "Start a Compose project…", icon: "box", onSelect: () => (go("compose"), requestIntent({ kind: "compose-start", machine: scope.id })) },
    { label: "Clean up stale addresses…", icon: "wand", onSelect: () => setPlan("prune") },
    { label: "Force-stop orphaned servers…", icon: "stop", onSelect: () => setPlan("prune-force") },
  ];

  return (
    <>
      <ViewHeader
        title="Addresses"
        summary={routes ? addressSummary(rows) : undefined}
        description={
          <>
            Every <code>.localhost</code> address {scope.remote ? `on ${scope.ms?.machine.name ?? scope.id}` : "on this computer"} and where it sends each request. An app keeps its
            address while it's stopped and gets it back when it starts; an alias gives one to a server Portplane doesn't start.
          </>
        }
        actions={
          <>
            {picker}
            <Menu label="More address actions" items={more} />
            <button type="button" className="btn btn-primary" onClick={() => setDraft({})}>
              <Icon name="plus" size={14} />
              New alias
            </button>
          </>
        }
      />
      <RemoteStatusBanner />
      <StatusGate>
        {() => (
          <>
            <div className="filter-bar" role="tablist" aria-label="Show">
              {ADDRESS_FILTERS.map((f) => (
                <button key={f} type="button" role="tab" aria-selected={f === filter} className="filter-chip" onClick={() => go(f)}>
                  {FILTER_LABELS[f]}
                  <span className="filter-count">{counts[f]}</span>
                </button>
              ))}
            </div>
            {stale > 0 && filter !== "compose" && (
              <div className="callout callout-warn">
                <Icon name="warning" size={15} />
                <p>
                  {stale === 1 ? "One address points" : `${stale} addresses point`} at a server that is gone. Cleaning up removes {stale === 1 ? "it" : "them"} from portless; nothing else changes.
                </p>
                <button type="button" className="btn btn-sm" onClick={() => setPlan("prune")}>
                  Clean up
                </button>
              </div>
            )}
            {filter === "compose" ? (
              <ComposeSection />
            ) : !routes ? (
              state.status === "error" ? (
                <ErrorState title="Couldn't read the addresses" message={state.error} onRetry={() => void reload()} />
              ) : (
                <LoadingState label="Reading addresses…" />
              )
            ) : (
              <AddressTable rows={rows.filter((r) => matchesFilter(r, filter))} empty={FILTER_EMPTY[filter]} onEditAlias={setDraft} />
            )}
          </>
        )}
      </StatusGate>
      {draft && <AliasDialog draft={draft} routes={routes ?? []} onClose={() => setDraft(null)} />}
      {plan && (
        <PlanDialog action={plan} onClose={() => setPlan(null)}>
          <StaleList force={plan === "prune-force"} />
        </PlanDialog>
      )}
    </>
  );
}

function From({ row, machine }: { row: AddressRow; machine: string }) {
  const app = row.app;
  if (app) {
    return (
      <a className="from-app" href={href(appRoute(machine, app.id))}>
        <span className="from-project">{[app.project, app.worktree].filter(Boolean).join(" · ")}</span>
        <span className="from-sep">/</span>
        <span className="from-name">{app.label}</span>
      </a>
    );
  }
  const o = row.route?.owner;
  if (row.kind === "compose") return <span>{row.route?.compose ?? "Compose"}</span>;
  if (row.kind === "portplane") return <span>Portplane's own window</span>;
  if (!o) return <span className="muted">Nothing listens there</span>;
  return (
    <span title={o.pid ? `PID ${o.pid}` : undefined}>
      {o.label}
      {o.kind === "process" && o.pid && o.label !== `PID ${o.pid}` && <span className="muted"> · PID {o.pid}</span>}
    </span>
  );
}

const STATE_TEXT: Record<AddressRow["state"], string> = { live: "Live", starting: "Starting", off: "Off", stale: "Stale" };
const STATE_DOT = { live: "on", starting: "starting", off: "off", stale: "failed" } as const;

function AddressTable({ rows, empty, onEditAlias }: { rows: AddressRow[]; empty: ReactNode; onEditAlias(d: AliasDraft): void }) {
  const ctx = useApp();
  const scope = useMachineScope();
  const ms = scope.ms;
  const { put } = useMachineResources().routes;
  const now = useNow(true, 30_000);
  const [rename, setRename] = useState<{ appId: string; machine: string; route?: string; label: string; runner?: string } | null>(null);
  const [share, setShare] = useState<App | null>(null);
  const [removing, setRemoving] = useState<AddressRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const remote = scope.remote;

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

  const addressMenu = (row: AddressRow, url: string): MenuItem[] => {
    const app = row.app;
    const items: MenuItem[] = [{ label: "Copy address", icon: "copy", onSelect: () => void copyWithToast(ctx, url, "the address") }];
    if (app && ms) {
      items.push({ label: "Share…", icon: "share", onSelect: () => setShare(app) });
      items.push({ label: "Change the address…", icon: "pencil", onSelect: () => setRename({ appId: app.id, machine: ms.machine.id, label: app.label, runner: app.runner }) });
      items.push({ label: "Show the app", icon: "panelRight", onSelect: () => navigate(appRoute(ms.machine.id, app.id)) });
    } else if (row.kind === "compose" && row.state === "live" && ms) {
      items.push({ label: "Change the address…", icon: "pencil", onSelect: () => setRename({ appId: "", route: row.hostname, machine: ms.machine.id, label: row.hostname }) });
    } else if (row.kind === "alias" && row.port) {
      const port = row.port;
      items.push({ label: "Edit alias…", icon: "pencil", onSelect: () => onEditAlias({ from: row.hostname, name: row.hostname.replace(/\.[^.]+$/, ""), port }) });
    }
    if (row.kind === "alias") items.push({ label: "Remove alias…", icon: "trash", onSelect: () => setRemoving(row) });
    return items;
  };

  if (!rows.length) {
    return (
      <EmptyState icon="link" title="Nothing here yet">
        {empty}
      </EmptyState>
    );
  }

  return (
    <>
      <div className="table-wrap">
        <table className="table addr-table">
          <thead>
            <tr>
              <th scope="col">Address</th>
              <th scope="col">Sends to</th>
              <th scope="col">From</th>
              <th scope="col">State</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const app = row.app;
              const live = row.state === "live";
              const url = remote && app?.remoteUrl ? app.remoteUrl : (row.url ?? `https://${row.hostname}`);
              const age = live ? routeAge(row.registeredAt, now) : null;
              return (
                <tr key={row.hostname} className={`addr-row is-${row.state}`}>
                  <td className="addr-cell">
                    <span className="addr-main">
                      {app && ms ? <AppIcon ms={ms} app={app} size={22} /> : <span className={`addr-kind-icon kind-${row.kind}`} aria-hidden="true"><Icon name={row.kind === "compose" ? "box" : row.kind === "portplane" ? "monitor" : "plug"} size={13} /></span>}
                      {live && !remote ? (
                        <a className="addr" href={url} target="_blank" rel="noopener">
                          {row.hostname}
                        </a>
                      ) : (
                        <span className={live ? "addr" : "addr addr-idle"}>{row.hostname}</span>
                      )}
                      {row.route && <SharedLinks r={row.route} />}
                    </span>
                  </td>
                  <td className="mono addr-port">{row.port ? `:${row.port}` : <span className="muted">—</span>}</td>
                  <td className="addr-from">
                    {/* an app's row needs no label; anything else says what it is */}
                    {!app && <span className="tag">{KIND_NAMES[row.kind]}</span>}
                    <From row={row} machine={scope.id} />
                  </td>
                  <td>
                    <span className="inline-state" title={age ? `Live for ${age}` : undefined}>
                      <StateDot state={STATE_DOT[row.state]} />
                      {STATE_TEXT[row.state]}
                    </span>
                  </td>
                  <td className="row-actions-cell">
                    {/* the same two slots on every row: open (while live), then ⋯ with the rest */}
                    <span className="table-actions">
                      {!live ? (
                        <IconSlot />
                      ) : remote && row.route ? (
                        <RemoteRouteOpen r={row.route} app={app} />
                      ) : remote && !app?.remoteUrl ? (
                        <IconSlot />
                      ) : (
                        <a className="icon-btn" href={url} target="_blank" rel="noopener" aria-label={`Open ${row.hostname}`} title={`Open ${row.hostname}`}>
                          <Icon name="open" />
                        </a>
                      )}
                      <Menu label={`More for ${row.hostname}`} items={addressMenu(row, url)} />
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rename && <RenameDialog {...rename} onClose={() => setRename(null)} />}
      {share && ms && <ShareAppDialog ms={ms} app={share} onClose={() => setShare(null)} />}
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
