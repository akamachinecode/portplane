import { useSyncExternalStore } from "react";

// Hash routes (plan §6.1, ADR-0028): links work in the native window and the
// browser alike, Back and Forward work, and the tray or a notification can
// point at one thing. Every segment is URL-encoded (app ids and runners are
// paths).
//
// The work, in the main sidebar:
//   #/apps                                  #/addresses/<filter?>/<machine?>
//   #/apps/<machine>/<appId>/<tab?>         #/health
//   #/project/<machine>/<name>/<runner?>/<tab?>
//   #/onboarding/<step?>  (Setup: the guided setup, as a timeline)
//   #/setup/<machine>/<step?>  (the guided setup on a machine over SSH)
//
// Settings, with their own sidebar (ADR-0028):
//   #/settings/<section?>                   #/machines
//   #/runners/<machine?>                    #/dekit/<machine?>
//   #/projects/<machine>/<runner>  (a dekit.yaml and its runner)
//   #/domains/<section?>/<machine?>  (portless: proxy, certificates, sharing…)
//
// Runners, dekit, Domains and Addresses act on one machine (ADR-0026):
// without one in the URL, the machine last picked there; with one, that
// machine. Addresses of the M5 layout (#/domains/routes, aliases, compose,
// doctor) still open where those pages went. Anything else shows the apps.

export const APP_TABS = ["summary", "output", "config", "url"] as const;
export const DOMAIN_SECTIONS = ["proxy", "hosts", "certificates", "sharing", "lan", "config", "maintenance"] as const;
export const SETTINGS_SECTIONS = ["general", "notifications", "updates", "folders", "advanced"] as const;
export const ADDRESS_FILTERS = ["all", "apps", "aliases", "compose", "shared"] as const;
export const PROJECT_TABS = ["apps", "config"] as const;

export type AppTab = (typeof APP_TABS)[number];
export type DomainSection = (typeof DOMAIN_SECTIONS)[number];
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
export type AddressFilter = (typeof ADDRESS_FILTERS)[number];
export type ProjectTab = (typeof PROJECT_TABS)[number];

/** An app in the URL: the machine's id and the app's id (runner#task). */
export interface AppRef {
  machine: string;
  appId: string;
}

/** A project (a git repository, or a task folder outside git) on a machine; the runner tells apart two of the same name. */
export interface ProjectRef {
  machine: string;
  name: string;
  runner?: string;
}

export type Route =
  | { view: "apps"; detail?: AppRef & { tab: AppTab } }
  | ({ view: "project"; tab?: ProjectTab } & ProjectRef)
  | { view: "addresses"; filter: AddressFilter; machine?: string }
  | { view: "health" }
  | { view: "onboarding"; step?: string; machine?: string }
  | { view: "projects"; runner?: { machine: string; root: string } }
  | { view: "domains"; section: DomainSection; machine?: string }
  | { view: "runners"; machine?: string }
  | { view: "dekit"; machine?: string }
  | { view: "machines" }
  | { view: "settings"; section: SettingsSection };

export type View = Route["view"];

export const HOME: Route = { view: "apps" };

const pick = <T extends string>(values: readonly T[], v: string | undefined, fallback: T): T | null =>
  v === undefined || v === "" ? fallback : values.includes(v as T) ? (v as T) : null;

/** The portless pages of the M5 layout that moved (ADR-0028), by their old section. */
const LEGACY_DOMAINS: Record<string, (machine: string | undefined) => Route> = {
  routes: (machine) => (machine ? { view: "addresses", filter: "all", machine } : { view: "addresses", filter: "all" }),
  aliases: (machine) => (machine ? { view: "addresses", filter: "aliases", machine } : { view: "addresses", filter: "aliases" }),
  compose: (machine) => (machine ? { view: "addresses", filter: "compose", machine } : { view: "addresses", filter: "compose" }),
  doctor: () => ({ view: "health" }),
};

