import { useState } from "react";
import { errorText } from "../../api/errors";
import type { Preferences } from "../../api/types";
import { useApp } from "../../components/AppContext";
import { Switch } from "../../components/Controls";
import { Icon, Spinner } from "../../components/Icon";
import { useShell } from "../../shell/ShellContext";
import { SettingsGroup } from "./SettingsGroup";

type Kind = keyof Preferences["notifications"];

const KINDS: Array<{ kind: Kind; label: string; description: string }> = [
  { kind: "failures", label: "An app crashes or a job fails", description: "So you know before you reload the page. Click it to see the app." },
  { kind: "recoveries", label: "A failed app runs again", description: "After a fix, or when dekit restarts it." },
  { kind: "jobs", label: "A job finishes", description: "Installs and other long operations Portplane runs." },
  { kind: "config", label: "A dekit.yaml changes", description: "Open the project to review the change and apply it." },
];

/**
 * Settings → General → Notifications (plan §6.5). Portplane sends them
 * itself, so they work with the window closed; only failures are on at
 * first.
 */
export function NotificationsGroup({ prefs }: { prefs: Preferences }) {
  const { api, toast } = useApp();
  const { updatePreferences } = useShell();
  const [testing, setTesting] = useState(false);
  const test = async () => {
    setTesting(true);
    try {
      await api.testNotification();
      toast.info("Sent a test notification");
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setTesting(false);
    }
  };
  return (
    <SettingsGroup>
      {KINDS.map((k) => (
        <Switch
          key={k.kind}
          label={k.label}
          description={k.description}
          checked={prefs.notifications[k.kind]}
          onChange={(on) => void updatePreferences((p) => ({ ...p, notifications: { ...p.notifications, [k.kind]: on } }))}
        />
      ))}
      <div className="sgroup-foot">
        <button type="button" className="btn btn-ghost" aria-busy={testing || undefined} aria-disabled={testing || undefined} onClick={() => !testing && void test()}>
          {testing ? <Spinner /> : <Icon name="bell" size={14} />}
          Send a test notification
        </button>
      </div>
    </SettingsGroup>
  );
}
