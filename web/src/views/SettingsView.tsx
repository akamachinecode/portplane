import type { ComponentType } from "react";
import { SubNav } from "../components/SubNav";
import { ViewHeader } from "../components/ViewHeader";
import type { IconName } from "../components/Icon";
import { SETTINGS_SECTIONS, type SettingsSection } from "../lib/router";
import { SETTINGS_LABELS } from "../shell/nav";
import { useShell } from "../shell/ShellContext";
import { AdvancedSection } from "./settings/AdvancedSection";
import { FoldersSection } from "./settings/FoldersSection";
import { GeneralSection } from "./settings/GeneralSection";
import { NetworkSection } from "./settings/NetworkSection";
import { ToolsSection } from "./settings/ToolsSection";
import "./SettingsView.css";

/** One component per section, each in settings/, so they can change independently. */
const SECTIONS: Record<SettingsSection, { icon: IconName; Section: ComponentType }> = {
  general: { icon: "gear", Section: GeneralSection },
  folders: { icon: "folder", Section: FoldersSection },
  tools: { icon: "terminal", Section: ToolsSection },
  network: { icon: "globe", Section: NetworkSection },
  advanced: { icon: "wand", Section: AdvancedSection },
};

export function SettingsView() {
  const { route } = useShell();
  const section = route.view === "settings" ? route.section : "general";
  const { Section } = SECTIONS[section];
  return (
    <>
      <ViewHeader title="Settings" />
      <div className="with-subnav">
        <SubNav
          label="Settings sections"
          items={SETTINGS_SECTIONS.map((s) => ({ route: { view: "settings", section: s }, label: SETTINGS_LABELS[s], icon: SECTIONS[s].icon, current: s === section }))}
        />
        <div className="with-subnav-main">
          <Section />
        </div>
      </div>
    </>
  );
}
