import type { ConnectionStatus } from "../api/events";
import { useApp } from "../components/AppContext";
import { Icon } from "../components/Icon";
import { StateDot } from "../components/StateDot";
import { isMac, paletteShortcutLabel } from "../lib/keyboard";
import { JobsIndicator } from "./JobsIndicator";
import { useShell } from "./ShellContext";

const CONNECTION: Record<ConnectionStatus, { label: string; title: string }> = {
  connecting: { label: "Connecting…", title: "Connecting to Portplane" },
  live: { label: "Live", title: "Connected: changes show as they happen" },
  reconnecting: { label: "Reconnecting…", title: "Lost the connection to Portplane; retrying" },
  expired: { label: "Disconnected", title: "Portplane restarted; reload the page" },
};

/** Search and run (the palette), the connection, and running jobs. */
export function TopBar({ onSearch }: { onSearch(): void }) {
  const { info } = useApp();
  const { status } = useShell();
  const mac = isMac(info?.os);
  const conn = CONNECTION[status];
  return (
    <header className="topbar">
      <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" width={20} height={20} className="brand-mark topbar-mark" />
      <button
        type="button"
        className="search-trigger"
        onClick={onSearch}
        aria-keyshortcuts={mac ? "Meta+K /" : "Control+K /"}
        aria-label="Search or run a command"
      >
        <Icon name="search" size={15} />
        <span className="search-placeholder">Search or run…</span>
        <kbd className="kbd">{paletteShortcutLabel(mac)}</kbd>
      </button>
      <span className="spacer" />
      <span className={`conn conn-${status}`} title={conn.title} role="status">
        <StateDot state={status} />
        <span className="conn-label">{conn.label}</span>
      </span>
      <JobsIndicator />
    </header>
  );
}
