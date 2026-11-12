import { Icon } from "../components/Icon";
import { href } from "../lib/router";
import { problemBadge } from "./health";
import { NAV, SETTINGS_NAV, type NavItem } from "./nav";
import { useShell } from "./ShellContext";
import { setSidebarCollapsed, useSidebarCollapsed } from "./sidebarState";

interface Badge {
  text: string;
  label: string; // for screen readers
  tone?: "error" | "warning" | "live";
}

function NavLink({ item, badge, collapsed }: { item: NavItem; badge?: Badge; collapsed: boolean }) {
  const { route } = useShell();
  const current = route.view === item.view;
  return (
    <li>
      <a className="nav-item" href={href(item.route)} aria-current={current ? "page" : undefined} title={collapsed ? item.label : undefined}>
        <Icon name={item.icon} size={16} className="nav-icon" />
        <span className="nav-label">{item.label}</span>
        {badge && (
          <span className={`nav-badge${badge.tone ? ` nav-badge-${badge.tone}` : ""}`}>
            <span aria-hidden="true">{badge.text}</span>
            <span className="sr-only">({badge.label})</span>
          </span>
        )}
      </a>
    </li>
  );
}

/** The app's navigation: a column on the left, a tab bar at the bottom of a narrow window. */
export function Sidebar() {
  const { summary, problems } = useShell();
  const collapsed = useSidebarCollapsed();
  const health = problemBadge(problems);
  const badges: Partial<Record<NavItem["view"], Badge>> = {};
  if (summary && summary.running > 0) badges.apps = { text: String(summary.running), label: `${summary.running} running`, tone: "live" };
  if (health.count > 0 && health.tone) {
    badges.health = { text: String(health.count), label: `${health.count} ${health.count === 1 ? "problem" : "problems"}`, tone: health.tone };
  }
  return (
    <nav className="sidebar" aria-label="Main">
      <div className="sidebar-brand">
        <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" width={20} height={20} className="brand-mark" />
        <span className="brand-name">Portplane</span>
      </div>
      <ul className="nav-list">
        {NAV.map((item) => (
          <NavLink key={item.view} item={item} badge={badges[item.view]} collapsed={collapsed} />
        ))}
      </ul>
      <hr className="nav-sep" />
      <ul className="nav-list nav-list-end">
        <NavLink item={SETTINGS_NAV} collapsed={collapsed} />
      </ul>
      <button
        type="button"
        className="nav-item sidebar-toggle"
        aria-pressed={collapsed}
        title={collapsed ? "Expand the sidebar" : "Collapse the sidebar"}
        onClick={() => setSidebarCollapsed(!collapsed)}
      >
        <Icon name="sidebar" size={16} className="nav-icon" />
        <span className="nav-label">Collapse</span>
        <span className="sr-only">{collapsed ? "Expand the sidebar" : ""}</span>
      </button>
    </nav>
  );
}
