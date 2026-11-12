import { Icon } from "../components/Icon";
import { JobsIndicator } from "./JobsIndicator";
import { setSidebarCollapsed, useSidebarCollapsed } from "./sidebarState";

/**
 * The window's toolbar (ADR-0027): the sidebar toggle while it is hidden,
 * the view's title and actions (ViewHeader renders them into the slot), and
 * running jobs. On macOS it is also where the window is dragged from.
 */
export function TopBar({ slotRef }: { slotRef(el: HTMLDivElement | null): void }) {
  const collapsed = useSidebarCollapsed();
  return (
    <header className="toolbar" data-drag-region>
      {collapsed && (
        <button type="button" className="icon-btn toolbar-sidebar" aria-label="Show the sidebar" title="Show the sidebar" onClick={() => setSidebarCollapsed(false)}>
          <Icon name="sidebar" size={16} />
        </button>
      )}
      <div className="toolbar-slot" ref={slotRef} />
      <JobsIndicator />
    </header>
  );
}
