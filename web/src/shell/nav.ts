import type { IconName } from "../components/Icon";
import type { DomainSection, Route, SettingsSection, View } from "../lib/router";

export interface NavItem {
  view: View;
  label: string;
  icon: IconName;
  route: Route;
}

/** The sidebar, top to bottom (Settings sits apart, under a separator). */
export const NAV: NavItem[] = [
  { view: "apps", label: "Apps", icon: "apps", route: { view: "apps" } },
  { view: "projects", label: "Projects", icon: "box", route: { view: "projects" } },
  { view: "domains", label: "Domains", icon: "globe", route: { view: "domains", section: "proxy" } },
  { view: "runners", label: "Runners", icon: "layers", route: { view: "runners" } },
  { view: "machines", label: "Machines", icon: "machine", route: { view: "machines" } },
  { view: "health", label: "Health", icon: "pulse", route: { view: "health" } },
];

export const SETTINGS_NAV: NavItem = { view: "settings", label: "Settings", icon: "gear", route: { view: "settings", section: "general" } };

export const DOMAIN_LABELS: Record<DomainSection, string> = {
  proxy: "Proxy",
  routes: "Routes",
  aliases: "Aliases",
  certificates: "Certificates",
  hosts: "Hosts file",
  doctor: "Doctor",
};

export const SETTINGS_LABELS: Record<SettingsSection, string> = {
  general: "General",
  folders: "Folders",
  tools: "Tools",
  network: "Network",
  advanced: "Advanced",
};
