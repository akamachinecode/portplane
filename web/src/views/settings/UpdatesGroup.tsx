import { useEffect, useState } from "react";
import { errorText } from "../../api/errors";
import type { UpdateCheck, UpdateItem } from "../../api/polish";
import type { Preferences } from "../../api/types";
import { useApp } from "../../components/AppContext";
import { Icon, Spinner } from "../../components/Icon";
import { Segmented } from "../../components/Segmented";
import { StateDot } from "../../components/StateDot";
import { useNow } from "../../hooks/useNow";
import { href } from "../../lib/router";
import { timeAgo } from "../../lib/timeAgo";
import { useShell } from "../../shell/ShellContext";
import { SettingRow, SettingsGroup } from "./SettingsGroup";
import "./updates.css";

const UPDATE_OPTIONS = [
  { value: "manual" as Preferences["updateCheck"], label: "When I ask" },
  { value: "auto" as Preferences["updateCheck"], label: "Once a day" },
];

type Load = { status: "loading" } | { status: "ok"; last: UpdateCheck | null } | { status: "error"; message: string };

/** What to do about one tool's answer: nothing, read what is new, or update it where it is installed. */
function UpdateRow({ item }: { item: UpdateItem }) {
  const version = item.installed ? <span className="mono">{item.installed}</span> : <span className="muted">Not installed</span>;
  let status;
  if (item.error) status = <span className="update-status update-error">Couldn't check: {item.error}</span>;
  else if (item.update)
    status = (
      <span className="update-status update-new">
        <strong className="mono">{item.latest}</strong> is out
      </span>
    );
  else if (item.installed) status = <span className="update-status muted">Up to date</span>;
  else status = <span className="update-status muted">Latest is {item.latest}</span>;

  return (
    <li className="update-row">
      <StateDot state={item.error ? "unknown" : item.update ? "starting" : "on"} />
      <span className="update-name">{item.name}</span>
      <span className="update-version">{version}</span>
      {status}
      <span className="update-actions">
        {item.notes && item.update && (
          <a className="btn btn-sm btn-ghost" href={item.notes} target="_blank" rel="noopener noreferrer">
            What's new
            <Icon name="open" size={13} />
          </a>
        )}
        {item.update && item.id !== "portplane" && (
          <a className="btn btn-sm" href={href({ view: "settings", section: "tools" })}>
            Update in Tools
          </a>
        )}
        {item.update && item.id === "portplane" && (
          <a className="btn btn-sm" href={item.notes ?? "https://github.com/akamachinecode/portplane/releases/latest"} target="_blank" rel="noopener noreferrer" title="Install it the same way you installed this one: your package manager, Homebrew or the archive.">
            Get Portplane {item.latest}
          </a>
        )}
      </span>
    </li>
  );
}

/**
 * Settings → General → Updates (ADR-0025): checks Portplane, dekit and
 * portless on a click, or at most once a day when the user turns it on.
 * It only reads; updating happens in Settings → Tools.
 */
export function UpdatesGroup({ prefs }: { prefs: Preferences }) {
  const { api } = useApp();
  const { updatePreferences } = useShell();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [checking, setChecking] = useState(false);
  const now = useNow(load.status === "ok" && !!load.last, 30_000);

  useEffect(() => {
    let live = true;
    api.updates().then(
      (last) => live && setLoad({ status: "ok", last }),
      (err: unknown) => live && setLoad({ status: "error", message: errorText(err) }),
    );
    return () => {
      live = false;
    };
  }, [api]);

  const check = async () => {
    setChecking(true);
    try {
      setLoad({ status: "ok", last: await api.checkUpdates() });
    } catch (err) {
      setLoad({ status: "error", message: errorText(err) });
    } finally {
      setChecking(false);
    }
  };

  const last = load.status === "ok" ? load.last : null;
  const updates = last?.items.filter((i) => i.update).length ?? 0;
  return (
    <SettingsGroup
      title="Updates"
      description="Portplane goes online for this only when you check, or once a day if you choose so. It reads the latest versions from GitHub and the npm registry, sends nothing about you, and never installs anything by itself."
    >
      <SettingRow label="Check for new versions" description="Of Portplane, dekit and portless.">
        <Segmented label="Check for new versions" value={prefs.updateCheck} options={UPDATE_OPTIONS} onChange={(updateCheck) => void updatePreferences((x) => ({ ...x, updateCheck }))} />
      </SettingRow>
      <div className="updates" aria-busy={checking || load.status === "loading" || undefined}>
        <div className="updates-head">
          <p className="updates-summary" role="status">
            {load.status === "loading"
              ? "Loading the last check…"
              : load.status === "error"
                ? `Couldn't check: ${load.message}`
                : !last
                  ? "Not checked yet."
                  : `${updates === 0 ? "Everything is up to date" : updates === 1 ? "1 update available" : `${updates} updates available`} · checked ${timeAgo(last.checkedAt, now)}`}
          </p>
          <button type="button" className="btn" aria-busy={checking || undefined} aria-disabled={checking || undefined} onClick={() => !checking && void check()}>
            {checking ? <Spinner /> : <Icon name="restart" size={14} />}
            {checking ? "Checking…" : "Check for updates"}
          </button>
        </div>
        {last && (
          <ul className="update-list">
            {last.items.map((item) => (
              <UpdateRow key={item.id} item={item} />
            ))}
          </ul>
        )}
      </div>
    </SettingsGroup>
  );
}
