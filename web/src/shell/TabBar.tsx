import { Icon, type IconName } from "../components/Icon";
import { href, type Route, type View } from "../lib/router";
import { useShell } from "./ShellContext";

const TABS: Array<{ label: string; icon: IconName; route: Route; views: View[] }> = [
  { label: "Apps", icon: "apps", route: { view: "apps" }, views: ["apps", "project"] },
  { label: "Health", icon: "pulse", route: { view: "health" }, views: ["health"] },
  { label: "dekit", icon: "layers", route: { view: "projects" }, views: ["projects", "runners"] },
  { label: "portless", icon: "globe", route: { view: "domains", section: "routes" }, views: ["domains"] },
  { label: "Settings", icon: "gear", route: { view: "settings", section: "general" }, views: ["settings", "machines"] },
];

/** The navigation of a narrow window, along the bottom, instead of the sidebar. */
export function TabBar() {
  const { route } = useShell();
  return (
    <nav className="tabbar" aria-label="Main">
      <ul>
        {TABS.map((t) => (
          <li key={t.label}>
            <a className="tabbar-item" href={href(t.route)} aria-current={t.views.includes(route.view) ? "page" : undefined}>
              <Icon name={t.icon} size={18} />
              <span>{t.label}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
