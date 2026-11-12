import { useApp } from "../../components/AppContext";
import { osLabel } from "../../lib/machines";
import { SettingRow, SettingsGroup } from "./SettingsGroup";

/** About this build; paths, debugging and diagnostics come later (plan §6.2). */
export function AdvancedSection() {
  const { info } = useApp();
  return (
    <>
      <SettingsGroup title="About">
        <SettingRow label="Version">
          <span className="mono">{info ? info.version : "…"}</span>
        </SettingRow>
        {info && (
          <SettingRow label="System">
            {osLabel(info.os)} {info.arch}
          </SettingRow>
        )}
        {info?.url && (
          <SettingRow label="This window's address">
            <a className="addr" href={info.url}>
              {info.url.replace(/^https?:\/\//, "")}
            </a>
          </SettingRow>
        )}
      </SettingsGroup>
      <SettingsGroup title="Diagnostics">
        <p className="muted">Exporting a diagnostic report (versions, state, no secrets) comes in a later version.</p>
      </SettingsGroup>
    </>
  );
}
