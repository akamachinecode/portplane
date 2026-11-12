import type { IconName } from "../components/Icon";
import type { DomainSection, Route, SettingsSection, View } from "../lib/router";

export interface NavItem {
  view: View;
  label: string;
  icon: IconName;
  route: Route;
}

/**
 * Every top-level view, for the palette's "Go to" and the g-chords. The
 * sidebar shows them in groups (SIDEBAR below), with the projects between.
 */
export const NAV: NavItem[] = [
  { view: "apps", label: "Apps", icon: "apps", route: { view: "apps" } },
  { view: "health", label: "Health", icon: "pulse", route: { view: "health" } },
  { view: "projects", label: "Configuration", icon: "file", route: { view: "projects" } },
  { view: "runners", label: "Runners", icon: "layers", route: { view: "runners" } },
  { view: "domains", label: "Domains", icon: "globe", route: { view: "domains", section: "routes" } },
  { view: "machines", label: "Machines", icon: "machine", route: { view: "machines" } },
];

export const SETTINGS_NAV: NavItem = { view: "settings", label: "Settings", icon: "gear", route: { view: "settings", section: "general" } };

/**
 * portless's sections, grouped the way the sidebar shows them: each group
 * is one sidebar entry, and its sections are tabs on the page. Keeps every
 * portless feature one click from anywhere (ADR-0027).
 */
export interface DomainGroup {
  id: string;
  label: string;
  icon: IconName;
  sections: DomainSection[];
}

export const DOMAIN_GROUPS: DomainGroup[] = [
  { id: "routes", label: "Routes", icon: "link", sections: ["routes", "aliases"] },
  { id: "proxy", label: "Proxy & HTTPS", icon: "shield", sections: ["proxy", "certificates", "hosts", "config"] },
  { id: "sharing", label: "Sharing", icon: "share", sections: ["sharing", "lan", "compose"] },
  { id: "doctor", label: "Doctor", icon: "pulse", sections: ["doctor", "maintenance"] },
];

export function domainGroupOf(section: DomainSection): DomainGroup {
  return DOMAIN_GROUPS.find((g) => g.sections.includes(section)) ?? DOMAIN_GROUPS[0];
}

/** One entry of the sidebar's tool groups. */
export interface ToolLink {
  id: string;
  label: string;
  icon: IconName;
  route: Route;
  /** Whether the current route is this entry's. */
  current(route: Route): boolean;
}

/** The dekit and portless groups of the sidebar: the two tools Portplane is a GUI for. */
export const TOOL_GROUPS: Array<{ id: "dekit" | "portless"; label: string; hint: string; links: ToolLink[] }> = [
  {
    id: "dekit",
    label: "dekit",
    hint: "Starts and watches your dev servers",
    links: [
      { id: "config", label: "Configuration", icon: "file", route: { view: "projects" }, current: (r) => r.view === "projects" },
      { id: "runners", label: "Runners", icon: "layers", route: { view: "runners" }, current: (r) => r.view === "runners" },
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
  routes: "Routes",
  aliases: "Aliases",
  sharing: "Sharing",
  compose: "Compose",
  lan: "LAN mode",
  config: "portless.json",
  certificates: "Certificates",
  hosts: "Hosts file",
  doctor: "Doctor",
  maintenance: "Maintenance",
};

export const SETTINGS_LABELS: Record<SettingsSection, string> = {
  general: "General",
  folders: "Folders",
  tools: "Tools",
  network: "Network",
  advanced: "Advanced",
};
