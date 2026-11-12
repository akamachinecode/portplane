import type { IconName } from "../components/Icon";
import type { DomainSection, Route, SettingsSection, View } from "../lib/router";

// The app's map (ADR-0028). The main sidebar holds the work, the things a
// user opens every day: apps, their addresses, their health and their
// projects. Everything that configures Portplane, dekit or portless lives in
// Settings, which swaps the sidebar for its own (as Linear's settings do).
// Each thing has one page where all of its actions are; every other place
// shows it as a row that links there.

export interface NavItem {
  view: View;
  label: string;
  icon: IconName;
  route: Route;
}

/** The main sidebar's views, for the palette's "Go to" and the g chords. */
export const NAV: NavItem[] = [
  { view: "apps", label: "Apps", icon: "apps", route: { view: "apps" } },
  { view: "addresses", label: "Addresses", icon: "link", route: { view: "addresses", filter: "all" } },
  { view: "health", label: "Health", icon: "pulse", route: { view: "health" } },
  { view: "onboarding", label: "Setup", icon: "wand", route: { view: "onboarding" } },
];

export const SETTINGS_NAV: NavItem = { view: "settings", label: "Settings", icon: "gear", route: { view: "settings", section: "general" } };

/** Where a view opens when nothing more is said (the g chords, "Go to"). */
export function viewRoute(view: Exclude<View, "project">): Route {
  switch (view) {
    case "apps":
    case "health":
    case "machines":
    case "onboarding":
    case "runners":
    case "dekit":
    case "projects":
      return { view };
    case "addresses":
      return { view, filter: "all" };
    case "domains":
      return { view, section: "proxy" };
    case "settings":
      return { view, section: "general" };
  }
}

/** The views that belong to Settings: while one is open, the sidebar is Settings' own. */
export const SETTINGS_VIEWS: ReadonlySet<View> = new Set<View>(["settings", "machines", "runners", "projects", "dekit", "domains"]);

export function isSettingsRoute(route: Route): boolean {
  return SETTINGS_VIEWS.has(route.view);
}

/**
 * portless's settings pages: each is one entry in Settings' sidebar, and its
 * sections are tabs on the page.
 */
export interface DomainGroup {
  id: string;
  label: string;
  icon: IconName;
  sections: DomainSection[];
  /** What the page is for, in a sentence. */
  text: string;
}

export const DOMAIN_GROUPS: DomainGroup[] = [
  {
    id: "proxy",
    label: "Proxy",
    icon: "shield",
    sections: ["proxy", "hosts"],
    text: "The small local server that answers every .localhost address and passes each request to the right app.",
  },
  {
    id: "certificates",
    label: "Certificates",
    icon: "lock",
    sections: ["certificates"],
    text: "portless signs a certificate for every address with its own authority, so your browsers show the padlock.",
  },
  {
    id: "sharing",
    label: "Sharing",
    icon: "share",
    sections: ["sharing", "lan"],
    text: "Open an app to someone else: on your tailnet, with a public link, or to every device on your Wi-Fi.",
  },
  {
    id: "config",
    label: "portless.json",
    icon: "file",
    sections: ["config"],
    text: "Names and options for apps that run portless run in their own folder.",
  },
  {
    id: "maintenance",
    label: "About portless",
    icon: "info",
    sections: ["maintenance"],
    text: "The portless on this machine: its version, how it was installed, updating and removing it.",
  },
];

export function domainGroupOf(section: DomainSection): DomainGroup {
  return DOMAIN_GROUPS.find((g) => g.sections.includes(section)) ?? DOMAIN_GROUPS[0];
}

/** One entry of Settings' sidebar. */
export interface SettingsLink {
  id: string;
  label: string;
  icon: IconName;
  route: Route;
  /** Whether the current route is this entry's. */
  current(route: Route): boolean;
}

export interface SettingsGroupNav {
  id: "portplane" | "dekit" | "portless";
  label: string;
  hint: string;
  links: SettingsLink[];
}

const settingsLink = (section: SettingsSection, label: string, icon: IconName): SettingsLink => ({
  id: section,
  label,
  icon,
  route: { view: "settings", section },
  current: (r) => r.view === "settings" && r.section === section,
});

/** Settings' sidebar: Portplane's own settings, then dekit's, then portless's. */
export const SETTINGS_GROUPS: SettingsGroupNav[] = [
  {
    id: "portplane",
    label: "Portplane",
    hint: "This app",
    links: [
      settingsLink("general", "General", "gear"),
      settingsLink("notifications", "Notifications", "bell"),
      settingsLink("folders", "Folders", "folder"),
      { id: "machines", label: "Machines", icon: "machine", route: { view: "machines" }, current: (r) => r.view === "machines" },
      settingsLink("updates", "Updates", "arrowUp"),
      settingsLink("advanced", "Advanced", "wand"),
    ],
  },
  {
    id: "dekit",
    label: "dekit",
    hint: "Starts and watches your dev servers",
    links: [
      { id: "runners", label: "Runners", icon: "layers", route: { view: "runners" }, current: (r) => r.view === "runners" || r.view === "projects" },
      { id: "dekit", label: "About dekit", icon: "info", route: { view: "dekit" }, current: (r) => r.view === "dekit" },
    ],
  },
  {
    id: "portless",
    label: "portless",
    hint: "Gives each app its https://….localhost address",
    links: DOMAIN_GROUPS.map((g) => ({
      id: g.id,
      label: g.label,
      icon: g.icon,
      route: { view: "domains", section: g.sections[0] },
      current: (r: Route) => r.view === "domains" && g.sections.includes(r.section),
    })),
  },
];

export const DOMAIN_LABELS: Record<DomainSection, string> = {
  proxy: "Proxy",
  hosts: "Hosts file",
  certificates: "Certificates",
  sharing: "Internet & tailnet",
  lan: "Local network",
  config: "portless.json",
  maintenance: "About portless",
};

export const SETTINGS_LABELS: Record<SettingsSection, string> = {
  general: "General",
  notifications: "Notifications",
  updates: "Updates",
  folders: "Folders",
  advanced: "Advanced",
};
