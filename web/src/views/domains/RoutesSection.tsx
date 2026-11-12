import { useMemo } from "react";
import type { Snapshot, State } from "../../api/types";
import { EmptyState } from "../../components/States";
import { StateDot } from "../../components/StateDot";
import { appHref, bookmarkUrl } from "../../lib/apps";
import { stateLabel } from "../../lib/format";
import { appRoute, href, type Route } from "../../lib/router";
import { SnapshotGate } from "../../shell/SnapshotGate";

interface RouteRow {
  key: string;
  hostname: string;
  url?: string; // where it opens now
  machine: string;
  owner: { label: string; route?: Route };
  kind: "app" | "alias";
  port?: number;
  state?: State;
}

/** The routes the snapshot can tell: each app's hostname, and aliases pointing at other ports. */
export function snapshotRoutes(snapshot: Snapshot): RouteRow[] {
  const rows: RouteRow[] = [];
  for (const ms of snapshot.machines) {
    for (const app of ms.apps) {
      if (!app.hostname) continue;
      rows.push({
        key: `${ms.machine.id}|${app.id}`,
        hostname: app.hostname,
        url: app.state === "on" ? appHref(app, ms.machine) : ms.machine.local ? bookmarkUrl(app, ms.tools) : undefined,
        machine: ms.machine.name,
        owner: { label: [app.project, app.worktree, app.label].filter(Boolean).join(" · "), route: appRoute(ms.machine.id, app.id) },
        kind: "app",
        port: app.port,
        state: app.state,
      });
    }
    for (const p of ms.otherPorts) {
      if (!p.route) continue;
      rows.push({
        key: `${ms.machine.id}|port|${p.port}`,
        hostname: p.route,
        url: ms.machine.local ? p.url : undefined,
        machine: ms.machine.name,
        owner: { label: p.process ? `${p.process}${p.pid ? ` (pid ${p.pid})` : ""}` : "another process" },
        kind: "alias",
        port: p.port,
      });
    }
  }
  return rows.sort((a, b) => a.hostname.localeCompare(b.hostname));
}

function Table({ snapshot }: { snapshot: Snapshot }) {
  const rows = useMemo(() => snapshotRoutes(snapshot), [snapshot]);
  const multi = snapshot.machines.length > 1;
  if (rows.length === 0) {
    return (
      <EmptyState icon="link" title="No routes yet">
        An app gets a route when its command runs through <code>portless</code>. Setup does that for the apps it finds.
      </EmptyState>
    );
  }
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Hostname</th>
            <th scope="col">Points to</th>
            {multi && <th scope="col">Machine</th>}
            <th scope="col" className="num">
              Port
            </th>
            <th scope="col">State</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>
                {r.url ? (
                  <a className="addr" href={r.url} target="_blank" rel="noopener">
                    {r.hostname}
                  </a>
                ) : (
                  <span className="addr addr-idle">{r.hostname}</span>
                )}
              </td>
              <td>
                {r.owner.route ? <a href={href(r.owner.route)}>{r.owner.label}</a> : r.owner.label}
                {r.kind === "alias" && <span className="tag table-tag">alias</span>}
              </td>
              {multi && <td className="muted">{r.machine}</td>}
              <td className="num mono">{r.port ? `:${r.port}` : <span className="muted">—</span>}</td>
              <td>
                {r.state ? (
                  <span className="inline-state">
                    <StateDot state={r.state} />
                    {stateLabel(r.state)}
                  </span>
                ) : (
                  <span className="inline-state">
                    <StateDot state="on" />
                    Listening
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Every .localhost route the snapshot knows (the full table from routes.json comes with M5.2). */
export function RoutesSection() {
  return <SnapshotGate>{(snapshot) => <Table snapshot={snapshot} />}</SnapshotGate>;
}
