import { useEffect, useState } from "react";
import { errorText } from "../../api/errors";
import type { Density, Theme } from "../../api/types";
import { useApp } from "../../components/AppContext";
import { Switch } from "../../components/Controls";
import { Icon } from "../../components/Icon";
import { Segmented } from "../../components/Segmented";
import { ErrorState, LoadingState } from "../../components/States";
import { href } from "../../lib/router";
import { useShell } from "../../shell/ShellContext";
import { NotificationsGroup } from "./NotificationsGroup";
import { SettingRow, SettingsGroup } from "./SettingsGroup";
import { UpdatesGroup } from "./UpdatesGroup";

type AutostartState = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; enabled: boolean; busy: boolean };

/** Start at login (PUT /api/autostart): applies at once. */
export function StartAtLogin() {
  const { api, toast } = useApp();
  const [state, setState] = useState<AutostartState>({ status: "loading" });

  useEffect(() => {
    let live = true;
    api.autostart().then(
      (a) => live && setState({ status: "ok", enabled: a.enabled, busy: false }),
      (err: unknown) => live && setState({ status: "error", message: errorText(err) }),
    );
    return () => {
      live = false;
    };
  }, [api]);

  const set = async (enabled: boolean) => {
    if (state.status !== "ok") return;
    setState({ ...state, enabled, busy: true });
    try {
      const a = await api.setAutostart(enabled);
      setState({ status: "ok", enabled: a.enabled, busy: false });
      toast.info(a.enabled ? "Portplane will start when you log in" : "Portplane won't start at login");
    } catch (err) {
      setState({ status: "ok", enabled: !enabled, busy: false });
      toast.error(`Couldn't change start at login: ${errorText(err)}`);
    }
  };

  return (
    <Switch
      label="Start Portplane at login"
      description={
        state.status === "error"
          ? `Not available here: ${state.message}`
          : "Runs in the tray or menu bar from the moment you log in, so the URLs and this window are always there."
      }
      checked={state.status === "ok" && state.enabled}
      disabled={state.status !== "ok"}
      busy={state.status === "loading" || (state.status === "ok" && state.busy)}
      onChange={(v) => void set(v)}
    />
  );
}

const THEME_OPTIONS = [
  { value: "system" as Theme, label: "System", icon: "monitor" as const },
  { value: "light" as Theme, label: "Light", icon: "sun" as const },
  { value: "dark" as Theme, label: "Dark", icon: "moon" as const },
];

const DENSITY_OPTIONS = [
  { value: "comfortable" as Density, label: "Comfortable", icon: "rows" as const },
  { value: "compact" as Density, label: "Compact", icon: "rowsCompact" as const },
];

function Appearance() {
  const { preferences, updatePreferences, reloadPreferences } = useShell();
  if (preferences.status === "loading") return <LoadingState label="Loading your preferences…" />;
  if (preferences.status === "error") return <ErrorState title="Couldn't load your preferences" message={preferences.message} onRetry={reloadPreferences} />;
  const p = preferences.value;
  return (
    <>
      <SettingsGroup title="Appearance">
        <SettingRow label="Theme" description="System follows your computer's light or dark setting.">
          <Segmented label="Theme" value={p.theme} options={THEME_OPTIONS} onChange={(theme) => void updatePreferences((x) => ({ ...x, theme }))} />
        </SettingRow>
        <SettingRow label="Density" description="Compact fits more apps on the screen.">
          <Segmented label="Density" value={p.density} options={DENSITY_OPTIONS} onChange={(density) => void updatePreferences((x) => ({ ...x, density }))} />
        </SettingRow>
      </SettingsGroup>
      <NotificationsGroup prefs={p} />
      <UpdatesGroup prefs={p} />
    </>
  );
}

export function GeneralSection() {
  return (
    <>
      <SettingsGroup title="Startup">
        <StartAtLogin />
      </SettingsGroup>
      <Appearance />
      <SettingsGroup title="Guided setup">
        <SettingRow label="Run setup again" description="Checks your computer, installs what's missing, and walks through the proxy, your folders and your apps again.">
          <a className="btn" href={href({ view: "onboarding", step: "welcome" })}>
            <Icon name="wand" size={14} />
            Run setup again
          </a>
        </SettingRow>
      </SettingsGroup>
    </>
  );
}
