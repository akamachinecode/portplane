import { useSyncExternalStore } from "react";

// Hash routes (plan §6.1): links work in the native window and the browser
// alike, Back and Forward work, and the tray or a notification can point at
// one thing. Every segment is URL-encoded (app ids and runners are paths).
//
//   #/apps                                  #/runners
//   #/apps/<machine>/<appId>/<tab?>         #/machines
//   #/projects                              #/health
//   #/projects/<machine>/<runner>           #/settings/<section?>
//   #/domains/<section?>                    #/onboarding/<step?>
//
// Anything else shows the apps.

export const APP_TABS = ["summary", "output", "config", "url"] as const;
export const DOMAIN_SECTIONS = ["proxy", "routes", "aliases", "config", "certificates", "hosts", "doctor", "maintenance"] as const;
export const SETTINGS_SECTIONS = ["general", "folders", "tools", "network", "advanced"] as const;

export type AppTab = (typeof APP_TABS)[number];
export type DomainSection = (typeof DOMAIN_SECTIONS)[number];
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** An app in the URL: the machine's id and the app's id (runner#task). */
export interface AppRef {
  machine: string;
  appId: string;
}

export type Route =
  | { view: "apps"; detail?: AppRef & { tab: AppTab } }
  | { view: "projects"; runner?: { machine: string; root: string } }
  | { view: "domains"; section: DomainSection }
  | { view: "runners" }
  | { view: "machines" }
  | { view: "health" }
  | { view: "settings"; section: SettingsSection }
  | { view: "onboarding"; step?: string };

export type View = Route["view"];

export const HOME: Route = { view: "apps" };

const pick = <T extends string>(values: readonly T[], v: string | undefined, fallback: T): T | null =>
  v === undefined || v === "" ? fallback : values.includes(v as T) ? (v as T) : null;

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
      case "projects":
        if (a === undefined) return { view: "projects" };
        if (!a || !b || c !== undefined) return null;
        return { view: "projects", runner: { machine: a, root: b } };
      case "domains": {
        const section = b === undefined ? pick(DOMAIN_SECTIONS, a, "proxy") : null;
        return section && { view: "domains", section };
      }
      case "settings": {
        const section = b === undefined ? pick(SETTINGS_SECTIONS, a, "general") : null;
        return section && { view: "settings", section };
      }
      case "onboarding":
        if (b !== undefined) return null;
        return a ? { view: "onboarding", step: a } : { view: "onboarding" };
      case "runners":
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
    case "projects":
      return route.runner ? `#/projects/${enc(route.runner.machine)}/${enc(route.runner.root)}` : "#/projects";
    case "domains":
      return route.section === "proxy" ? "#/domains" : `#/domains/${route.section}`;
    case "settings":
      return route.section === "general" ? "#/settings" : `#/settings/${route.section}`;
    case "onboarding":
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
