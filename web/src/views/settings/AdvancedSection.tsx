import { useApp } from "../../components/AppContext";
import { osLabel } from "../../lib/machines";
import { DIAGNOSTICS_DESCRIPTION, ExportDiagnosticsButton } from "../health/ExportDiagnostics";
import { SettingRow, SettingsGroup } from "./SettingsGroup";

/** About this build, and the diagnostic report (plan §6.2). */
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
        <SettingRow label="Diagnostic report" description={DIAGNOSTICS_DESCRIPTION}>
          <ExportDiagnosticsButton />
        </SettingRow>
      </SettingsGroup>
    </>
  );
}
