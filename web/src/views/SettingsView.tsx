import type { ComponentType, ReactNode } from "react";
import { ViewHeader } from "../components/ViewHeader";
import type { SettingsSection } from "../lib/router";
import { SETTINGS_LABELS } from "../shell/nav";
import { useShell } from "../shell/ShellContext";
import { AdvancedSection } from "./settings/AdvancedSection";
import { FoldersSection } from "./settings/FoldersSection";
import { GeneralSection, NotificationsSection, UpdatesSection } from "./settings/GeneralSection";
import "./SettingsView.css";

/** One component per page, each in settings/, so they can change independently. */
const SECTIONS: Record<SettingsSection, { Section: ComponentType; description?: ReactNode }> = {
  general: { Section: GeneralSection, description: "How Portplane starts and looks." },
  notifications: { Section: NotificationsSection, description: "System notifications, also while the window is closed: failures only, unless you turn on more." },
  updates: { Section: UpdatesSection, description: "Portplane, dekit and portless each have their own releases. Portplane reads the latest versions from GitHub and npm when you ask, or once a day; it sends nothing about you and installs nothing until you click." },
  folders: { Section: FoldersSection, description: "The folders where your code lives. Portplane reads the dekit.yaml files in them and marks open ports that serve from inside them; Set up finds the apps in a folder and writes that config for you." },
  advanced: { Section: AdvancedSection },
};

/**
 * Settings › Portplane (ADR-0028): one page per entry of Settings' sidebar,
 * which replaces the main one while Settings is open.
 */
export function SettingsView() {
  const { route } = useShell();
  const section = route.view === "settings" ? route.section : "general";
  const { Section, description } = SECTIONS[section];
  return (
    <>
      <ViewHeader section="Settings" title={SETTINGS_LABELS[section]} description={description} />
      <div className="settings-page">
        <Section />
      </div>
    </>
  );
}
