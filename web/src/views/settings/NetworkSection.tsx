import { SettingsGroup } from "./SettingsGroup";

/** Privacy and network (plan §6.2). */
export function NetworkSection() {
  return (
    <SettingsGroup title="Network">
      <p className="muted">
        Portplane opens no network port: this window talks to it on this computer only, and other machines are reached over your own
        SSH. Nothing is sent anywhere else. Options for sharing apps on your network come in a later version.
      </p>
    </SettingsGroup>
  );
}
