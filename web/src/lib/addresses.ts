import type { RouteView, SharedUrl } from "../api/portless";
import type { App, MachineSnapshot } from "../api/types";
import type { AddressFilter } from "./router";

// The Addresses page (ADR-0028): every name portless answers on a machine,
// and every name an app will get when it starts, in one list. portless's
// routes say what answers now; the snapshot says which app each name
// belongs to, including apps that are stopped (their name is kept for them).

export type AddressKind = "app" | "alias" | "compose" | "portplane" | "terminal" | "remote";
export type AddressState = "live" | "starting" | "off" | "stale";

export interface AddressRow {
  hostname: string;
  /** Where it opens, when known. */
  url?: string;
  /** The port the name sends requests to (what the app or server listens on). */
  port?: number;
  kind: AddressKind;
  state: AddressState;
  /** The app the name belongs to. */
  app?: App;
  /** portless's route, when there is one now. */
  route?: RouteView;
  shared: SharedUrl[];
  registeredAt?: number;
}

export const KIND_NAMES: Record<AddressKind, string> = {
  app: "App",
  alias: "Alias",
  compose: "Compose",
  portplane: "Portplane",
  terminal: "Terminal",
  remote: "Other machine",
};

/** What a route is, from who registered it. */
function kindOf(r: RouteView, app: App | undefined): AddressKind {
  if (r.kind === "compose") return "compose";
  if (r.kind === "remote") return "remote";
  if (r.kind === "alias") return r.owner?.kind === "portplane" ? "portplane" : "alias";
  // an app's route: one dekit started, or `portless run` in a terminal
  return app ? "app" : "terminal";
}

const STATE_ORDER: Record<AddressState, number> = { live: 0, starting: 1, stale: 2, off: 3 };

/**
 * Every address of a machine: portless's routes, joined with the apps they
 * belong to, then the apps whose name has no route right now (stopped, or
 * started a moment ago). Live first, then by name.
 */
export function addressRows(ms: MachineSnapshot | null | undefined, routes: RouteView[]): AddressRow[] {
  const apps = (ms?.apps ?? []).filter((a) => a.kind !== "job" && a.hostname);
  const byHost = new Map(apps.map((a) => [a.hostname!, a]));
  const byId = new Map(apps.map((a) => [a.id, a]));
  const rows: AddressRow[] = [];
  const seen = new Set<string>();
  for (const r of routes) {
    const owner = r.owner?.appId ? byId.get(r.owner.appId) : undefined;
    const app = owner ?? (r.kind === "app" ? byHost.get(r.hostname) : undefined);
    seen.add(r.hostname);
    rows.push({
      hostname: r.hostname,
      url: r.url,
      port: r.port,
      kind: kindOf(r, app),
      state: r.alive ? "live" : "stale",
      app,
      route: r,
      shared: r.shared,
      registeredAt: r.registeredAt,
    });
  }
  for (const app of apps) {
    const host = app.hostname!;
    if (seen.has(host)) continue;
    seen.add(host);
    const state: AddressState = app.state === "on" ? "live" : app.state === "starting" ? "starting" : "off";
    rows.push({ hostname: host, url: app.url, port: state === "off" ? undefined : app.port, kind: "app", state, app, shared: [] });
  }
  return rows.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.hostname.localeCompare(b.hostname));
}

export function matchesFilter(row: AddressRow, filter: AddressFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "apps":
      return row.kind === "app" || row.kind === "terminal";
    case "aliases":
      return row.kind === "alias" || row.kind === "portplane";
    case "compose":
      return row.kind === "compose";
    case "shared":
      return row.shared.length > 0;
  }
}

export function filterCounts(rows: AddressRow[]): Record<AddressFilter, number> {
  const out: Record<AddressFilter, number> = { all: 0, apps: 0, aliases: 0, compose: 0, shared: 0 };
  for (const r of rows) for (const f of Object.keys(out) as AddressFilter[]) if (matchesFilter(r, f)) out[f]++;
  return out;
}

