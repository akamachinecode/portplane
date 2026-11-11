import type { ConnectionStatus } from "../api/events";
import { summaryParts, type Summary } from "../lib/summary";
import { Icon } from "./Icon";
import { StateDot } from "./StateDot";

const CONNECTION: Record<ConnectionStatus, { label: string; title: string }> = {
  connecting: { label: "Connecting…", title: "Connecting to Portplane" },
  live: { label: "Live", title: "Connected: changes show as they happen" },
  reconnecting: { label: "Reconnecting…", title: "Lost the connection to Portplane; retrying" },
  expired: { label: "Disconnected", title: "Portplane restarted; reload the page" },
};

export function TopBar({ summary, status, onSettings }: { summary: Summary | null; status: ConnectionStatus; onSettings(): void }) {
  const conn = CONNECTION[status];
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <div className="brand">
          <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" width={20} height={20} className="brand-mark" />
          <span className="brand-name">Portplane</span>
        </div>
        {summary && (
          <p className="summary">
            {summaryParts(summary).map((p) => (
              <span key={p.tone} className={`summary-part tone-${p.tone}`}>
                {p.text}
              </span>
            ))}
          </p>
        )}
        <span className="spacer" />
        <span className={`conn conn-${status}`} title={conn.title} role="status">
          <StateDot state={status} />
          <span className="conn-label">{conn.label}</span>
        </span>
        <button type="button" className="btn btn-ghost" onClick={onSettings} aria-label="Folders and settings" title="Folders and settings">
          <Icon name="folder" size={15} />
          <span className="hide-narrow">Folders</span>
        </button>
      </div>
    </header>
  );
}
