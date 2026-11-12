import { describe, expect, it } from "vitest";
import { mockSnapshot } from "../api/mock";
import type { RouteView } from "../api/portless";
import { addressRows, addressSummary, filterCounts, matchesFilter } from "./addresses";

const local = mockSnapshot("default").machines[0];
const web = local.apps.find((a) => a.task === "my-monorepo/web")!;

const route = (r: Partial<RouteView> & Pick<RouteView, "hostname" | "port">): RouteView => ({
  pid: 1,
  alive: true,
  kind: "app",
  shared: [],
  url: `https://${r.hostname}`,
  ...r,
});

describe("addressRows", () => {
  it("joins portless's routes with the apps they belong to, and keeps stopped apps' names", () => {
    const rows = addressRows(local, [
      route({ hostname: web.hostname!, port: 4514, owner: { kind: "app", label: "web", appId: web.id, machine: "local" } }),
      route({ hostname: "pgadmin.localhost", port: 5050, kind: "alias", pid: 0, owner: { kind: "process", label: "pgadmin", pid: 77 } }),
      route({ hostname: "portplane.localhost", port: 39001, kind: "alias", pid: 0, owner: { kind: "portplane", label: "Portplane" } }),
      route({ hostname: "old.localhost", port: 4519, alive: false }),
    ]);
    const by = new Map(rows.map((r) => [r.hostname, r]));
    expect(by.get(web.hostname!)).toMatchObject({ kind: "app", state: "live", port: 4514, app: web });
    expect(by.get("pgadmin.localhost")).toMatchObject({ kind: "alias", state: "live" });
    expect(by.get("portplane.localhost")?.kind).toBe("portplane");
    // a route whose app isn't known: started with portless in a terminal
    expect(by.get("old.localhost")).toMatchObject({ kind: "terminal", state: "stale" });
    // a stopped app with no route still has its address
    const site = local.apps.find((a) => a.task === "blog/site")!;
    expect(by.get(site.hostname!)).toMatchObject({ kind: "app", state: "off", app: site, port: undefined });
    // jobs have no address
    expect(rows.some((r) => r.app?.kind === "job")).toBe(false);
  });

  it("lists live addresses first, then by name", () => {
    const rows = addressRows(local, []);
    const states = rows.map((r) => r.state);
    expect(states.indexOf("off")).toBeGreaterThan(states.lastIndexOf("live"));
  });

  it("counts every filter and sums up the live and stale ones", () => {
    const rows = addressRows(local, [
      route({ hostname: "pgadmin.localhost", port: 5050, kind: "alias", pid: 0, shared: [{ kind: "tailscale", url: "https://box.ts.net" }] }),
      route({ hostname: "gone.localhost", port: 1, alive: false }),
    ]);
    const counts = filterCounts(rows);
    expect(counts.all).toBe(rows.length);
    expect(counts.aliases).toBe(1);
    expect(counts.shared).toBe(1);
    expect(rows.filter((r) => matchesFilter(r, "apps")).every((r) => r.kind === "app" || r.kind === "terminal")).toBe(true);
    expect(addressSummary(rows)).toMatch(/live · 1 stale$/);
  });
});
