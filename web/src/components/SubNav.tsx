import { href, type Route } from "../lib/router";
import { Icon, type IconName } from "./Icon";

export interface SubNavItem {
  route: Route;
  label: string;
  icon?: IconName;
  current: boolean;
}

/**
 * Links between a view's sections: a column when wide and a scrolling row
 * when narrow (Settings), or a row of tabs along the top (portless's pages).
 */
export function SubNav({ label, items, variant = "column" }: { label: string; items: SubNavItem[]; variant?: "column" | "tabs" }) {
  return (
    <nav className={variant === "tabs" ? "subnav subnav-tabs" : "subnav"} aria-label={label}>
      <ul>
        {items.map((item) => (
          <li key={item.label}>
            <a className="subnav-item" href={href(item.route)} aria-current={item.current ? "page" : undefined}>
              {item.icon && <Icon name={item.icon} size={15} />}
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