/** Parses location.hash ("#/apps/…", with or without the "#"). Unknown routes give the apps. */
export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "").replace(/^\/+/, "").replace(/\/+$/, "");
  let parts: string[];
  try {
    parts = path === "" ? [] : path.split("/").map(decodeURIComponent);
  } catch {
    return HOME; // a malformed escape
  }
  const [view, a, b, c, ...rest] = parts;
  const route = ((): Route | null => {
    switch (view) {
      case undefined:
      case "apps": {
        if (a === undefined) return HOME;
        if (!a || !b || rest.length) return null;
        const tab = pick(APP_TABS, c, "summary");
        return tab && { view: "apps", detail: { machine: a, appId: b, tab } };
      }
      case "project": {
        // #/project/<machine>/<name>/<runner?>/<tab?>: a runner is a path, never a tab's name
        if (!a || !b || c === "" || rest.length > 1) return null;
        const base = { view: "project" as const, machine: a, name: b };
        if (c === undefined) return base;
        if ((PROJECT_TABS as readonly string[]).includes(c)) return rest.length ? null : c === "apps" ? base : { ...base, tab: c as ProjectTab };
        const tab = pick(PROJECT_TABS, rest[0], "apps");
        if (!tab) return null;
        return tab === "apps" ? { ...base, runner: c } : { ...base, runner: c, tab };
      }
      case "projects":
        if (a === undefined) return { view: "projects" };
        if (!a || !b || c !== undefined) return null;
        return { view: "projects", runner: { machine: a, root: b } };
      case "domains": {
        if (c !== undefined || b === "") return null;
        const legacy = a !== undefined ? LEGACY_DOMAINS[a] : undefined;
        if (legacy) return legacy(b);
        const section = pick(DOMAIN_SECTIONS, a, "proxy");
        if (!section) return null;
        return b === undefined ? { view: "domains", section } : { view: "domains", section, machine: b };
      }
      case "addresses": {
        if (c !== undefined || b === "") return null;
        const filter = pick(ADDRESS_FILTERS, a, "all");
        if (!filter) return null;
        return b === undefined ? { view: "addresses", filter } : { view: "addresses", filter, machine: b };
      }
      case "settings": {
        if (b !== undefined) return null;
        if (a === "tools") return { view: "dekit" };
        if (a === "network") return { view: "settings", section: "advanced" };
        const section = pick(SETTINGS_SECTIONS, a, "general");
        return section && { view: "settings", section };
      }
      case "onboarding":
        if (b !== undefined) return null;
        return a ? { view: "onboarding", step: a } : { view: "onboarding" };
      case "setup":
        if (!a || c !== undefined || a === "local") return null;
        return b ? { view: "onboarding", machine: a, step: b } : { view: "onboarding", machine: a };
      case "runners":
      case "dekit":
        if (a === undefined) return { view };
        return a && b === undefined ? { view, machine: a } : null;
      case "machines":
      case "health":
        return a === undefined ? { view } : null;
      default:
        return null;
    }
  })();
  return route ?? HOME;
}

const enc = encodeURIComponent;

/** The hash for a route, "#/…", leaving out default tabs and sections. */
export function href(route: Route): string {
  switch (route.view) {
    case "apps": {
      const d = route.detail;
      if (!d) return "#/apps";
      return `#/apps/${enc(d.machine)}/${enc(d.appId)}${d.tab === "summary" ? "" : `/${d.tab}`}`;
    }
    case "project":
      return `#/project/${enc(route.machine)}/${enc(route.name)}${route.runner ? `/${enc(route.runner)}` : ""}${route.tab && route.tab !== "apps" ? `/${route.tab}` : ""}`;
    case "addresses": {
      const base = route.filter === "all" && !route.machine ? "#/addresses" : `#/addresses/${route.filter}`;
      return route.machine ? `${base}/${enc(route.machine)}` : base;
    }
    case "projects":
      return route.runner ? `#/projects/${enc(route.runner.machine)}/${enc(route.runner.root)}` : "#/projects";
    case "domains":
      if (route.machine) return `#/domains/${route.section}/${enc(route.machine)}`;
      return route.section === "proxy" ? "#/domains" : `#/domains/${route.section}`;
    case "runners":
    case "dekit":
      return route.machine ? `#/${route.view}/${enc(route.machine)}` : `#/${route.view}`;
    case "settings":
      return route.section === "general" ? "#/settings" : `#/settings/${route.section}`;
    case "onboarding":
      if (route.machine && route.machine !== "local") return `#/setup/${enc(route.machine)}${route.step ? `/${enc(route.step)}` : ""}`;
      return route.step ? `#/onboarding/${enc(route.step)}` : "#/onboarding";
    default:
      return `#/${route.view}`;
  }
}

export function sameRoute(a: Route, b: Route): boolean {
  return href(a) === href(b);
}

/** The route of an app's detail panel. */
export function appRoute(machine: string, appId: string, tab: AppTab = "summary"): Route {
  return { view: "apps", detail: { machine, appId, tab } };
}

// ---- browser side ----

let cached: { key: string; route: Route } | null = null;

function current(): Route {
  const route = parseRoute(window.location.hash);
  const key = href(route);
  if (cached?.key !== key) cached = { key, route };
  return cached.route;
}

function subscribe(listener: () => void): () => void {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}

/** The current route, re-rendering on every change (links, Back, Forward, navigate). */
export function useRoute(): Route {
  return useSyncExternalStore(subscribe, current, () => HOME);
}

/**
 * Goes to a route. `replace` swaps the current history entry instead of
 * adding one (switching tabs, normalising an unknown URL).
 */
export function navigate(route: Route, opts: { replace?: boolean } = {}): void {
  const next = href(route);
  if (opts.replace) {
    if (window.location.hash === next) return;
    history.replaceState(history.state, "", next);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    return;
  }
  if (window.location.hash !== next) window.location.hash = next;
}
